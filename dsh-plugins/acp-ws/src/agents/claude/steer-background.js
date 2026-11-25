// A message steered into Claude Code's running turn (ACP steering,
// `_session/steering`) first moves its foreground work to the background, the
// way Ctrl+B does in its terminal UI, so a command or subagent it is running
// keeps going instead of being cut off. The adapter adds the message with
// priority `now`, which breaks into the current step and ends a foreground
// Bash command with it; the SDK's `query.backgroundTasks()` makes each such
// tool call return "running in the background" first. The agent is told, so it
// can stop the task if the message asks for that.
//
// This reaches into the adapter's own state (`sessions`, a session's `query`,
// `turnQueue` and `openUserInputs`), as of @agentclientprotocol/claude-agent-acp
// 0.110.1: check it again when sandbox/package.json moves the adapter. Whatever
// is missing leaves steering as the adapter does it.

/** Marks a block of the client's own before the user's message; windows hide it. */
const STEER_NOTE_META = 'codeflower/steerNote';

export const BACKGROUND_NOTE =
  'A command or subagent you were running in the foreground, if any, has been moved to the background so you ' +
  'could read this message, and is still running: its result says so. Stop it if this message makes it ' +
  'unnecessary; otherwise wait for it as usual.';

/** Whether the adapter would put a steer into this session's running turn now. */
function steersIntoRunningTurn(session) {
  if (!Array.isArray(session?.turnQueue) || !session.turnQueue.some((turn) => !turn.settled)) return false;
  // An open permission request or question settles first (the adapter's `later`):
  // nothing runs that could be moved.
  return !(session.openUserInputs?.size > 0);
}

/**
 * Wraps the adapter's `steer` so foreground work goes to the background first.
 * Returns false when the adapter has no `steer` to wrap.
 */
export function patchSteer(AgentClass, log = (message) => process.stderr.write(`${message}\n`)) {
  const steer = AgentClass?.prototype?.steer;
  if (typeof steer !== 'function') {
    log('codeflower: the Claude adapter has no steer to wrap; steering cuts off foreground commands');
    return false;
  }
  AgentClass.prototype.steer = async function steerAfterBackgrounding(params) {
    const session = this.sessions?.[params?.sessionId];
    if (steersIntoRunningTurn(session) && typeof session.query?.backgroundTasks === 'function') {
      try {
        await session.query.backgroundTasks();
        params = {
          ...params,
          prompt: [{ type: 'text', text: BACKGROUND_NOTE, _meta: { [STEER_NOTE_META]: true } }, ...params.prompt]
        };
      } catch (error) {
        // Background tasks turned off (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) or a
        // CLI without them: the message breaks in as before.
        log(`codeflower: could not move foreground work to the background: ${error?.message ?? error}`);
      }
    }
    return steer.call(this, params);
  };
  return true;
}
