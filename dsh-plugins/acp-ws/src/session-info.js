import { join } from 'node:path';
import { writeJsonAtomically } from './sessions.js';

// What each chat runs as, for the scripts the agent runs: storyteller names the
// agent and model in a report's header from <directory>/<sessionId>.json. The
// agents export the session id to their commands (CLAUDE_CODE_SESSION_ID,
// CODEX_THREAD_ID); for one that does not, `turn` tells the chat whose turn is
// running. Only names leave the bridge here, never what the chats say.

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// A select option's values, also inside groups (dsh groups models by provider).
function choices(option) {
  return (option.options ?? []).flatMap((choice) => choice.options ?? [choice]);
}

/** The display name of the model a session runs, from its settings. */
export function modelName({ configOptions, models } = {}) {
  const option = Array.isArray(configOptions) ? configOptions.find((candidate) => candidate?.category === 'model') : undefined;
  if (option) {
    const current = JSON.stringify(option.currentValue);
    const choice = choices(option).find((candidate) => JSON.stringify(candidate.value) === current);
    // Claude Code's "default" choice names the model it resolves to in its description.
    if (choice?.value === 'default' && typeof choice.description === 'string' && choice.description) return choice.description;
    if (typeof choice?.name === 'string' && choice.name) return choice.name;
    const value = option.currentValue;
    return value === undefined || value === null ? undefined : String(Array.isArray(value) ? value.at(-1) : value);
  }
  if (typeof models?.currentModelId === 'string') {
    const model = models.availableModels?.find?.((candidate) => candidate?.modelId === models.currentModelId);
    return model?.name || models.currentModelId;
  }
  return undefined;
}

/**
 * Keeps <directory>/<sessionId>.json current: { agent, model, turn }. Without
 * a directory it does nothing. Writes for one session land in order.
 */
export function createSessionInfo({ directory, agent, log = () => {} }) {
  const sessions = new Map();

  const write = (sessionId, state) => {
    if (!directory || !SAFE_ID.test(sessionId)) return;
    const info = {
      agent,
      ...(state.model ? { model: state.model } : {}),
      turn: state.turn
    };
    const text = JSON.stringify(info);
    if (text === state.written) return;
    state.written = text;
    state.queue = state.queue
      .then(() => writeJsonAtomically(join(directory, `${sessionId}.json`), info))
      .catch((error) => log(`Could not write the session info of ${sessionId}: ${error.message}`));
  };

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) sessions.set(sessionId, (state = { turn: false, queue: Promise.resolve() }));
    return state;
  };

  return {
    /** The agent's name as it reports it (initialize's agentInfo), used when none was given. */
    reported(agentInfo) {
      agent ??= agentInfo?.title || agentInfo?.name;
    },

    /** A session's settings: { configOptions, models } as ACP reports them. */
    settings(sessionId, settings) {
      if (typeof sessionId !== 'string') return;
      const state = stateOf(sessionId);
      state.model = modelName(settings) ?? state.model;
      write(sessionId, state);
    },

    turn(sessionId, running) {
      if (typeof sessionId !== 'string') return;
      const state = stateOf(sessionId);
      state.turn = running;
      write(sessionId, state);
    },

    async flush() {
      await Promise.all([...sessions.values()].map((state) => state.queue));
    }
  };
}
