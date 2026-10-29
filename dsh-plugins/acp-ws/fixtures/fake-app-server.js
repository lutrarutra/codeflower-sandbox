import { createInterface } from 'node:readline';

// Codex's app-server, as far as the bridge's rate limit reads use it. Answers
// only after the client said it is `initialized`, like the real one.

let initialized = false;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME ?? null } });
      // Notifications come unasked, as from the real server.
      send({ method: 'configWarning', params: { summary: 'ignored' } });
      break;
    case 'initialized':
      initialized = true;
      break;
    case 'account/rateLimits/read':
      if (!initialized) {
        send({ id: message.id, error: { code: -32600, message: 'not initialized' } });
      } else if (process.argv.includes('--signed-out')) {
        send({ id: message.id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } });
      } else if (!process.argv.includes('--hang')) {
        send({
          id: message.id,
          result: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1800000000 },
              secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1800500000 },
              credits: { hasCredits: false, unlimited: false, balance: null },
              planType: 'plus'
            },
            rateLimitsByLimitId: null
          }
        });
      }
      break;
  }
});
