// Which chats have a turn running and which wait for the user, read from the
// ACP traffic the bridge relays. Only states and counts leave the bridge, never
// what the chats say.

const PLAN_KIND = 'switch_mode';
const MAX_TOOL_KINDS = 500;

export function createActivity(onChange = () => {}) {
  // Turn request id -> session id.
  const turns = new Map();
  // Agent request id -> { sessionId, waitingFor }.
  const requests = new Map();
  // Session id -> tool call id -> kind, from tool_call updates: a permission
  // request may name only the tool call (plan approval is kind switch_mode).
  const toolKinds = new Map();

  const kindOf = (sessionId, toolCall) =>
    toolCall?.kind ?? toolKinds.get(sessionId)?.get(toolCall?.toolCallId);

  return {
    turnStarted(id, sessionId) {
      turns.set(id, sessionId);
      onChange();
    },

    turnEnded(id) {
      const sessionId = turns.get(id);
      if (sessionId === undefined) return;
      turns.delete(id);
      if (![...turns.values()].includes(sessionId)) toolKinds.delete(sessionId);
      onChange();
    },

    toolCall(sessionId, update) {
      if (typeof update?.toolCallId !== 'string' || typeof update.kind !== 'string') return;
      let kinds = toolKinds.get(sessionId);
      if (!kinds) toolKinds.set(sessionId, (kinds = new Map()));
      if (kinds.size >= MAX_TOOL_KINDS) kinds.delete(kinds.keys().next().value);
      kinds.set(update.toolCallId, update.kind);
    },

    permission(id, sessionId, toolCall) {
      requests.set(id, { sessionId, waitingFor: kindOf(sessionId, toolCall) === PLAN_KIND ? 'plan' : 'permission' });
      onChange();
    },

    question(id, sessionId) {
      requests.set(id, { sessionId, waitingFor: 'question' });
      onChange();
    },

    answered(id) {
      if (requests.delete(id)) onChange();
    },

    busy(sessionId) {
      return [...turns.values()].includes(sessionId);
    },

    get running() {
      return turns.size > 0;
    },

    clear() {
      turns.clear();
      requests.clear();
      toolKinds.clear();
      onChange();
    },

    /** Chats with a turn running or a request for the user, by session id. */
    snapshot() {
      const chats = new Map();
      for (const sessionId of turns.values()) chats.set(sessionId, { sessionId, state: 'working' });
      for (const { sessionId, waitingFor } of requests.values()) {
        if (typeof sessionId !== 'string') continue;
        if (chats.get(sessionId)?.state !== 'waiting') chats.set(sessionId, { sessionId, state: 'waiting', waitingFor });
      }
      const list = [...chats.values()];
      return {
        chats: list,
        working: list.filter((chat) => chat.state === 'working').length,
        waiting: list.filter((chat) => chat.state === 'waiting').length
      };
    }
  };
}
