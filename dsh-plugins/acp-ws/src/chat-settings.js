// A chat's settings (mode, model, effort, …) as the agent offers them in ACP
// (`configOptions`, or only `modes`), kept by the bridge for every agent:
//
// - each chat's own, in its session meta (sessions.js), set again when the
//   chat is opened, also after the worker restarted, since agents keep some
//   of them only while the chat runs (Claude's effort);
// - the last choice made in a window, per category, for the chats started
//   next in the project: `<private>/chat-settings/<agent>.json`. An agent's
//   index.js names the categories it remembers itself (`remembers`, e.g.
//   OpenCode's model for each mode), which this leaves alone.
import { readJson, writeJsonAtomically } from './sessions.js';

/** What a new chat takes from the last choices, in the order they are set. */
export const NEW_CHAT_CATEGORIES = ['mode', 'model', 'thought_level'];

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A select option's choices, also inside groups (dsh groups models by provider).
const choices = (option) => (Array.isArray(option.options) ? option.options : []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]));

/** Whether the agent offers `value` for the option now (a model may be gone, or not take that effort). */
export function offers(option, value) {
  if (!object(option) || value === undefined || value === null) return false;
  if (option.type === 'boolean') return typeof value === 'boolean';
  return choices(option).some((choice) => same(choice?.value, value));
}

/** A session's settings as the bridge keeps them: { options: { configId: value }, mode }. */
export function settingsOf(state) {
  const settings = {};
  if (Array.isArray(state?.configOptions)) {
    const options = {};
    for (const option of state.configOptions) {
      if (typeof option?.id === 'string' && option.currentValue !== undefined) options[option.id] = option.currentValue;
    }
    settings.options = options;
  } else if (typeof state?.modes?.currentModeId === 'string') {
    settings.mode = state.modes.currentModeId;
  }
  return settings;
}

// Settings that others depend on go first: a model's efforts differ, and
// Claude's adapter picks the effort again when the model changes.
const rank = (category) => {
  const index = NEW_CHAT_CATEGORIES.indexOf(category);
  return index === -1 ? NEW_CHAT_CATEGORIES.length : index;
};

/**
 * The next change that brings a session's settings (`state`, as the agent
 * reports them) to `wanted`, or undefined when there is none left: a value
 * the agent offers and does not have, mode first, then model, then effort.
 * Asked again after each change, since a change may change what is offered.
 * `tried` holds the configIds already asked for, so a refusal is not retried.
 */
export function nextChange(state, wanted, tried = new Set()) {
  if (!object(wanted)) return undefined;
  const options = Array.isArray(state?.configOptions) ? state.configOptions : undefined;
  if (options && object(wanted.options)) {
    const pending = options
      .filter((option) => typeof option?.id === 'string' && !tried.has(option.id) && Object.hasOwn(wanted.options, option.id))
      .filter((option) => !same(option.currentValue, wanted.options[option.id]) && offers(option, wanted.options[option.id]))
      .sort((a, b) => rank(a.category) - rank(b.category));
    if (pending.length) {
      const [option] = pending;
      const value = wanted.options[option.id];
      return { method: 'session/set_config_option', configId: option.id, params: typeof value === 'boolean' ? { configId: option.id, type: 'boolean', value } : { configId: option.id, value } };
    }
  }
  const modes = state?.modes;
  if (!options && typeof wanted.mode === 'string' && !tried.has('mode') && modes && modes.currentModeId !== wanted.mode) {
    const available = Array.isArray(modes.availableModes) ? modes.availableModes : [];
    if (available.some((mode) => mode?.id === wanted.mode)) return { method: 'session/set_mode', configId: 'mode', params: { modeId: wanted.mode } };
  }
  return undefined;
}

/**
 * The settings a new chat gets from the last choices (`last`, by category),
 * as `nextChange` takes them: the options of the categories not in `skip`.
 */
export function newChatSettings(state, last, skip = []) {
  if (!object(last)) return {};
  const categories = NEW_CHAT_CATEGORIES.filter((category) => !skip.includes(category) && Object.hasOwn(last, category));
  if (Array.isArray(state?.configOptions)) {
    const options = {};
    for (const category of categories) {
      const option = state.configOptions.find((candidate) => candidate?.category === category);
      if (typeof option?.id === 'string') options[option.id] = last[category];
    }
    return { options };
  }
  return categories.includes('mode') && typeof last.mode === 'string' ? { mode: last.mode } : {};
}

/** The category of a setting a window chose: `mode` for an agent with only modes. */
export function categoryOf(state, method, params) {
  if (method === 'session/set_mode') return 'mode';
  const option = (Array.isArray(state?.configOptions) ? state.configOptions : []).find((candidate) => candidate?.id === params?.configId);
  return typeof option?.category === 'string' ? option.category : undefined;
}

/** The last choices of a project's windows, by category: read once, written on every change. */
export async function createLastChoices({ file, log = () => {} }) {
  let choices = {};
  if (file) {
    try {
      const read = await readJson(file);
      if (object(read)) choices = read;
    } catch (error) {
      log(`Could not read the last chat settings: ${error.message}`);
    }
  }
  let writing = Promise.resolve();
  return {
    get() {
      return choices;
    },
    remember(category, value) {
      if (!NEW_CHAT_CATEGORIES.includes(category) || value === undefined || same(choices[category], value)) return writing;
      choices = { ...choices, [category]: value };
      if (!file) return writing;
      const snapshot = choices;
      writing = writing
        .then(() => writeJsonAtomically(file, snapshot))
        .catch((error) => log(`Could not save the last chat settings: ${error.message}`));
      return writing;
    }
  };
}
