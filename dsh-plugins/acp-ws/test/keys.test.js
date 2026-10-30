import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CREDENTIAL_VARIABLES, PROVIDED_KEY_VARIABLE, createAgents } from '../src/agents.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = {
    DSH_HOME: join(directory, 'dsh-home'),
    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEX_HOME: join(directory, 'codex')
  };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(environment.CODEX_HOME, { recursive: true });
  const agents = createAgents({ nodePath: 'node', dshBin: 'x', claudeAcpBin: 'x', codexAcpBin: 'x', environment });
  return { agents, environment };
}

test('the key from the app config is never passed on to an agent', () => {
  assert.ok(CREDENTIAL_VARIABLES.includes(PROVIDED_KEY_VARIABLE));
});

test('stores a configured key in dsh .env', async (t) => {
  const { agents, environment } = await setup(t);
  assert.equal(await agents.dsh.signedIn(), false);
  await agents.dsh.provideKey('sk-dsh');
  assert.match(await readFile(join(environment.DSH_HOME, '.env'), 'utf8'), /^DEEPSEEK_API_KEY=sk-dsh$/m);
  assert.equal(await agents.dsh.signedIn(), true);
});

test("stores a configured key in Claude Code's settings and keeps its other settings", async (t) => {
  const { agents, environment } = await setup(t);
  const file = join(environment.CLAUDE_CONFIG_DIR, 'settings.json');
  await writeFile(file, JSON.stringify({ model: 'opus', env: { OTHER: '1' } }));
  assert.equal(await agents.claude.provideKey('sk-ant'), undefined);
  const settings = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(settings, { model: 'opus', env: { OTHER: '1', ANTHROPIC_API_KEY: 'sk-ant' } });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await agents.claude.authKind(), 'api_key');
});

test("creates Claude Code's settings when they do not exist", async (t) => {
  const { agents, environment } = await setup(t);
  await agents.claude.provideKey('sk-ant');
  const settings = JSON.parse(await readFile(join(environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { env: { ANTHROPIC_API_KEY: 'sk-ant' } });
});

test('keeps an existing Claude Code subscription login', async (t) => {
  const { agents, environment } = await setup(t);
  await writeFile(join(environment.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  assert.match(await agents.claude.provideKey('sk-ant'), /subscription/);
  await assert.rejects(readFile(join(environment.CLAUDE_CONFIG_DIR, 'settings.json')), { code: 'ENOENT' });
});

test("stores a configured key in Codex's auth.json, replacing an older key but not a subscription", async (t) => {
  const { agents, environment } = await setup(t);
  const file = join(environment.CODEX_HOME, 'auth.json');
  await agents.codex.provideKey('sk-old');
  await agents.codex.provideKey('sk-new');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-new' });
  assert.equal(await agents.codex.authKind(), 'api_key');

  await writeFile(file, JSON.stringify({ tokens: { access_token: 'a' } }));
  assert.match(await agents.codex.provideKey('sk-other'), /subscription/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens.access_token, 'a');
});

for (const [agentName, homeName, fileName] of [
  ['claude', 'CLAUDE_CONFIG_DIR', 'settings.json'],
  ['codex', 'CODEX_HOME', 'auth.json']
]) {
  test(`${agentName} leaves invalid credential files unchanged`, async (t) => {
    const { agents, environment } = await setup(t);
    const file = join(environment[homeName], fileName);
    for (const [content, error] of [
      ['{"existing":"secret",', /Invalid JSON/],
      ['', /Invalid JSON/],
      ['null', /Expected a JSON object/],
      ['[]', /Expected a JSON object/],
      ['"string"', /Expected a JSON object/]
    ]) {
      await writeFile(file, content);
      await assert.rejects(agents[agentName].provideKey('test-key'), error);
      assert.equal(await readFile(file, 'utf8'), content);
    }
  });

  test(`${agentName} leaves unreadable credential files unchanged`, async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('file permissions cannot reliably deny reads here');
      return;
    }
    const { agents, environment } = await setup(t);
    const file = join(environment[homeName], fileName);
    const content = '{"existing":"value"}';
    await writeFile(file, content);
    await chmod(file, 0o000);
    try {
      await assert.rejects(agents[agentName].provideKey('test-key'), { code: 'EACCES' });
    } finally {
      await chmod(file, 0o600);
    }
    assert.equal(await readFile(file, 'utf8'), content);
  });

  test(`${agentName} stops worker startup when key provisioning fails`, async (t) => {
    const { environment } = await setup(t);
    const file = join(environment[homeName], fileName);
    const content = '{"existing":"secret",';
    await writeFile(file, content);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
      env: {
        CODEFLOWER_AGENT: agentName,
        CODEFLOWER_API_KEY: 'test-key',
        [homeName]: environment[homeName]
      },
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Could not store the API key from the app's config: Invalid JSON/);
    assert.doesNotMatch(result.stderr, /test-key|existing":"secret|worker ready/);
    assert.equal(await readFile(file, 'utf8'), content);
  });
}

test("Claude Code's settings keep an invalid env value unchanged", async (t) => {
  const { agents, environment } = await setup(t);
  const file = join(environment.CLAUDE_CONFIG_DIR, 'settings.json');
  for (const env of [null, [], 'invalid', 1]) {
    const content = JSON.stringify({ model: 'opus', env });
    await writeFile(file, content);
    await assert.rejects(agents.claude.provideKey('test-key'), /Expected env to be a JSON object/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});
