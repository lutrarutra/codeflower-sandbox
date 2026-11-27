// Stops one of Claude Code's subagents: a `session/cancel` with the child's
// session id. The adapter stops a child that way only in the subagents RFD
// form (`cancelChildSession`), but code flower is an AIR client (for its async
// tasks, index.js), which gets AIR's draft form, and the draft grants no
// cancel. So the chat's Stop on a subagent did nothing. This stops the child's
// task (`query.stopTask`) the way the RFD form does, in the draft form too.
//
// This reaches into the adapter's own state (`sessions`, a session's `query`
// and `nativeSubagentRuntime.children`, task id -> child generation), as of
// @agentclientprotocol/claude-agent-acp 0.110.1: check it again when
// sandbox/package.json moves the adapter. Whatever is missing leaves the
// adapter's own cancel.

/** The running child generation with the session id, and its task, in one of the agent's sessions. */
function runningChild(agent, sessionId) {
  for (const session of Object.values(agent.sessions ?? {})) {
    const children = session?.nativeSubagentRuntime?.children;
    if (!(children instanceof Map) || typeof session.query?.stopTask !== 'function') continue;
    for (const [taskId, child] of children) {
      if (child?.sessionId === sessionId && child.terminalState === undefined) return { session, taskId, child };
    }
  }
  return undefined;
}

/**
 * Wraps the adapter's `cancelChildSession` so a draft-form child stops too.
 * Returns false when the adapter has none to wrap.
 */
export function patchSubagentCancel(AgentClass, log = (message) => process.stderr.write(`${message}\n`)) {
  const cancelChildSession = AgentClass?.prototype?.cancelChildSession;
  if (typeof cancelChildSession !== 'function') {
    log('codeflower: the Claude adapter has no cancelChildSession to wrap; a subagent cannot be stopped on its own');
    return false;
  }
  AgentClass.prototype.cancelChildSession = async function cancelChildInAnyForm(sessionId) {
    if (await cancelChildSession.call(this, sessionId)) return true;
    const found = runningChild(this, sessionId);
    if (!found) return false;
    // As the RFD form counts it: the child's end then reads as cancelled.
    found.child.cancels = (found.child.cancels ?? 0) + 1;
    await found.session.query.stopTask(found.taskId).catch((error) => {
      log(`codeflower: could not stop the subagent ${sessionId}: ${error?.message ?? error}`);
    });
    return true;
  };
  return true;
}
