// Codex through its ACP adapter (which runs `codex app-server`).
//
// Known upstream: Stop (`session/cancel`) ends the turn as cancelled, but a
// command Codex was running keeps going (seen with codex-acp 2.3.0, Codex
// 0.164: `sleep 90` still ran after Stop). It is Codex's, not the adapter's:
// https://github.com/openai/codex/issues/42717 (a stopped sub-agent's command
// too: https://github.com/openai/codex/issues/57863). The bridge does not kill
// the turn's processes itself, as it cannot tell them from those the agent
// leaves running on purpose. Check those issues when updating Codex.
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, InvalidRequest, newestFile, readJson, readText, writePrivate } from '../support.js';
import { watchEvents } from './events.js';

const PROXY = join(dirname(fileURLToPath(import.meta.url)), 'proxy.js');
const READY_MS = 30_000;

export default function codex({ descriptor, home, nodePath, modules }) {
  const codexCommand = modules ? [nodePath, join(modules, '@openai/codex/bin/codex.js')] : undefined;
  // One app-server for the worker, on a Unix socket in the container's own
  // /tmp: the adapter reaches it through proxy.js (CODEX_PATH), and the
  // terminal UI with --remote, so both follow the same chats live. Codex
  // lets only one app-server write a chat.
  const env = { ...descriptor?.env };
  let socketPath;
  return {
    env,
    companion: codexCommand
      ? async () => {
          socketPath = join(tmpdir(), `codeflower-codex-${randomBytes(6).toString('hex')}.sock`);
          env.CODEX_PATH = PROXY;
          env.CODEFLOWER_CODEX_SOCKET = socketPath;
          return { command: [...codexCommand, 'app-server', '--listen', `unix://${socketPath}`], ready: () => listening(socketPath) };
        }
      : undefined,
    // Its terminal UI on a chat, on the shared app-server. It would offer to
    // update itself first, which the image's copy cannot.
    tuiCommand: codexCommand
      ? async ({ sessionId }) => {
          if (!socketPath) throw new Error('Codex is not running');
          return [...codexCommand, '-c', 'check_for_update_on_startup=false', '--remote', `unix://${socketPath}`, 'resume', sessionId];
        }
      : undefined,
    // `codeflower tui`: its terminal UI alone, with an app-server of its own.
    soloCommand: codexCommand
      ? async ({ resume }) => [
          ...codexCommand,
          '-c',
          'check_for_update_on_startup=false',
          ...(resume === 'last' ? ['resume', '--last'] : resume === 'pick' ? ['resume'] : resume ? ['resume', resume] : [])
        ]
      : undefined,
    // The chat its terminal UI wrote last: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl.
    async lastSession({ since }) {
      if (!home) return undefined;
      const file = await newestFile(join(home, 'sessions'), /^rollout-.*\.jsonl$/, { since, deep: true });
      return file?.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1];
    },
    // The user's messages typed in the terminal UI, and its turns (events.js).
    watch: codexCommand
      ? ({ emit, log }) => (socketPath ? watchEvents({ socketPath, emit, log }) : () => {})
      : undefined,
    async signedIn() {
      return Boolean(home) && (await exists(join(home, 'auth.json')));
    },
    // Until the agent reports its login (`_auth/status_update`).
    async authKind() {
      if (!home) return undefined;
      let auth;
      try {
        auth = JSON.parse(await readText(join(home, 'auth.json')));
      } catch {
        return undefined;
      }
      if (auth?.auth_mode === 'apikey' || (auth?.OPENAI_API_KEY && !auth?.tokens)) return 'api_key';
      return auth?.tokens ? 'subscription' : undefined;
    },
    // The app config's key goes into Codex's own auth.json, as its
    // API-key login does. A subscription login is kept.
    async provideKey(key) {
      if (!home) throw new InvalidRequest('CODEX_HOME is not set');
      const file = join(home, 'auth.json');
      const auth = await readJson(file);
      if (auth?.tokens) return 'kept the existing subscription login';
      if (auth?.OPENAI_API_KEY === key) return undefined;
      await writePrivate(file, `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }, null, 2)}\n`);
      return undefined;
    },
    // `codex` itself reads the account's rate limits, which its adapter does not pass on.
    limitsCommand: modules ? () => [nodePath, join(modules, '@openai/codex/bin/codex.js'), 'app-server'] : undefined
  };
}

// Waits until the app-server takes connections on its socket.
async function listening(socketPath) {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Codex's app-server did not start listening on ${socketPath}`);
}
