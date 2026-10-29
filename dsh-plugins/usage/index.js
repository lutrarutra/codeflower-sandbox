import { writeSync } from 'node:fs';

// Reports the token counts of each model call to the code flower bridge: dsh's
// ACP app sends only how full the context is. One JSON line per call goes to
// the file descriptor in CODEFLOWER_USAGE_FD, as stdout belongs to ACP.

export const name = 'codeflower-usage';

export function apply(ctx) {
  const fd = Number(process.env.CODEFLOWER_USAGE_FD);
  if (!Number.isInteger(fd) || fd < 3) return;
  let broken = false;
  // Fires for new events only, not for those a resumed session loads.
  ctx.on('session/event', (session, event) => {
    const usage = event?.type === 'assistant/message' ? event.data?.usage : undefined;
    if (broken || !usage) return;
    const { id, parentSession } = session.header;
    try {
      writeSync(fd, `${JSON.stringify({ sessionId: id, ...(parentSession ? { parentSessionId: parentSession } : {}), usage })}\n`);
    } catch {
      // The bridge went away; dsh keeps working without it.
      broken = true;
    }
  });
}
