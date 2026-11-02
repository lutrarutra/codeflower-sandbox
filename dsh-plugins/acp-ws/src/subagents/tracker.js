// The subagents of the chats an agent runs, from the canonical updates
// (adapters.js): which session is whose child, and a summary of each that
// the parent's windows show without loading the child's chat.
//
// A summary: { sessionId, parentId, title, description, prompt, state,
// stopReason, error, capabilities, startedAt, endedAt, model, effort, usage,
// lastMessage }.

const LAST_MESSAGE = 400;
const PROMPT = 2000;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (content) =>
  (Array.isArray(content) ? content : [content])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');

// The chosen value of a session setting, by its ACP category (or id), as its name.
const chosen = (options, category) => {
  const option = options.find((candidate) => candidate?.category === category) ?? options.find((candidate) => candidate?.id === category);
  if (!option || option.currentValue === undefined) return undefined;
  const values = (Array.isArray(option.options) ? option.options : []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]));
  const value = values.find((entry) => entry?.value === option.currentValue);
  return {
    value: String(option.currentValue),
    ...(typeof value?.name === 'string' ? { name: value.name } : {}),
    // E.g. "Default (recommended)", which names its model here.
    ...(typeof value?.description === 'string' && value.description ? { description: value.description } : {})
  };
};

export function createSubagentTracker({ onChange = () => {}, now = () => new Date() } = {}) {
  // By child: its summary, which carries its parent.
  const children = new Map();
  // Per child: whether its last update was its message, so chunks add up.
  const speaking = new Set();

  const changed = (summary) => onChange(summary);

  const register = (parentId, childId) => {
    let summary = children.get(childId);
    if (!summary) {
      summary = { sessionId: childId, parentId, state: 'running', startedAt: now().toISOString() };
      children.set(childId, summary);
    }
    return summary;
  };

  // What a parent's updates say of its children.
  const fromParent = (parentId, update) => {
    if (update.sessionUpdate === 'subagent_update' && typeof update.sessionId === 'string') {
      const summary = register(parentId, update.sessionId);
      if (typeof update.title === 'string') summary.title = update.title;
      if (typeof update.description === 'string') summary.description = update.description;
      if (object(update.capabilities)) summary.capabilities = update.capabilities;
      const state = object(update.state) ? update.state : undefined;
      if (typeof state?.state === 'string') {
        const wasRunning = summary.state === 'running' || summary.state === 'requires_action';
        summary.state = state.state;
        if (state.state === 'running' || state.state === 'requires_action') {
          // Resumed: it works again under the same id.
          if (!wasRunning) delete summary.endedAt;
          delete summary.stopReason;
          delete summary.error;
        } else {
          summary.endedAt ??= now().toISOString();
          if (typeof state.stopReason === 'string') summary.stopReason = state.stopReason;
          if (object(state.error) && typeof state.error.message === 'string') summary.error = state.error.message;
          if (object(state.usage)) summary.usage = { ...summary.usage, tokens: state.usage };
        }
      }
      changed(summary);
      return summary.sessionId;
    }
    if (update.sessionUpdate === 'session_message') {
      // The parent's message to a child (its task), or a child's reply.
      const toChild = children.get(update.recipientSessionId);
      if (toChild && update.senderSessionId === parentId && toChild.prompt === undefined) {
        toChild.prompt = text(update.content).slice(0, PROMPT);
        changed(toChild);
      }
      const fromChild = children.get(update.senderSessionId);
      if (fromChild && update.recipientSessionId === parentId) {
        const reply = text(update.content);
        if (reply) {
          fromChild.lastMessage = reply.slice(0, LAST_MESSAGE);
          changed(fromChild);
        }
      }
    }
    return undefined;
  };

  // What a child's own updates say of it.
  const fromChild = (summary, update) => {
    const kind = update.sessionUpdate;
    if (kind !== 'agent_message_chunk') speaking.delete(summary.sessionId);
    if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
      const model = chosen(update.configOptions, 'model');
      const effort = chosen(update.configOptions, 'thought_level');
      if (model) summary.model = model;
      if (effort) summary.effort = effort;
      if (model || effort) changed(summary);
    } else if (kind === 'usage_update') {
      const usage = { ...summary.usage };
      if (Number.isFinite(update.used) && Number.isFinite(update.size)) usage.context = { used: update.used, size: update.size };
      if (object(update.cost) && Number.isFinite(update.cost.amount)) usage.cost = { amount: update.cost.amount, currency: update.cost.currency };
      summary.usage = usage;
      changed(summary);
    } else if (kind === 'agent_message_chunk') {
      const chunk = text(update.content);
      if (!chunk) return;
      const before = speaking.has(summary.sessionId) ? (summary.lastMessage ?? '') : '';
      speaking.add(summary.sessionId);
      summary.lastMessage = `${before}${chunk}`.slice(-LAST_MESSAGE);
      changed(summary);
    }
  };

  return {
    /**
     * One canonical update of `sessionId`. Returns the id of a child it
     * announced for the first time, so the bridge starts recording it.
     */
    observe(sessionId, update) {
      if (typeof sessionId !== 'string' || !object(update)) return undefined;
      const known = children.has(update.sessionId);
      const child = children.get(sessionId);
      if (child) fromChild(child, update);
      const announced = fromParent(sessionId, update);
      return announced !== undefined && !known ? announced : undefined;
    },

    isChild: (sessionId) => children.has(sessionId),
    parentOf: (sessionId) => children.get(sessionId)?.parentId,

    /** The chain of parents above a child, nearest first. */
    ancestors(sessionId) {
      const chain = [];
      let parent = children.get(sessionId)?.parentId;
      while (parent !== undefined && !chain.includes(parent)) {
        chain.push(parent);
        parent = children.get(parent)?.parentId;
      }
      return chain;
    },

    /** The top chat above a child, or the session itself. */
    rootOf(sessionId) {
      return this.ancestors(sessionId).at(-1) ?? sessionId;
    },

    summary: (sessionId) => {
      const summary = children.get(sessionId);
      return summary ? structuredClone(summary) : undefined;
    },

    /** The children of a chat, the earliest first. */
    childrenOf(parentId) {
      return [...children.values()].filter((summary) => summary.parentId === parentId).map((summary) => structuredClone(summary));
    },

    /** A child the bridge knows from its record, e.g. after a restart. */
    restore(summary) {
      if (!object(summary) || typeof summary.sessionId !== 'string' || children.has(summary.sessionId)) return;
      children.set(summary.sessionId, structuredClone(summary));
    },

    /** Forgets a chat's children, e.g. when it is deleted. */
    forget(parentId) {
      for (const [childId, summary] of children) {
        if (summary.parentId === parentId) {
          children.delete(childId);
          speaking.delete(childId);
          this.forget(childId);
        }
      }
    }
  };
}
