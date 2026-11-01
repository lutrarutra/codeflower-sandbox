// The agents' own plugins (docs/plugins.md). What should be installed comes
// from the app's config (`plugins:` in config.yaml, passed as
// CODEFLOWER_PLUGINS) and from the project (`plugins/plugins.json`, written
// here from the windows). Each agent's adapter (`plugins` in its index.js)
// fetches them with the agent's own installer into `plugins/<agent>/`, which
// needs the network, and activates them before every agent start, which does
// not. An agent without the adapter has no plugins.
//
// Sources are agent-neutral strings, `kind:rest`; the app's
// internal/config/plugins.go follows the same rules.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { InvalidRequest } from './agents/support.js';
import { writeJsonAtomically } from './sessions.js';

// Where the app passes the config's plugins, as JSON by agent id. The bridge
// removes it from its environment.
export const PLUGINS_VARIABLE = 'CODEFLOWER_PLUGINS';
// Set by the app's fetch run: fetch what is missing, print JSON lines, exit.
export const PLUGINS_FETCH_VARIABLE = 'CODEFLOWER_PLUGINS_FETCH';

export const SOURCE_KINDS = ['marketplace', 'github', 'git', 'npm', 'url', 'path'];

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s#]+$/;
const NPM_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]{0,213}$/;
const NPM_VERSION = /^[A-Za-z0-9.^~<>=*+-]{1,64}$/;
const ARCHIVE_URL = /^https:\/\/[^\s#]+\.(zip|tgz|tar\.gz)$/;
const SHA256 = /^[0-9a-f]{64}$/;

function ref(text, what) {
  if (text === undefined) return undefined;
  if (!REF.test(text) || text.startsWith('-') || text.split('/').includes('..')) throw new Error(`Invalid ref in ${what}`);
  return text;
}

/**
 * A plugin source, checked and normalised: `{kind, source, ...}` where
 * `source` is the canonical text. Throws on anything else.
 */
export function parseSource(text) {
  if (typeof text !== 'string' || !text.trim() || /[\0\r\n]/.test(text)) throw new Error('A plugin source is required');
  const trimmed = text.trim();
  const colon = trimmed.indexOf(':');
  const kind = colon > 0 ? trimmed.slice(0, colon) : '';
  const rest = trimmed.slice(colon + 1);
  const [body, fragment] = rest.split(/#(.*)/s);
  switch (kind) {
    case 'marketplace': {
      const at = rest.lastIndexOf('@');
      const name = rest.slice(0, at);
      const catalog = rest.slice(at + 1);
      if (at < 1 || !NAME.test(name) || !NAME.test(catalog)) {
        throw new Error(`Expected marketplace:NAME@CATALOG, not ${trimmed}`);
      }
      return { kind, source: `marketplace:${name}@${catalog}`, name, catalog };
    }
    case 'github': {
      const [owner, repo, extra] = body.split('/');
      if (extra !== undefined || !GITHUB_OWNER.test(owner ?? '') || !GITHUB_REPO.test(repo ?? '') || repo === '.' || repo === '..') {
        throw new Error(`Expected github:OWNER/REPO[#REF], not ${trimmed}`);
      }
      const at = ref(fragment, trimmed);
      const repository = `${owner}/${repo.replace(/\.git$/, '')}`.toLowerCase();
      return { kind, source: `github:${repository}${at ? `#${at}` : ''}`, repository, ...(at ? { ref: at } : {}) };
    }
    case 'git': {
      if (!GIT_URL.test(body)) throw new Error(`Expected git:https://…, git:ssh://… or git:git@host:path, not ${trimmed}`);
      const at = ref(fragment, trimmed);
      return { kind, source: `git:${body}${at ? `#${at}` : ''}`, url: body, ...(at ? { ref: at } : {}) };
    }
    case 'npm': {
      const at = rest.lastIndexOf('@');
      const name = rest.slice(0, at);
      const version = rest.slice(at + 1);
      if (at < 1 || !NPM_PACKAGE.test(name) || !NPM_VERSION.test(version)) {
        throw new Error(`Expected npm:PACKAGE@VERSION, not ${trimmed}`);
      }
      return { kind, source: `npm:${name}@${version}`, package: name, version };
    }
    case 'url': {
      if (!ARCHIVE_URL.test(body)) throw new Error(`Expected url:https://….zip, .tgz or .tar.gz, not ${trimmed}`);
      let sha256;
      if (fragment !== undefined) {
        sha256 = /^sha256=(.*)$/.exec(fragment)?.[1]?.toLowerCase();
        if (!sha256 || !SHA256.test(sha256)) throw new Error(`Expected #sha256=<64 hex digits> in ${trimmed}`);
      }
      return { kind, source: `url:${body}${sha256 ? `#sha256=${sha256}` : ''}`, url: body, ...(sha256 ? { sha256 } : {}) };
    }
    case 'path': {
      if (!isAbsolute(rest)) throw new Error(`Expected path:/absolute/path, not ${trimmed}`);
      const path = normalize(rest).replace(/(.)\/+$/, '$1');
      return { kind, source: `path:${path}`, path };
    }
    default:
      throw new Error(`A plugin source starts with ${SOURCE_KINDS.map((name) => `${name}:`).join(', ')}, not ${trimmed}`);
  }
}

/** An entry's id: the agent and its normalised source. */
export function pluginId(agent, source) {
  return `${agent}:${parseSource(source).source}`;
}

function entries(value, where) {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must hold {source} objects`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`${where}: enabled must be true or false`);
    return { source: parseSource(entry.source).source, enabled: entry.enabled ?? true };
  });
}

/** The config's plugins in the app's JSON, by agent id; throws on a bad source. */
export function parsePlugins(text) {
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${PLUGINS_VARIABLE} must be a JSON object`);
  return Object.fromEntries(Object.entries(value).map(([agent, list]) => [agent, entries(list, `${agent}'s plugins`)]));
}

async function readJsonFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new Error(`Invalid JSON in ${file}`);
}

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * One agent's plugins in a project.
 *
 * `hooks` is the agent's adapter, `descriptor` its `plugins` block (kinds and
 * catalogs), `directory` the project's `plugins/`, `configured` the config's
 * entries for this agent. `canFetch`: this sandbox reaches the network.
 */
export function createPlugins({ agentName, hooks, descriptor = {}, directory, configured = [], canFetch = false, log = () => {} }) {
  const kinds = list(descriptor.kinds);
  const available = Boolean(hooks && directory);
  const dir = directory ? join(directory, agentName) : undefined;
  const projectFile = directory ? join(directory, 'plugins.json') : undefined;
  const stateFile = dir ? join(dir, 'state.json') : undefined;
  const listeners = new Set();
  // The ids the running agent was started with; undefined before its first start.
  let active;
  // The fetch running now, if any, and the ids it fetches.
  let fetching;
  let fetchingIds = new Set();
  // Writes of plugins.json and state.json, one at a time.
  let writing = Promise.resolve();

  const checkKind = (parsed) => {
    if (!kinds.includes(parsed.kind)) {
      throw new InvalidRequest(`This agent's plugins come from ${kinds.map((kind) => `${kind}:`).join(', ')}, not ${parsed.kind}:`);
    }
    return parsed;
  };
  for (const entry of configured) {
    try {
      checkKind(parseSource(entry.source));
    } catch (error) {
      throw new Error(`The config's plugin ${entry.source}: ${error.message}`);
    }
  }

  const serially = (work) => {
    const next = writing.then(work);
    writing = next.catch(() => {});
    return next;
  };
  const readProject = async () => (projectFile ? ((await readJsonFile(projectFile)) ?? {}) : {});
  const readState = async () => (stateFile ? ((await readJsonFile(stateFile)) ?? {}) : {});
  const changed = () => {
    for (const listener of listeners) listener();
  };

  // Every entry for this agent: the config's, then the project's own; a
  // project entry with a config entry's source switches it on or off.
  const desired = async () => {
    const project = await readProject();
    const own = list(project.plugins?.[agentName]).flatMap((entry) => {
      try {
        return [{ source: parseSource(entry.source).source, enabled: entry.enabled !== false }];
      } catch (error) {
        log(`Plugin ${JSON.stringify(entry?.source)} in ${projectFile} left out: ${error.message}`);
        return [];
      }
    });
    const result = new Map();
    for (const entry of configured) result.set(entry.source, { source: entry.source, origin: 'config', enabled: entry.enabled });
    for (const entry of own) {
      const config = result.get(entry.source);
      if (config) config.enabled = entry.enabled;
      else result.set(entry.source, { source: entry.source, origin: 'project', enabled: entry.enabled });
    }
    return [...result.values()].map((entry) => ({ id: `${agentName}:${entry.source}`, ...entry, ...parseSource(entry.source) }));
  };

  const fetchedOk = (state, id) => Boolean(state.fetched?.[id]) && !state.fetched[id].error;
  // The enabled entries fetched without error: what activate() turns on.
  const ready = async () => {
    const state = await readState();
    return (await desired()).filter((entry) => entry.enabled && fetchedOk(state, entry.id));
  };
  const projectCatalogs = async () => list((await readProject()).catalogs?.[agentName]).filter((c) => typeof c?.source === 'string');

  const restartPending = async () => {
    if (!active) return false;
    const ids = new Set((await ready()).map((entry) => entry.id));
    return ids.size !== active.size || [...ids].some((id) => !active.has(id));
  };

  const updateProject = (change) =>
    serially(async () => {
      const project = await readProject();
      const plugins = list(project.plugins?.[agentName]).filter((entry) => typeof entry?.source === 'string');
      const catalogs = list(project.catalogs?.[agentName]);
      const next = change({ plugins, catalogs });
      await writeJsonAtomically(projectFile, {
        ...project,
        plugins: { ...project.plugins, [agentName]: next.plugins ?? plugins },
        catalogs: { ...project.catalogs, [agentName]: next.catalogs ?? catalogs }
      });
    });

  const requireAvailable = () => {
    if (!available) throw new InvalidRequest('This agent has no plugins in code flower');
  };

  const manager = {
    available,
    canFetch,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The entries with their state, the agent's own (native) plugins and the catalogs. */
    async list() {
      if (!available) return { available: false };
      const state = await readState();
      const entries = (await desired()).map(({ id, source, origin, enabled, kind }) => {
        const fetched = state.fetched?.[id];
        const status = fetchingIds.has(id)
          ? 'fetching'
          : !enabled
            ? 'disabled'
            : fetched?.error
              ? 'error'
              : !fetched
                ? 'pending'
                : active && !active.has(id)
                  ? 'fetched'
                  : 'active';
        return {
          id,
          source,
          kind,
          origin,
          enabled,
          state: status,
          ...(fetched?.version ? { version: fetched.version } : {}),
          ...(fetched?.error ? { error: fetched.error } : {}),
          ...(fetched?.at ? { fetchedAt: fetched.at } : {})
        };
      });
      let native = [];
      if (hooks.list) {
        try {
          native = list(await hooks.list(dir));
        } catch (error) {
          log(`Could not list the agent's own plugins: ${error.message}`);
        }
      }
      const catalogs = [
        ...list(descriptor.catalogs).map((catalog) => ({ ...catalog, origin: 'agent' })),
        ...(await projectCatalogs()).map(({ source }) => ({ source, origin: 'project' }))
      ].map(({ name, source, origin }) => {
        const fetched = state.catalogs?.[source];
        const known = name ?? fetched?.name;
        return {
          ...(known ? { name: known } : {}),
          source,
          origin,
          fetched: Boolean(known && fetched?.name === known && !fetched.error),
          ...(fetched?.error ? { error: fetched.error } : {})
        };
      });
      return {
        available: true,
        kinds,
        canFetch,
        fetching: Boolean(fetching),
        restartPending: await restartPending(),
        browsable: Boolean(hooks.catalog),
        entries,
        native,
        catalogs
      };
    },

    /** Adds a project entry; fetches it at once when this sandbox has the network. */
    async add(text) {
      requireAvailable();
      let parsed;
      try {
        parsed = checkKind(parseSource(text));
      } catch (error) {
        throw error instanceof InvalidRequest ? error : new InvalidRequest(error.message);
      }
      const id = `${agentName}:${parsed.source}`;
      await updateProject(({ plugins }) => ({
        plugins: [...plugins.filter((entry) => parseSafe(entry.source) !== parsed.source), { source: parsed.source, enabled: true }]
      }));
      changed();
      if (canFetch) void manager.fetch().catch((error) => log(`Could not fetch plugins: ${error.message}`));
      return { id, pendingFetch: !canFetch };
    },

    /** Removes a project entry. The config's entries are switched off instead. */
    async remove(id) {
      requireAvailable();
      const entry = (await desired()).find((candidate) => candidate.id === id);
      if (!entry) throw new InvalidRequest(`No plugin ${id}`);
      if (entry.origin === 'config') throw new InvalidRequest(`${entry.source} comes from the app's config; switch it off for this project instead`);
      await updateProject(({ plugins }) => ({ plugins: plugins.filter((candidate) => parseSafe(candidate.source) !== entry.source) }));
      await serially(async () => {
        const state = await readState();
        if (!state.fetched?.[id]) return;
        delete state.fetched[id];
        await writeJsonAtomically(stateFile, state);
      });
      changed();
      return {};
    },

    async setEnabled(id, enabled) {
      requireAvailable();
      if (typeof enabled !== 'boolean') throw new InvalidRequest('enabled must be true or false');
      const entry = (await desired()).find((candidate) => candidate.id === id);
      if (!entry) throw new InvalidRequest(`No plugin ${id}`);
      await updateProject(({ plugins }) => {
        const rest = plugins.filter((candidate) => parseSafe(candidate.source) !== entry.source);
        // A config entry switched back on needs no project entry.
        const configEntry = configured.find((candidate) => candidate.source === entry.source);
        if (configEntry && configEntry.enabled === enabled) return { plugins: rest };
        return { plugins: [...rest, { source: entry.source, enabled }] };
      });
      changed();
      if (enabled && canFetch) void manager.fetch().catch((error) => log(`Could not fetch plugins: ${error.message}`));
      return {};
    },

    /** Adds a catalog of the project's own (a marketplace), fetched like the plugins. */
    async addCatalog(text) {
      requireAvailable();
      if (!hooks.fetchCatalogs) throw new InvalidRequest('This agent has no catalogs');
      let parsed;
      try {
        parsed = parseSource(text);
      } catch (error) {
        throw new InvalidRequest(error.message);
      }
      if (!['github', 'git', 'path', 'url'].includes(parsed.kind)) throw new InvalidRequest('A catalog comes from github:, git:, url: or path:');
      await updateProject(({ catalogs }) => ({
        catalogs: [...catalogs.filter((catalog) => catalog.source !== parsed.source), { source: parsed.source }]
      }));
      changed();
      if (canFetch) void manager.fetch().catch((error) => log(`Could not fetch plugins: ${error.message}`));
      return { source: parsed.source, pendingFetch: !canFetch };
    },

    async removeCatalog(source) {
      requireAvailable();
      await updateProject(({ catalogs }) => ({ catalogs: catalogs.filter((catalog) => catalog.source !== source) }));
      changed();
      return {};
    },

    /** The enabled entries and catalogs not fetched yet, or whose fetch failed. */
    async missing() {
      if (!available) return { plugins: [], catalogs: [] };
      const state = await readState();
      const plugins = (await desired()).filter((entry) => entry.enabled && !fetchedOk(state, entry.id));
      const catalogs = [...list(descriptor.catalogs), ...(await projectCatalogs())]
        .filter((catalog) => !state.catalogs?.[catalog.source]?.name || state.catalogs[catalog.source].error);
      return { plugins, catalogs };
    },

    /**
     * Fetches what is missing with the agent's own installer and records the
     * results; one fetch at a time. Returns {plugins: [{id, version?, error?}],
     * catalogs: [{source, name?, error?}]}.
     */
    async fetch() {
      requireAvailable();
      if (fetching) return fetching;
      fetching = (async () => {
        const { plugins, catalogs } = await manager.missing();
        if (!plugins.length && !catalogs.length) return { plugins: [], catalogs: [] };
        fetchingIds = new Set(plugins.map((entry) => entry.id));
        changed();
        const at = new Date().toISOString();
        let catalogResults = [];
        if (catalogs.length && hooks.fetchCatalogs) {
          try {
            catalogResults = list(await hooks.fetchCatalogs(catalogs, dir));
          } catch (error) {
            catalogResults = catalogs.map(({ source }) => ({ source, error: error.message }));
          }
        }
        let results = [];
        if (plugins.length) {
          try {
            results = list(await hooks.fetch(plugins, dir, { catalogs: await manager.knownCatalogs() }));
          } catch (error) {
            results = plugins.map(({ id }) => ({ id, error: error.message }));
          }
        }
        const byId = new Map(results.map((result) => [result.id, result]));
        const pluginResults = plugins.map(({ id }) => byId.get(id) ?? { id, error: 'The agent did not report this plugin' });
        await serially(async () => {
          const state = await readState();
          state.fetched = { ...state.fetched };
          for (const { id, version, error } of pluginResults) {
            state.fetched[id] = { ...(version ? { version: String(version) } : {}), ...(error ? { error: String(error) } : {}), at };
          }
          state.catalogs = { ...state.catalogs };
          for (const { source, name, error } of catalogResults) {
            state.catalogs[source] = { ...(name ? { name } : {}), ...(error ? { error: String(error) } : {}), at };
          }
          await writeJsonAtomically(stateFile, state);
        });
        for (const { id, error } of pluginResults) if (error) log(`Could not fetch plugin ${id}: ${error}`);
        return { plugins: pluginResults, catalogs: catalogResults };
      })().finally(() => {
        fetching = undefined;
        fetchingIds = new Set();
        changed();
      });
      return fetching;
    },

    /** The catalogs fetched so far, {name, source}. */
    async knownCatalogs() {
      const state = await readState();
      return [
        ...list(descriptor.catalogs),
        ...(await projectCatalogs()).flatMap(({ source }) => (state.catalogs?.[source]?.name ? [{ name: state.catalogs[source].name, source }] : []))
      ];
    },

    /** A fetched catalog's plugins, for browsing. */
    async catalog(name) {
      requireAvailable();
      if (!hooks.catalog) throw new InvalidRequest('This agent has no catalogs');
      if (typeof name !== 'string' || !NAME.test(name)) throw new InvalidRequest('A catalog name is required');
      if (!(await manager.knownCatalogs()).some((catalog) => catalog.name === name)) throw new InvalidRequest(`No catalog ${name}`);
      const items = await hooks.catalog(dir, name);
      if (!items) return { name, fetched: false, plugins: [] };
      return { name, fetched: true, plugins: list(items) };
    },

    /**
     * Before every agent start: turns on what is fetched and enabled, and off
     * what is not. Returns the agent's extra environment; never throws, as an
     * agent without its plugins is better than none.
     */
    async activate() {
      if (!available) return {};
      try {
        const entries = await ready();
        const result = (await hooks.activate(entries, dir)) ?? {};
        active = new Set(entries.map((entry) => entry.id));
        changed();
        return result.env ?? {};
      } catch (error) {
        log(`Could not turn on the agent's plugins: ${error.message}`);
        active = new Set();
        changed();
        return {};
      }
    }
  };
  return manager;
}

function parseSafe(source) {
  try {
    return parseSource(source).source;
  } catch {
    return undefined;
  }
}

/**
 * The app's fetch run (CODEFLOWER_PLUGINS_FETCH=1): fetches what is missing and
 * prints one JSON line per plugin and catalog, then `{done, errors}`. Returns
 * the number of errors.
 */
export async function runFetch(plugins, out = process.stdout) {
  if (!plugins.available) {
    out.write(`${JSON.stringify({ done: true, errors: 0, available: false })}\n`);
    return 0;
  }
  const { plugins: results, catalogs } = await plugins.fetch();
  for (const result of catalogs) out.write(`${JSON.stringify({ catalog: result.source, ...result })}\n`);
  for (const result of results) out.write(`${JSON.stringify({ plugin: result.id, ...result })}\n`);
  const errors = [...results, ...catalogs].filter((result) => result.error).length;
  out.write(`${JSON.stringify({ done: true, errors })}\n`);
  return errors;
}
