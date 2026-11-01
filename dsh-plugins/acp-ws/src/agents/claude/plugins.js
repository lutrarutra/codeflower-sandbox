// Claude Code's plugins (docs/plugins.md). The fetch runs Claude Code's own
// installer with a config folder of its own and the plugin cache at
// plugins/claude/seed, so it never touches the user's settings. The agent then
// reads that folder as a seed (CLAUDE_CODE_PLUGIN_SEED_DIR): read-only, offline
// and never updated by itself. A seeded plugin loads only while
// `enabledPlugins` in its settings.json turns it on, so activate() writes those
// keys, and only those it wrote before.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseSource } from '../../plugins.js';
import { exists, readJson, writePrivate } from '../support.js';

// The marketplace code flower writes for plugins that come without one.
export const LOCAL_CATALOG = 'codeflower-local';
const RUN_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 30_000;
// How long the agent's own plugins, which need a run of the CLI, are reused.
const NATIVE_CACHE_MS = 15_000;
const SAFE_NAME = /[^a-z0-9-]+/g;

const seedOf = (dir) => join(dir, 'seed');

// The plugin's name in the local marketplace: its own, else its folder's or repository's.
function localName(entry) {
  const last =
    entry.kind === 'github'
      ? entry.repository.split('/')[1]
      : basename((entry.url ?? entry.path ?? '').replace(/[#?].*$/, '').replace(/\/+$/, '').replace(/\.git$/, ''));
  return last.toLowerCase().replace(SAFE_NAME, '-').replace(/^-+|-+$/g, '') || 'plugin';
}

// Where Claude Code's marketplace commands take a source from.
function claudeSource(parsed) {
  if (parsed.kind === 'github') return parsed.repository;
  if (parsed.kind === 'git' || parsed.kind === 'url') return parsed.url;
  return parsed.path;
}

function sameSource(marketplace, parsed) {
  if (parsed.kind === 'github') return marketplace.repo?.toLowerCase() === parsed.repository;
  if (parsed.kind === 'path') return marketplace.path === parsed.path;
  return marketplace.url === parsed.url;
}

// The last JSON line of a command's output, as Claude Code's --json prints it.
function lastJson(text) {
  for (const line of text.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return undefined;
}

async function count(folder, test) {
  try {
    return (await readdir(folder, { withFileTypes: true })).filter(test).length;
  } catch {
    return 0;
  }
}

/** What a plugin adds, from its folder and its manifest or catalog entry. */
export async function describePlugin(folder, manifest = {}) {
  const fromFolder = folder
    ? {
        commands: await count(join(folder, 'commands'), (entry) => entry.isFile() && entry.name.endsWith('.md')),
        skills: await count(join(folder, 'skills'), (entry) => entry.isDirectory()),
        agents: await count(join(folder, 'agents'), (entry) => entry.isFile() && entry.name.endsWith('.md')),
        hooks: await exists(join(folder, 'hooks', 'hooks.json')),
        mcpServers: await exists(join(folder, '.mcp.json')),
        lspServers: await exists(join(folder, '.lsp.json'))
      }
    : {};
  const counted = (value) => (Array.isArray(value) ? value.length : value ? 1 : 0);
  return {
    commands: (fromFolder.commands ?? 0) + counted(manifest.commands),
    skills: (fromFolder.skills ?? 0) + counted(manifest.skills),
    agents: (fromFolder.agents ?? 0) + counted(manifest.agents),
    hooks: Boolean(fromFolder.hooks || manifest.hooks),
    mcpServers: Boolean(fromFolder.mcpServers || manifest.mcpServers),
    lspServers: Boolean(fromFolder.lspServers || manifest.lspServers)
  };
}

export function claudePlugins({ descriptor, home, environment = process.env }) {
  const executable = descriptor.env?.CLAUDE_CODE_EXECUTABLE;
  // Claude Code without the keys and the bridge's own variables.
  const baseEnvironment = () => {
    const result = { ...environment };
    for (const name of Object.keys(result)) if (name.startsWith('CODEFLOWER_')) delete result[name];
    for (const name of descriptor.credentialVariables ?? []) delete result[name];
    delete result.CLAUDE_CODE_PLUGIN_SEED_DIR;
    delete result.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    return result;
  };
  const run = (args, extra, timeout = RUN_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env: { ...baseEnvironment(), ...extra }, stdio: ['ignore', 'pipe', 'pipe'], timeout });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code: signal ? 1 : code, stdout, stderr }));
    });
  // The installer's own config folder, and the cache that becomes the seed.
  const fetching = (dir) => ({
    CLAUDE_CONFIG_DIR: join(dir, 'fetch-config'),
    CLAUDE_CODE_PLUGIN_CACHE_DIR: seedOf(dir),
    // The installer, not the bound CLI, which the app keeps.
    DISABLE_AUTOUPDATER: '1'
  });
  const failure = (result) =>
    lastJson(result.stdout)?.message ?? (result.stderr.trim().split('\n').pop() || `exited with ${result.code}`);

  const marketplaces = async (dir) => {
    const result = await run(['plugin', 'marketplace', 'list', '--json'], fetching(dir), LIST_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`Could not list the marketplaces: ${failure(result)}`);
    const value = JSON.parse(result.stdout);
    return Array.isArray(value) ? value : [];
  };
  // Adds a marketplace, or updates it when it is there; returns its name.
  const addMarketplace = async (dir, parsed) => {
    const known = (await marketplaces(dir)).find((marketplace) => sameSource(marketplace, parsed));
    const result = known
      ? await run(['plugin', 'marketplace', 'update', known.name], fetching(dir))
      : await run(['plugin', 'marketplace', 'add', claudeSource(parsed), '--json'], fetching(dir));
    if (result.code !== 0) throw new Error(failure(result));
    if (known) return known.name;
    const added = lastJson(result.stdout)?.name ?? (await marketplaces(dir)).find((marketplace) => sameSource(marketplace, parsed))?.name;
    if (!added) throw new Error('Claude Code did not report the marketplace it added');
    return added;
  };

  // The plugins that come without a marketplace go into one of code flower's,
  // inside the seed so that the agent finds it there offline.
  const writeLocalCatalog = async (dir, bare) => {
    const folder = join(seedOf(dir), 'marketplaces', LOCAL_CATALOG);
    const file = join(folder, '.claude-plugin', 'marketplace.json');
    const existing = (await readJson(file).catch(() => undefined))?.plugins ?? [];
    const plugins = new Map(existing.map((plugin) => [plugin.name, plugin]));
    for (const { entry, name } of bare) {
      let source;
      if (entry.kind === 'github') source = { source: 'github', repo: entry.repository, ...(entry.ref ? { ref: entry.ref } : {}) };
      else if (entry.kind === 'git') source = { source: 'url', url: entry.url, ...(entry.ref ? { ref: entry.ref } : {}) };
      else {
        // A copy, so that the plugin is there in a sandbox that does not mount the path.
        const copy = join(folder, 'plugins', name);
        await rm(copy, { recursive: true, force: true });
        await mkdir(join(folder, 'plugins'), { recursive: true });
        await cp(entry.path, copy, { recursive: true });
        source = `./plugins/${name}`;
      }
      plugins.set(name, { name, source });
    }
    await writePrivate(
      file,
      `${JSON.stringify({ name: LOCAL_CATALOG, owner: { name: 'code flower' }, plugins: [...plugins.values()] }, null, 2)}\n`
    );
    const known = (await marketplaces(dir)).some((marketplace) => marketplace.name === LOCAL_CATALOG);
    const result = known
      ? await run(['plugin', 'marketplace', 'update', LOCAL_CATALOG], fetching(dir))
      : await run(['plugin', 'marketplace', 'add', folder, '--json'], fetching(dir));
    if (result.code !== 0) throw new Error(`Could not prepare code flower's marketplace: ${failure(result)}`);
  };

  // The name a path: plugin gives itself, else the folder's.
  const nameOf = async (entry) => {
    if (entry.kind === 'path') {
      const manifest = await readJson(join(entry.path, '.claude-plugin', 'plugin.json')).catch(() => undefined);
      if (typeof manifest?.name === 'string' && manifest.name.trim()) {
        return manifest.name.toLowerCase().replace(SAFE_NAME, '-');
      }
    }
    return localName(entry);
  };

  // Claude Code's id of each entry (`name@marketplace`), by entry id.
  const claudeIds = async (entries) => {
    const ids = new Map();
    const taken = new Map();
    for (const entry of entries) {
      if (entry.kind === 'marketplace') {
        ids.set(entry.id, `${entry.name}@${entry.catalog}`);
        continue;
      }
      let name = await nameOf(entry);
      // Two plugins of the same name from different places.
      if (taken.has(name) && taken.get(name) !== entry.source) {
        name = `${name}-${createHash('sha256').update(entry.source).digest('hex').slice(0, 6)}`;
      }
      taken.set(name, entry.source);
      ids.set(entry.id, `${name}@${LOCAL_CATALOG}`);
    }
    return ids;
  };

  let nativeCache;

  return {
    async fetch(entries, dir, { catalogs = [] } = {}) {
      if (!executable || !(await exists(executable))) throw new Error('Claude Code is not installed in this sandbox');
      await mkdir(seedOf(dir), { recursive: true, mode: 0o700 });
      await mkdir(fetching(dir).CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
      const ids = await claudeIds(entries);
      const errors = new Map();

      // The marketplaces the entries come from, fetched or updated once.
      for (const name of new Set(entries.filter((entry) => entry.kind === 'marketplace').map((entry) => entry.catalog))) {
        const catalog = catalogs.find((candidate) => candidate.name === name);
        const failed = (message) => {
          for (const entry of entries) if (entry.catalog === name) errors.set(entry.id, message);
        };
        if (!catalog) {
          failed(`No marketplace ${name}: add it first`);
          continue;
        }
        try {
          await addMarketplace(dir, parseSource(catalog.source));
        } catch (error) {
          failed(`Could not fetch the marketplace ${name}: ${error.message}`);
        }
      }
      const bare = entries.filter((entry) => entry.kind !== 'marketplace');
      if (bare.length) {
        try {
          await writeLocalCatalog(dir, bare.map((entry) => ({ entry, name: ids.get(entry.id).split('@')[0] })));
        } catch (error) {
          for (const entry of bare) errors.set(entry.id, error.message);
        }
      }

      for (const entry of entries) {
        if (errors.has(entry.id)) continue;
        const result = await run(['plugin', 'install', ids.get(entry.id), '--json', '-y'], fetching(dir));
        const outcome = lastJson(result.stdout);
        if (result.code !== 0 || outcome?.outcome !== 'ok') errors.set(entry.id, failure(result));
      }

      const listed = await run(['plugin', 'list', '--json'], fetching(dir), LIST_TIMEOUT_MS);
      const versions = new Map();
      if (listed.code === 0) {
        for (const plugin of JSON.parse(listed.stdout)) versions.set(plugin.id, plugin.version);
      }
      return entries.map((entry) =>
        errors.has(entry.id)
          ? { id: entry.id, error: errors.get(entry.id) }
          : { id: entry.id, version: versions.get(ids.get(entry.id)) ?? 'unknown' }
      );
    },

    async fetchCatalogs(catalogs, dir) {
      if (!executable || !(await exists(executable))) throw new Error('Claude Code is not installed in this sandbox');
      await mkdir(seedOf(dir), { recursive: true, mode: 0o700 });
      await mkdir(fetching(dir).CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
      const results = [];
      for (const catalog of catalogs) {
        try {
          results.push({ source: catalog.source, name: await addMarketplace(dir, parseSource(catalog.source)) });
        } catch (error) {
          results.push({ source: catalog.source, error: error.message });
        }
      }
      return results;
    },

    async activate(entries, dir) {
      if (!home) throw new Error('CLAUDE_CONFIG_DIR is not set');
      const ids = [...(await claudeIds(entries)).values()];
      const recordFile = join(dir, 'activated.json');
      const before = (await readJson(recordFile).catch(() => undefined))?.enabledPlugins ?? [];
      const file = join(home, 'settings.json');
      const settings = (await readJson(file)) ?? {};
      if (settings.enabledPlugins !== undefined &&
          (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object' || Array.isArray(settings.enabledPlugins))) {
        throw new Error(`Expected enabledPlugins to be a JSON object in ${file}`);
      }
      const enabledPlugins = { ...settings.enabledPlugins };
      for (const id of before) if (!ids.includes(id)) delete enabledPlugins[id];
      for (const id of ids) enabledPlugins[id] = true;
      if (JSON.stringify(enabledPlugins) !== JSON.stringify(settings.enabledPlugins ?? {})) {
        const { enabledPlugins: _, ...rest } = settings;
        await writePrivate(file, `${JSON.stringify(Object.keys(enabledPlugins).length ? { ...rest, enabledPlugins } : rest, null, 2)}\n`);
      }
      await writePrivate(recordFile, `${JSON.stringify({ enabledPlugins: ids }, null, 2)}\n`);
      return { env: (await exists(seedOf(dir))) ? { CLAUDE_CODE_PLUGIN_SEED_DIR: seedOf(dir) } : {} };
    },

    // The plugins installed in Claude Code itself, e.g. with /plugin in a chat;
    // those from the seed are code flower's and not listed by the CLI.
    async list(dir) {
      if (!home || !executable || !(await exists(executable))) return [];
      if (nativeCache && Date.now() - nativeCache.at < NATIVE_CACHE_MS) return nativeCache.plugins;
      const result = await run(['plugin', 'list', '--json'], { CLAUDE_CONFIG_DIR: home }, LIST_TIMEOUT_MS);
      if (result.code !== 0) throw new Error(failure(result));
      const managed = new Set((await readJson(join(dir, 'activated.json')).catch(() => undefined))?.enabledPlugins ?? []);
      const plugins = JSON.parse(result.stdout)
        .filter((plugin) => typeof plugin?.id === 'string' && !managed.has(plugin.id))
        .map((plugin) => ({
          name: plugin.id,
          ...(plugin.version ? { version: String(plugin.version) } : {}),
          enabled: plugin.enabled !== false,
          origin: 'native'
        }));
      nativeCache = { at: Date.now(), plugins };
      return plugins;
    },

    // A fetched marketplace's plugins.
    async catalog(dir, name) {
      const folder = join(seedOf(dir), 'marketplaces', name);
      const manifest =
        (await readJson(join(folder, '.claude-plugin', 'marketplace.json')).catch(() => undefined)) ??
        (await readJson(`${folder}.json`).catch(() => undefined));
      if (!manifest) return undefined;
      const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
      return Promise.all(
        plugins
          .filter((plugin) => typeof plugin?.name === 'string')
          .map(async (plugin) => {
            // A plugin in the marketplace's own repository can be looked at before it is fetched.
            const inside = typeof plugin.source === 'string' && !plugin.source.includes('..') ? join(folder, plugin.source) : undefined;
            const folderThere = inside && (await stat(inside).then((info) => info.isDirectory()).catch(() => false));
            return {
              name: plugin.name,
              ...(plugin.displayName ? { displayName: String(plugin.displayName) } : {}),
              description: typeof plugin.description === 'string' ? plugin.description : '',
              ...(plugin.category ? { category: String(plugin.category) } : {}),
              ...(plugin.version ? { version: String(plugin.version) } : {}),
              ...(plugin.homepage ? { homepage: String(plugin.homepage) } : {}),
              ...(plugin.author?.name ? { author: String(plugin.author.name) } : {}),
              source: `marketplace:${plugin.name}@${name}`,
              // Known only for plugins in the marketplace's repository; others say what they add once fetched.
              contents: folderThere ? await describePlugin(inside, plugin) : undefined
            };
          })
      );
    }
  };
}

