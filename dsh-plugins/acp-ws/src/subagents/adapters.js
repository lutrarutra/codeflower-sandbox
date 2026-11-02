// How an agent shows its subagents, turned into the one form the bridge and
// the windows understand: ACP's subagents RFD (`subagent_update` on the
// parent, `session_message` between parent and child, and the child's own
// updates under its session id). An agent names its adapter in agent.json
// (`subagents.adapter`); its index.js may replace any part (`subagents`).
//
// An adapter:
//   clientCapabilities   merged into every initialize the agent gets
//   translate(update, sessionId)
//                        the canonical updates for one of the agent's, as
//                        [{ sessionId, update }] ([] drops it), or undefined
//                        to relay it as it is
//   cancel(childId, summary)
//                        the ACP notification that stops a child, or undefined
//                        when the agent cannot
//   watch({ emit, log }) optional: canonical updates from outside ACP (an event
//                        stream, a plugin's pipe); returns a stop function
//   attach(childId, { request })
//                        optional: what makes a child's updates flow once a
//                        window opens it (e.g. a session/load)

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The ACP subagents RFD itself: nothing to translate. */
export function acpRfd() {
  return {
    clientCapabilities: { subagents: {} },
    translate: () => undefined,
    // A child stops like a chat, when the agent granted it (`capabilities.cancel`).
    cancel: (childId, summary) =>
      summary?.capabilities?.cancel ? { method: 'session/cancel', params: { sessionId: childId } } : undefined
  };
}

// The end states of the draft's `subagent_state_update`, as RFD states.
const DRAFT_STATES = {
  completed: { state: 'idle', stopReason: 'end_turn' },
  failed: { state: 'idle', stopReason: 'error' },
  cancelled: { state: 'idle', stopReason: 'cancelled' },
  disconnected: { state: 'unknown' }
};

/**
 * The draft the RFD grew from (JetBrains AIR): `subagent_spawned` with the
 * child's name and task, and `subagent_state_update` with its end.
 */
export function airDraft() {
  return {
    ...acpRfd(),
    translate(update, sessionId) {
      if (!object(update) || typeof update.subagentSessionId !== 'string') return undefined;
      const childId = update.subagentSessionId;
      if (update.sessionUpdate === 'subagent_spawned') {
        const task = typeof update.task === 'string' ? update.task : '';
        const canonical = [
          {
            sessionId,
            update: {
              sessionUpdate: 'subagent_update',
              sessionId: childId,
              ...(typeof update.name === 'string' ? { title: update.name } : {}),
              ...(object(update.capabilities) ? { capabilities: update.capabilities } : {}),
              state: { state: 'running' }
            }
          }
        ];
        // The task is the child's first message, from its parent.
        if (task) {
          const message = { messageId: `${childId}:task`, senderSessionId: sessionId, recipientSessionId: childId, content: [{ type: 'text', text: task }] };
          canonical.push(
            { sessionId, update: { sessionUpdate: 'session_message', ...message } },
            { sessionId: childId, update: { sessionUpdate: 'session_message', ...message } }
          );
        }
        return canonical;
      }
      if (update.sessionUpdate === 'subagent_state_update') {
        const state = DRAFT_STATES[update.state] ?? { state: 'unknown' };
        return [{ sessionId, update: { sessionUpdate: 'subagent_update', sessionId: childId, state } }];
      }
      return undefined;
    }
  };
}

const ADAPTERS = { 'acp-rfd': acpRfd, 'air-draft': airDraft };

const REPORT_USAGE = ['none', 'context', 'tokens', 'cost'];

/** What the windows learn of an agent's subagents: what it reports, and which settings it takes. */
export function subagentFeatures(spec) {
  const reports = object(spec?.reports) ? spec.reports : {};
  const settings = {};
  for (const name of ['model', 'effort']) {
    const setting = spec?.settings?.[name];
    if (object(setting)) settings[name] = { applies: setting.applies === 'session' ? 'session' : 'restart' };
  }
  return {
    reports: {
      model: reports.model === true,
      effort: reports.effort === true,
      usage: REPORT_USAGE.includes(reports.usage) ? reports.usage : 'none',
      result: reports.result === true
    },
    settings
  };
}

/**
 * The adapter for an agent's `subagents` descriptor, with its index.js's
 * parts on top; undefined for an agent without subagents.
 */
export function createSubagentAdapter(spec, overrides) {
  if (!object(spec) && !object(overrides)) return undefined;
  const name = spec?.adapter ?? 'acp-rfd';
  const make = ADAPTERS[name];
  if (!make) throw new Error(`Unknown subagents adapter: ${name}`);
  return { ...make(spec), ...overrides, spec: spec ?? {}, features: subagentFeatures(spec) };
}
