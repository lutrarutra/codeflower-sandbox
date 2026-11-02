import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgents, loadRegistry } from '../src/agents.js';

// OpenCode with its home in a folder of the test's, as the app sets it.
async function setup(t, launch) {
  const home = await mkdtemp(join(tmpdir(), 'codeflower-opencode-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agents = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'opencode');
  const { opencode } = createAgents({
    nodePath: 'node',
    modules: '/opt/codeflower/runtime/node_modules',
    ...(launch ? { launch: { opencode: launch } } : {}),
    environment: { OPENCODE_CONFIG_DIR: home },
    agents
  });
  return { opencode, home };
}

test('runs the binary the image links, or a test script with node, serving on a port of its own', async (t) => {
  const binary = await (await setup(t)).opencode.command();
  assert.deepEqual(binary.slice(0, 5), ['/opt/codeflower/runtime/node_modules/.bin/opencode', 'acp', '--hostname', '127.0.0.1', '--port']);
  assert.match(binary[5], /^\d+$/);
  const script = await (await setup(t, '/tmp/fake-agent.js')).opencode.command();
  assert.deepEqual(script.slice(0, 3), ['node', '/tmp/fake-agent.js', 'acp']);
});

test("opens its terminal UI on a chat, attached to the server it runs, with that server's password", async (t) => {
  const { opencode } = await setup(t);
  await assert.rejects(opencode.tuiCommand({ sessionId: 'ses_1', cwd: '/w' }), /not running/);
  const command = await opencode.command();
  const port = command.at(-1);
  assert.deepEqual(await opencode.tuiCommand({ sessionId: 'ses_1', cwd: '/codeflower-state/workspace' }), [
    '/opt/codeflower/runtime/node_modules/.bin/opencode',
    'attach',
    `http://127.0.0.1:${port}`,
    '--session',
    'ses_1',
    '--dir',
    '/codeflower-state/workspace'
  ]);
  assert.match(opencode.env.OPENCODE_SERVER_PASSWORD, /^[\w-]{32}$/);
  // A new password with every start.
  const before = opencode.env.OPENCODE_SERVER_PASSWORD;
  await opencode.command();
  assert.notEqual(opencode.env.OPENCODE_SERVER_PASSWORD, before);
});

test('keeps its database in its home and turns off what calls out on its own', async (t) => {
  const { opencode, home } = await setup(t);
  assert.equal(opencode.env.OPENCODE_DB, join(home, 'opencode.db'));
  assert.equal(opencode.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(opencode.env.OPENCODE_DISABLE_FREE_MODELS, '1');
});

test('is signed in with a stored credential', async (t) => {
  const { opencode, home } = await setup(t);
  assert.equal(await opencode.signedIn(), false);

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(home, 'opencode.db'));
  // Before opencode created its tables.
  assert.equal(await opencode.signedIn(), false);
  database.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, label TEXT NOT NULL, value TEXT NOT NULL)');
  assert.equal(await opencode.signedIn(), false);
  database.prepare('INSERT INTO credential VALUES (?, ?, ?)').run('c1', 'OpenAI', '{}');
  database.close();
  assert.equal(await opencode.signedIn(), true);
});

test('is signed in with a provider of its own in the config, not with the config written once', async (t) => {
  const { opencode, home } = await setup(t);
  const [{ descriptor }] = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'opencode');
  await writeFile(join(home, 'opencode.jsonc'), descriptor.files['opencode.jsonc']);
  assert.equal(await opencode.signedIn(), false);

  await writeFile(join(home, 'opencode.json'), JSON.stringify({ provider: { vllm: { options: { baseURL: 'http://gpu01:8000/v1' } } } }));
  assert.equal(await opencode.signedIn(), true);
});

test("says why it does not use the app config's key", async (t) => {
  const { opencode } = await setup(t);
  assert.match(await opencode.provideKey('sk-test'), /provider/);
});

test('never shares sessions on its own', async () => {
  const [{ descriptor }] = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'opencode');
  assert.match(descriptor.files['opencode.jsonc'], /"share": "disabled"/);
});
