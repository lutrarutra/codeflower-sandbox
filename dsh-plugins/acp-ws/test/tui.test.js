import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgents, loadRegistry } from '../src/agents.js';
import { parseResume, runTui } from '../src/tui.js';

// A terminal UI that writes what it was given to a file, and exits with 7.
const report = (file) => [
  process.execPath,
  '-e',
  `require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), token: process.env.CODEFLOWER_TOKEN ?? null, updater: process.env.DISABLE_AUTOUPDATER ?? null })); process.exit(7)`
];

test("runs the agent's terminal UI alone, as the chats handed over get it, and ends with it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-tui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, 'out.json');
  const agents = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'claude');
  const { claude } = createAgents({ nodePath: 'node', modules: '/opt/codeflower/runtime/node_modules', environment: { CLAUDE_CONFIG_DIR: directory }, agents });
  const given = [];
  const agent = {
    ...claude,
    soloCommand: async (options) => {
      given.push(options);
      return [...report(out), '--', ...(await claude.soloCommand(options))];
    }
  };
  const code = await runTui({
    agentName: 'claude',
    agent,
    mcpServers: [{ name: 'notes', command: 'notes-mcp', args: ['--x'], env: [{ name: 'K', value: 'v' }] }],
    resume: parseResume('last'),
    workspace: directory,
    environment: { PATH: process.env.PATH, CODEFLOWER_TOKEN: 'secret' }
  });
  assert.equal(code, 7);
  const ran = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(ran.cwd.endsWith(directory.split('/').at(-1)), true);
  assert.equal(ran.token, null);
  assert.equal(ran.updater, '1');
  const command = ran.argv.slice(ran.argv.indexOf('--') + 1);
  assert.equal(command[0], '/opt/codeflower/agents/claude/claude');
  assert.deepEqual(JSON.parse(command[command.indexOf('--settings') + 1]), { plansDirectory: 'plans' });
  assert.equal(command.at(-1), '--continue');
  const mcp = JSON.parse(await readFile(given[0].mcpConfig, 'utf8'));
  assert.deepEqual(mcp, { mcpServers: { notes: { type: 'stdio', command: 'notes-mcp', args: ['--x'], env: { K: 'v' } } } });
  // Its first-run screens were answered for the workspace.
  const settings = JSON.parse(await readFile(join(directory, '.claude.json'), 'utf8'));
  assert.equal(settings.projects[directory].hasTrustDialogAccepted, true);
});

test('opens a new chat, the last, the list, or one by id, in each agent', async () => {
  const registry = await loadRegistry();
  const agents = createAgents({ nodePath: 'node', modules: '/m', environment: {}, agents: registry });
  assert.equal(parseResume(''), undefined);
  assert.equal(parseResume('new'), undefined);
  assert.deepEqual((await agents.claude.soloCommand({ resume: 'pick', settings: {} })).slice(-1), ['--resume']);
  assert.deepEqual((await agents.claude.soloCommand({ resume: 'abc', settings: {} })).slice(-2), ['--resume', 'abc']);
  assert.deepEqual((await agents.codex.soloCommand({})).slice(2), ['-c', 'check_for_update_on_startup=false']);
  assert.deepEqual((await agents.codex.soloCommand({ resume: 'last' })).slice(-2), ['resume', '--last']);
  assert.deepEqual((await agents.codex.soloCommand({ resume: 't1' })).slice(-2), ['resume', 't1']);
  assert.deepEqual(await agents.opencode.soloCommand({ resume: 'last' }), ['/m/.bin/opencode', '--continue']);
  assert.deepEqual(await agents.opencode.soloCommand({ resume: 'pick' }), ['/m/.bin/opencode']);
  assert.deepEqual(await agents.opencode.soloCommand({ resume: 'ses_1' }), ['/m/.bin/opencode', '--session', 'ses_1']);
  assert.equal(agents.dsh.soloCommand, undefined);
});

test('says how to open the chat again with codeflower, once the terminal UI ends', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-tui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const said = [];
  const asked = [];
  const agent = {
    soloCommand: async () => [process.execPath, '-e', 'process.exit(0)'],
    lastSession: async (options) => (asked.push(options), 'abc-1')
  };
  const run = (environment) => runTui({ agentName: 'x', agent, workspace: directory, environment, say: (text) => said.push(text) });
  assert.equal(await run({ PATH: process.env.PATH }), 0);
  assert.deepEqual(said, []);
  assert.equal(await run({ PATH: process.env.PATH, CODEFLOWER_TUI_AGAIN: 'codeflower --agent x tui --resume=' }), 0);
  assert.equal(asked[0].cwd, directory);
  assert.match(said.join(''), /\ncodeflower --agent x tui --resume=abc-1\n/);
});

test("finds the chat each agent's terminal UI wrote last", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-tui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = '/codeflower-state/workspace';
  const old = new Date(Date.now() - 60_000);
  const since = Date.now() - 10_000;
  const registry = await loadRegistry();
  const home = (name) => join(directory, name);
  const agents = createAgents({
    nodePath: 'node',
    modules: '/m',
    environment: { CLAUDE_CONFIG_DIR: home('claude'), CODEX_HOME: home('codex'), OPENCODE_CONFIG_DIR: home('opencode') },
    agents: registry
  });

  const transcripts = join(home('claude'), 'projects', '-codeflower-state-workspace');
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(transcripts, 'old-1.jsonl'), '{}\n');
  await utimes(join(transcripts, 'old-1.jsonl'), old, old);
  assert.equal(await agents.claude.lastSession({ cwd, since }), undefined);
  await writeFile(join(transcripts, 'new-2.jsonl'), '{}\n');
  assert.equal(await agents.claude.lastSession({ cwd, since }), 'new-2');

  const day = join(home('codex'), 'sessions', '2026', '11', '02');
  await mkdir(day, { recursive: true });
  const id = '019a4b2c-1d2e-7f30-8a41-b2c3d4e5f607';
  await writeFile(join(day, `rollout-2026-11-02T20-29-00-${id}.jsonl`), '{}\n');
  assert.equal(await agents.codex.lastSession({ cwd, since }), id);

  if (agents.opencode.lastSession && (await import('node:sqlite').catch(() => undefined))) {
    const { DatabaseSync } = await import('node:sqlite');
    await mkdir(home('opencode'), { recursive: true });
    const database = new DatabaseSync(join(home('opencode'), 'opencode.db'));
    database.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, time_updated integer NOT NULL)');
    const add = database.prepare('INSERT INTO session VALUES (?, ?, ?, ?)');
    add.run('ses_old', null, cwd, since - 1);
    add.run('ses_main', null, cwd, since + 1);
    add.run('ses_sub', 'ses_main', cwd, since + 2);
    add.run('ses_other', null, '/elsewhere', since + 3);
    database.close();
    assert.equal(await agents.opencode.lastSession({ cwd, since }), 'ses_main');
  }
});
