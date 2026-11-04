// Which chats have a turn running and which wait for the user, read from the
// ACP traffic the bridge relays. Only states and counts leave the bridge, never
// what the chats say.

const PLAN_KIND = 'switch_mode';
const MAX_TOOL_KINDS = 500;
// Ended turns are kept a minute for pollers (the client's notifications),
// the latest 20 at most.
const MAX_ENDED = 20;
const ENDED_MS = 60_000;

export function createActivity(onChange = () => {}, now = Date.now) {
  // Turn request id -> session id.
  const turns = new Map();
  // Agent request id -> { sessionId, waitingFor }.
  const requests = new Map();
  // Session id -> tool call id -> kind, from tool_call updates: a permission
  // request may name only the tool call (plan approval is kind switch_mode).
  const toolKinds = new Map();
  // { seq, sessionId, stopReason, at } of the latest ended turns; seq only goes up.
  const ended = [];
  let turnCount = 0;

  const kindOf = (sessionId, toolCall) =>
    toolCall?.kind ?? toolKinds.get(sessionId)?.get(toolCall?.toolCallId);

  return {
    turnStarted(id, sessionId) {
      turns.set(id, sessionId);
      onChange();
    },

    // stopReason: the prompt's (end_turn, cancelled, …), or 'error'.
    turnEnded(id, stopReason = null) {
      const sessionId = turns.get(id);
      if (sessionId === undefined) return;
      turns.delete(id);
      ended.push({ seq: ++turnCount, sessionId, stopReason, at: now() });
      if (ended.length > MAX_ENDED) ended.shift();
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
      requests.set(id, { sessionId, waitingFor: this.isPlan(sessionId, toolCall) ? 'plan' : 'permission' });
      onChange();
    },

    // Whether a permission request asks to approve a plan.
    isPlan(sessionId, toolCall) {
      return kindOf(sessionId, toolCall) === PLAN_KIND;
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

    /** Whether a turn runs whose id `belongs` takes. */
    runningWhere(belongs) {
      return [...turns.keys()].some(belongs);
    },

    // Ended turns stay: a poller would otherwise see them again. `belongs`
    // picks what goes by turn or request id and by session id.
    clear(belongs = () => true) {
      for (const id of turns.keys()) if (belongs(id)) turns.delete(id);
      for (const id of requests.keys()) if (belongs(id)) requests.delete(id);
      for (const sessionId of toolKinds.keys()) if (belongs(sessionId)) toolKinds.delete(sessionId);
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
        waiting: list.filter((chat) => chat.state === 'waiting').length,
        ended: ended.filter((turn) => now() - turn.at < ENDED_MS).map(({ at: _, ...turn }) => turn),
        turns: turnCount
      };
    }
  };
}

// One agent's view of the worker's activity. Agents of one worker may use the
// same ids (two can each have a session-1), so the agent's session ids and
// turn and request ids go in under its name; its snapshot has its own again.
const SCOPE = '\n';

export function scopedActivity(activity, agent) {
  const prefix = `${agent}${SCOPE}`;
  const scoped = (id) => (typeof id === 'string' ? `${prefix}${id}` : id);
  const mine = (id) => typeof id === 'string' && id.startsWith(prefix);
  const own = (id) => id.slice(prefix.length);
  return {
    turnStarted: (id, sessionId) => activity.turnStarted(scoped(id), scoped(sessionId)),
    turnEnded: (id, stopReason) => activity.turnEnded(scoped(id), stopReason),
    toolCall: (sessionId, update) => activity.toolCall(scoped(sessionId), update),
    permission: (id, sessionId, toolCall) => activity.permission(scoped(id), scoped(sessionId), toolCall),
    isPlan: (sessionId, toolCall) => activity.isPlan(scoped(sessionId), toolCall),
    question: (id, sessionId) => activity.question(scoped(id), scoped(sessionId)),
    answered: (id) => activity.answered(scoped(id)),
    busy: (sessionId) => activity.busy(scoped(sessionId)),
    get running() {
      return activity.runningWhere(mine);
    },
    clear: () => activity.clear(mine),
    snapshot() {
      const { chats, ended, turns } = activity.snapshot();
      const ours = chats.filter((chat) => mine(chat.sessionId)).map((chat) => ({ ...chat, sessionId: own(chat.sessionId) }));
      return {
        chats: ours,
        working: ours.filter((chat) => chat.state === 'working').length,
        waiting: ours.filter((chat) => chat.state === 'waiting').length,
        ended: ended.filter((turn) => mine(turn.sessionId)).map((turn) => ({ ...turn, sessionId: own(turn.sessionId) })),
        turns
      };
    }
  };
}

/** A session id of the worker's activity, back as [agent, its own session id]. */
export function unscope(sessionId) {
  const at = sessionId.indexOf(SCOPE);
  return [sessionId.slice(0, at), sessionId.slice(at + SCOPE.length)];
}
