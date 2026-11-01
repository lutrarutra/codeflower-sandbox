import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createAgents, loadRegistry } from '../src/agents.js';
import { createPlugins, parsePlugins, parseSource, pluginId, runFetch } from '../src/plugins.js';

const fakeClaude = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url));

async function temporary(t, prefix = 'codeflower-plugins-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// An adapter that records what it was asked and fetches everything but `bad`.
function recordingHooks() {
  const calls = [];
  return {
    calls,
    async fetch(entries, dir) {
      calls.push(['fetch', entries.map((entry) => entry.id), dir]);
      return entries.map((entry) => (entry.source.includes('bad') ? { id: entry.id, error: 'not found' } : { id: entry.id, version: '1.0.0' }));
    },
    async activate(entries, dir) {
      calls.push(['activate', entries.map((entry) => entry.id), dir]);
      return { env: { PLUGIN_COUNT: String(entries.length) } };
    },
    async list() {
      return [{ name: 'own@somewhere', enabled: true, origin: 'native' }];
    }
  };
}

test('parses and normalises every kind of source', () => {
  assert.deepEqual(parseSource('marketplace:commit-commands@claude-plugins-official'), {
    kind: 'marketplace',
    source: 'marketplace:commit-commands@claude-plugins-official',
    name: 'commit-commands',
    catalog: 'claude-plugins-official'
  });
  assert.equal(parseSource(' github:My-Org/My-Plugin.git#v1.2.0 ').source, 'github:my-org/my-plugin#v1.2.0');
  assert.equal(parseSource('git:https://example.org/x.git#main').ref, 'main');
  assert.equal(parseSource('npm:@scope/pkg@1.0.4').package, '@scope/pkg');
  assert.equal(parseSource('url:https://example.org/p.zip#sha256=' + 'A'.repeat(64)).sha256, 'a'.repeat(64));
  assert.equal(parseSource('path:/data/plugins/mine/').source, 'path:/data/plugins/mine');
  assert.equal(pluginId('claude', 'github:Org/Repo'), 'claude:github:org/repo');
  for (const bad of [
    'commit-commands',
    'marketplace:commit-commands',
    'github:org',
    'github:org/repo#../x',
    'git:git://example.org/x',
    'npm:pkg',
    'url:http://example.org/p.zip',
    'url:https://example.org/p.exe',
    'path:relative/folder',
    'ftp:x'
  ]) {
    assert.throws(() => parseSource(bad), Error, bad);
  }
});

test("reads the config's plugins by agent", () => {
  assert.deepEqual(parsePlugins(''), {});
  assert.deepEqual(parsePlugins(JSON.stringify({ claude: [{ source: 'github:A/B' }, { source: 'path:/x', enabled: false }] })), {
    claude: [
      { source: 'github:a/b', enabled: true },
      { source: 'path:/x', enabled: false }
    ]
  });
  assert.throws(() => parsePlugins('[]'), /JSON object/);
  assert.throws(() => parsePlugins(JSON.stringify({ claude: [{ source: 'nope' }] })), /plugin source starts with/);
});

test("refuses kinds the agent does not take, also in the app's config", async (t) => {
  const directory = await temporary(t);
  const descriptor = { kinds: ['github'] };
  assert.throws(
    () => createPlugins({ agentName: 'claude', hooks: recordingHooks(), descriptor, directory, configured: [{ source: 'npm:x@1', enabled: true }] }),
    /npm:/
  );
  const plugins = createPlugins({ agentName: 'claude', hooks: recordingHooks(), descriptor, directory });
  await assert.rejects(plugins.add('path:/x'), /github:, not path:/);
  await assert.rejects(plugins.add('nonsense'), /plugin source starts with/);
});

test('merges config and project entries, fetches what is missing and activates what is fetched', async (t) => {
  const directory = await temporary(t);
  const hooks = recordingHooks();
  const changes = [];
  const plugins = createPlugins({
    agentName: 'claude',
    hooks,
    descriptor: { kinds: ['github', 'path'] },
    directory,
    configured: [{ source: 'github:org/from-config', enabled: true }],
    canFetch: false
  });
  plugins.onChange(() => changes.push(Date.now()));

  assert.deepEqual(await plugins.add('github:org/mine'), { id: 'claude:github:org/mine', pendingFetch: true });
  await plugins.add('github:org/bad');
  let listed = await plugins.list();
  assert.deepEqual(
    listed.entries.map(({ id, origin, state }) => [id, origin, state]),
    [
      ['claude:github:org/from-config', 'config', 'pending'],
      ['claude:github:org/mine', 'project', 'pending'],
      ['claude:github:org/bad', 'project', 'pending']
    ]
  );
  assert.deepEqual(listed.native, [{ name: 'own@somewhere', enabled: true, origin: 'native' }]);
  assert.equal(listed.canFetch, false);
  assert.equal(listed.restartPending, false);

  // The fetch run.
  const lines = [];
  assert.equal(await runFetch(plugins, { write: (line) => lines.push(JSON.parse(line)) }), 1);
  assert.deepEqual(lines.at(-1), { done: true, errors: 1 });
  assert.deepEqual(hooks.calls[0], ['fetch', ['claude:github:org/from-config', 'claude:github:org/mine', 'claude:github:org/bad'], join(directory, 'claude')]);
  listed = await plugins.list();
  assert.deepEqual(listed.entries.map(({ state }) => state), ['active', 'active', 'error']);
  assert.equal(listed.entries[2].error, 'not found');

  // Only what is fetched without error is turned on, and the agent gets the adapter's env.
  assert.deepEqual(await plugins.activate(), { PLUGIN_COUNT: '2' });
  assert.deepEqual(hooks.calls[1][1], ['claude:github:org/from-config', 'claude:github:org/mine']);
  assert.equal((await plugins.list()).restartPending, false);

  // A config entry is switched off for the project, not removed.
  await assert.rejects(plugins.remove('claude:github:org/from-config'), /switch it off/);
  await plugins.setEnabled('claude:github:org/from-config', false);
  listed = await plugins.list();
  assert.equal(listed.entries[0].state, 'disabled');
  assert.equal(listed.restartPending, true);
  const project = JSON.parse(await readFile(join(directory, 'plugins.json'), 'utf8'));
  assert.deepEqual(project.plugins.claude[2], { source: 'github:org/from-config', enabled: false });

  // Switched back on, it needs no project entry.
  await plugins.setEnabled('claude:github:org/from-config', true);
  assert.equal(JSON.parse(await readFile(join(directory, 'plugins.json'), 'utf8')).plugins.claude.length, 2);

  await plugins.remove('claude:github:org/bad');
  assert.deepEqual((await plugins.list()).entries.map(({ id }) => id), ['claude:github:org/from-config', 'claude:github:org/mine']);
  assert.ok(changes.length >= 5);

  // A second fetch has nothing left to do.
  assert.deepEqual(await plugins.fetch(), { plugins: [], catalogs: [] });
});

test('fetches at once where the sandbox has the network', async (t) => {
  const directory = await temporary(t);
  const hooks = recordingHooks();
  const plugins = createPlugins({ agentName: 'claude', hooks, descriptor: { kinds: ['github'] }, directory, canFetch: true });
  assert.deepEqual(await plugins.add('github:org/mine'), { id: 'claude:github:org/mine', pendingFetch: false });
  const deadline = Date.now() + 5000;
  while ((await plugins.list()).entries[0].state !== 'active' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await plugins.list()).entries[0].version, '1.0.0');
});

test('an agent without the adapter has no plugins', async (t) => {
  const plugins = createPlugins({ agentName: 'pi', directory: await temporary(t) });
  assert.deepEqual(await plugins.list(), { available: false });
  assert.deepEqual(await plugins.activate(), {});
  await assert.rejects(plugins.add('github:a/b'), /no plugins/);
});

// The Claude adapter, with the fake CLI and an official marketplace on disk.
async function claudeSetup(t) {
  const directory = await temporary(t, 'codeflower-claude-plugins-');
  const home = join(directory, 'harness', 'claude');
  const marketplaces = join(directory, 'remote');
  const official = join(marketplaces, 'anthropics--claude-plugins-official');
  await mkdir(join(official, '.claude-plugin'), { recursive: true });
  await mkdir(join(official, 'plugins', 'commit-commands', 'commands'), { recursive: true });
  await writeFile(join(official, 'plugins', 'commit-commands', 'commands', 'commit.md'), 'Commit.');
  await mkdir(join(official, 'plugins', 'hooky', 'hooks'), { recursive: true });
  await writeFile(join(official, 'plugins', 'hooky', 'hooks', 'hooks.json'), '{}');
  await writeFile(
    join(official, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'claude-plugins-official',
      plugins: [
        { name: 'commit-commands', description: 'Commits', category: 'development', version: '1.0.1', source: './plugins/commit-commands' },
        { name: 'hooky', description: 'Has hooks', source: './plugins/hooky' },
        { name: 'elsewhere', description: 'Outside', source: { source: 'github', repo: 'x/y' } }
      ]
    })
  );
  const mine = join(directory, 'my-plugin');
  await mkdir(join(mine, '.claude-plugin'), { recursive: true });
  await writeFile(join(mine, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Hello-Plug' }));
  const log = join(directory, 'claude.log');
  const environment = { FAKE_CLAUDE_MARKETPLACES: marketplaces, FAKE_CLAUDE_LOG: log, PATH: process.env.PATH, ANTHROPIC_API_KEY: 'secret' };
  const registry = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'claude');
  const agents = registry.map(({ descriptor, hooks }) => ({
    descriptor: { ...descriptor, env: { ...descriptor.env, CLAUDE_CODE_EXECUTABLE: fakeClaude } },
    hooks
  }));
  const { claude } = createAgents({ nodePath: 'node', environment: { ...environment, CLAUDE_CONFIG_DIR: home }, agents });
  const plugins = createPlugins({
    agentName: 'claude',
    hooks: claude.plugins,
    descriptor: claude.pluginsDescriptor,
    directory: join(directory, 'plugins'),
    canFetch: false
  });
  return { directory, home, plugins, mine, log };
}

test('Claude Code: fetches into a seed with its own installer and turns on only its own plugins', async (t) => {
  const { directory, home, plugins, mine, log } = await claudeSetup(t);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'theirs@somewhere': true } }));

  await plugins.add('marketplace:commit-commands@claude-plugins-official');
  await plugins.add(`path:${mine}`);
  await plugins.add('marketplace:missing@claude-plugins-official');
  const { plugins: results, catalogs } = await plugins.fetch();
  assert.deepEqual(catalogs, [{ source: 'github:anthropics/claude-plugins-official', name: 'claude-plugins-official' }]);
  assert.deepEqual(results.slice(0, 2), [
    { id: 'claude:marketplace:commit-commands@claude-plugins-official', version: '1.0.1' },
    { id: `claude:path:${mine}`, version: '1.0.0' }
  ]);
  assert.match(results[2].error, /not found/);

  // Never with the user's config or keys.
  const runs = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const seed = join(directory, 'plugins', 'claude', 'seed');
  assert.ok(runs.every((run) => run.config === join(directory, 'plugins', 'claude', 'fetch-config') && run.cache === seed));

  // A path: plugin is copied into code flower's own marketplace in the seed, under its own name.
  const local = JSON.parse(await readFile(join(seed, 'marketplaces', 'codeflower-local', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.deepEqual(local.plugins, [{ name: 'hello-plug', source: './plugins/hello-plug' }]);

  assert.deepEqual(await plugins.activate(), { CLAUDE_CODE_PLUGIN_SEED_DIR: seed });
  let settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.enabledPlugins, {
    'theirs@somewhere': true,
    'commit-commands@claude-plugins-official': true,
    'hello-plug@codeflower-local': true
  });

  // Switched off: its key goes, the user's own stays.
  await plugins.setEnabled('claude:marketplace:commit-commands@claude-plugins-official', false);
  await plugins.activate();
  settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.enabledPlugins, { 'theirs@somewhere': true, 'hello-plug@codeflower-local': true });
});

test('Claude Code: browses a fetched marketplace and says what in-repository plugins add', async (t) => {
  const { plugins } = await claudeSetup(t);
  assert.deepEqual(await plugins.catalog('claude-plugins-official'), { name: 'claude-plugins-official', fetched: false, plugins: [] });
  await plugins.fetch();
  const { plugins: items } = await plugins.catalog('claude-plugins-official');
  assert.deepEqual(items[0], {
    name: 'commit-commands',
    description: 'Commits',
    category: 'development',
    version: '1.0.1',
    source: 'marketplace:commit-commands@claude-plugins-official',
    contents: { commands: 1, skills: 0, agents: 0, hooks: false, mcpServers: false, lspServers: false }
  });
  assert.equal(items[1].contents.hooks, true);
  assert.equal(items[2].contents, undefined);
  await assert.rejects(plugins.catalog('unknown'), /No catalog/);
  const listed = await plugins.list();
  assert.deepEqual(listed.catalogs, [
    { name: 'claude-plugins-official', source: 'github:anthropics/claude-plugins-official', origin: 'agent', fetched: true }
  ]);
});
