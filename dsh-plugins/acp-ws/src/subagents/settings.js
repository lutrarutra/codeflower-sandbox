// The default model and effort of an agent's subagents, set per project from
// the windows (`_codeflower/subagents/settings`) and kept in its state. Each
// agent says in agent.json how it takes them (`subagents.settings`):
//
//   { kind: "session-meta", path: [...], same, applies: "session" }
//       a value at `path` in the `_meta` of every session start
//   { kind: "env", variable, same, applies: "restart" }
//       an environment variable of the agent
//   { kind: "json-env", variable, key, applies: "restart" }
//       a key in a JSON object held by an environment variable
//
// "same" (the main chat's model or effort) leaves the setting out, unless
// the agent wants a value for it (`same`).
import { readJson, writeJsonAtomically } from '../sessions.js';

export const SAME = 'same';
const NAMES = ['model', 'effort'];
const MAX_VALUE = 200;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Settings as stored and sent: a value per name, "same" when unset. */
export function normalizeSettings(value) {
  const settings = {};
  for (const name of NAMES) {
    const raw = object(value) ? value[name] : undefined;
    settings[name] = typeof raw === 'string' && raw.trim() && raw.length <= MAX_VALUE ? raw.trim() : SAME;
  }
  return settings;
}

// The value a setting gives the agent, or undefined to leave it out.
const valueOf = (spec, value) => (value === SAME ? (typeof spec.same === 'string' ? spec.same : undefined) : value);

const setPath = (target, path, value) => {
  let node = target;
  for (const part of path.slice(0, -1)) {
    if (!object(node[part])) node[part] = {};
    node = node[part];
  }
  node[path.at(-1)] = value;
};

/**
 * What the settings ask of the agent: `sessionMeta` for every session start,
 * and `env` for the agent's process. `base` is the agent's own environment,
 * whose JSON variables the settings add to.
 */
export function settingsEffects(specs, settings, base = {}) {
  const sessionMeta = {};
  const env = {};
  for (const name of NAMES) {
    const spec = specs?.[name];
    if (!object(spec)) continue;
    const value = valueOf(spec, settings[name]);
    if (value === undefined) continue;
    if (spec.kind === 'session-meta' && Array.isArray(spec.path) && spec.path.length) {
      setPath(sessionMeta, spec.path, value);
    } else if (spec.kind === 'env' && typeof spec.variable === 'string') {
      env[spec.variable] = value;
    } else if (spec.kind === 'json-env' && typeof spec.variable === 'string' && typeof spec.key === 'string') {
      const current = env[spec.variable] ?? base[spec.variable];
      let parsed = {};
      try {
        parsed = current ? JSON.parse(current) : {};
      } catch {}
      env[spec.variable] = JSON.stringify({ ...(object(parsed) ? parsed : {}), [spec.key]: value });
    }
  }
  return { sessionMeta, env };
}

/** The settings file of a project: read once, written on every change. */
export async function createSubagentSettings({ file, log = () => {} }) {
  let settings = normalizeSettings(undefined);
  if (file) {
    try {
      settings = normalizeSettings(await readJson(file));
    } catch (error) {
      log(`Could not read the subagent settings: ${error.message}`);
    }
  }
  return {
    get: () => ({ ...settings }),
    async set(value) {
      settings = normalizeSettings({ ...settings, ...(object(value) ? value : {}) });
      if (file) await writeJsonAtomically(file, settings);
      return { ...settings };
    }
  };
}

/** Deep merge of `_meta` objects: `extra` wins, objects merge. */
export function mergeMeta(base, extra) {
  const merged = { ...(object(base) ? base : {}) };
  for (const [name, value] of Object.entries(extra ?? {})) {
    merged[name] = object(value) && object(merged[name]) ? mergeMeta(merged[name], value) : value;
  }
  return merged;
}
