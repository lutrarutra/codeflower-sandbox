// The prompts that wait for a chat's turn to end, on the worker: the user's
// own messages, preview feedback and actions, from any window. They go one
// per turn, in order, also while no window is open, and every window that
// opens the chat sees them (`_codeflower/queue`).
//
// The next one goes once a turn ends with end_turn. Any other end (a refusal,
// an error, a cancel the queue did not ask for) pauses the queue, which keeps
// its prompts until a window resumes it. A cancel the queue asked for (send
// now, an interrupting action) goes on with the next prompt.
//
// It lives in the bridge's memory: windows come and go and the agent may
// restart, but a new bridge starts with an empty queue.

export const MAX_QUEUED = 100;
export const MAX_QUEUED_BYTES = 1_000_000;

export function createPromptQueue({ onChange = () => {} } = {}) {
  // Per session: { items, paused, resumeAfterCancel }.
  const chats = new Map();
  let nextId = 1;

  const chat = (sessionId) => {
    let state = chats.get(sessionId);
    if (!state) {
      state = { items: [], paused: null, resumeAfterCancel: false };
      chats.set(sessionId, state);
    }
    return state;
  };
  // Forgets a chat with nothing left to tell.
  const settle = (sessionId) => {
    const state = chats.get(sessionId);
    if (state && !state.items.length && !state.paused && !state.resumeAfterCancel) chats.delete(sessionId);
  };
  const changed = (sessionId) => {
    settle(sessionId);
    onChange(sessionId);
  };

  return {
    /**
     * Queues a prompt: `prompt` is what the agent gets, `text` what the user
     * wrote (back to the composer on edit or stop), `title` what the queue
     * shows. `replace` empties the queue first and goes on after the cancel
     * that interrupts the turn.
     */
    add(sessionId, { prompt, steer, text, title, editable, action }, { replace = false } = {}) {
      const state = chat(sessionId);
      if (replace) {
        state.items = [];
        state.paused = null;
        state.resumeAfterCancel = true;
      }
      if (state.items.length >= MAX_QUEUED) throw new RangeError(`At most ${MAX_QUEUED} prompts wait in a chat`);
      const item = {
        id: `q-${nextId++}`,
        prompt,
        ...(steer ? { steer } : {}),
        text,
        title,
        ...(editable ? { editable: true } : {}),
        ...(action ? { action } : {})
      };
      state.items.push(item);
      changed(sessionId);
      return item;
    },

    remove(sessionId, id) {
      const state = chats.get(sessionId);
      const index = state?.items.findIndex((item) => item.id === id) ?? -1;
      if (index < 0) return false;
      state.items.splice(index, 1);
      changed(sessionId);
      return true;
    },

    /** Takes prompts off the queue: the one with `id`, or with `editable` all the user's own. */
    take(sessionId, { id, editable = false } = {}) {
      const state = chats.get(sessionId);
      if (!state) return [];
      const taken = state.items.filter((item) => (id !== undefined ? item.id === id : editable ? item.editable : true));
      if (!taken.length) return [];
      state.items = state.items.filter((item) => !taken.includes(item));
      changed(sessionId);
      return taken;
    },

    find(sessionId, id) {
      return chats.get(sessionId)?.items.find((item) => item.id === id);
    },

    /** Puts prompts back before the others, e.g. one that could not go yet. */
    putFirst(sessionId, items) {
      if (!items.length) return;
      const state = chat(sessionId);
      state.items = [...items, ...state.items.filter((item) => !items.includes(item))];
      changed(sessionId);
    },

    /** Moves a prompt first, unpaused, to go once the turn is cancelled (`afterCancel`) or now. */
    sendFirst(sessionId, id, { afterCancel = false } = {}) {
      const state = chats.get(sessionId);
      const item = state?.items.find((candidate) => candidate.id === id);
      if (!item) return undefined;
      state.items = [item, ...state.items.filter((candidate) => candidate !== item)];
      state.paused = null;
      if (afterCancel) state.resumeAfterCancel = true;
      changed(sessionId);
      return item;
    },

    clear(sessionId) {
      if (!chats.has(sessionId)) return;
      chats.delete(sessionId);
      onChange(sessionId);
    },

    pause(sessionId, stopReason) {
      const state = chats.get(sessionId);
      if (!state?.items.length) return;
      state.paused = { stopReason: stopReason ?? null };
      state.resumeAfterCancel = false;
      changed(sessionId);
    },

    resume(sessionId) {
      const state = chats.get(sessionId);
      if (!state?.paused) return;
      state.paused = null;
      changed(sessionId);
    },

    /** Whether a prompt waits to go. */
    ready(sessionId) {
      const state = chats.get(sessionId);
      return Boolean(state?.items.length) && !state.paused;
    },

    /** The next prompt, off the queue. */
    next(sessionId) {
      const state = chats.get(sessionId);
      const item = state?.items.shift();
      // It goes now: a cancel asked for it has nothing left to wait for.
      if (item) state.resumeAfterCancel = false;
      if (item) changed(sessionId);
      return item;
    },

    /** A turn of the chat ended: whether the next prompt goes, else the queue pauses. */
    turnEnded(sessionId, stopReason) {
      const state = chats.get(sessionId);
      if (!state) return false;
      const asked = state.resumeAfterCancel;
      state.resumeAfterCancel = false;
      if (!state.items.length) {
        settle(sessionId);
        return false;
      }
      if (state.paused) return false;
      if (stopReason === 'end_turn' || asked) return true;
      state.paused = { stopReason: stopReason ?? null };
      changed(sessionId);
      return false;
    },

    /** What the windows show: the prompts without what the agent gets, and whether it is paused. */
    snapshot(sessionId) {
      const state = chats.get(sessionId);
      return {
        items: (state?.items ?? []).map(({ id, title, editable, action }) => ({
          id,
          title,
          ...(editable ? { editable } : {}),
          ...(action ? { action } : {})
        })),
        ...(state?.paused ? { paused: state.paused } : {})
      };
    },

    sessions() {
      return [...chats.keys()];
    }
  };
}

const blocks = (value, name) => {
  if (!Array.isArray(value) || !value.length || value.some((block) => !block || typeof block !== 'object' || typeof block.type !== 'string')) {
    throw new TypeError(`${name} must be a list of content blocks`);
  }
  return value;
};

/**
 * A queued prompt from a window, checked: the blocks the agent gets, those it
 * gets instead in the running turn (`steer`, for send now where the agent takes
 * messages while it works; without them it never goes that way), and what the
 * queue shows.
 */
export function queuedPromptOf(params) {
  const prompt = blocks(params?.prompt, 'prompt');
  const steer = params.steer === undefined ? undefined : blocks(params.steer, 'steer');
  if (JSON.stringify([prompt, steer]).length > MAX_QUEUED_BYTES) throw new RangeError('The prompt is too large to queue');
  const text = typeof params.text === 'string' ? params.text : prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n');
  const title = typeof params.title === 'string' && params.title ? params.title.slice(0, 500) : text.slice(0, 500);
  const action =
    params.action && typeof params.action === 'object' && typeof params.action.id === 'string'
      ? { id: params.action.id, title: typeof params.action.title === 'string' ? params.action.title : params.action.id }
      : undefined;
  return { prompt, ...(steer ? { steer } : {}), text, title, editable: params.editable === true, ...(action ? { action } : {}) };
}
