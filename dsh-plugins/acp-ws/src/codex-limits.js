import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Codex's adapter keeps the account's rate limits to itself, so the bridge asks
// a short-lived `codex app-server` of its own, with the same login, through
// app-server's public `account/rateLimits/read`. It never touches a chat.

const TIMEOUT_MS = 15_000;

export function readCodexLimits(command, env, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server did not answer in time')), timeoutMs);
    const request = (method, params) =>
      new Promise((answer, fail) => {
        const id = nextId++;
        pending.set(id, { answer, fail });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
      });

    child.once('error', (error) => finish(error));
    child.once('close', () => finish(new Error('codex app-server ended before answering')));
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = message?.method === undefined ? pending.get(message?.id) : undefined;
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.fail(new Error(message.error.message ?? 'codex app-server refused'));
      else waiter.answer(message.result);
    });

    void (async () => {
      await request('initialize', {
        clientInfo: { name: 'codeflower', title: 'code flower', version: '1' },
        capabilities: { experimentalApi: true }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      return request('account/rateLimits/read');
    })().then(
      (result) => finish(undefined, result),
      (error) => finish(error)
    );
  });
}
