// OpenCode, which speaks ACP itself (`opencode acp`). It is a native binary,
// not a Node script: the image links this machine's build as
// node_modules/.bin/opencode, which also puts `opencode` on the PATH for its
// sign-in command (`opencode auth login`).
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exists, readText } from '../support.js';
import { watchEvents } from './events.js';

const DATABASE = 'opencode.db';
const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];
const SERVER_HOST = '127.0.0.1';

export default function opencode({ descriptor, home, launch, nodePath }) {
  // Its logins and sessions are in one SQLite database, which goes into its
  // home with its config; the rest of its data stays in HOME.
  const env = { ...descriptor.env, ...(home ? { OPENCODE_DB: join(home, DATABASE) } : {}) };
  // `opencode acp` serves OpenCode's own API beside ACP. The bridge picks its
  // port and password, so the terminal UI (`opencode attach`) joins the same
  // server and both show the same chats live.
  let server;
  const run = (...args) => (launch.endsWith('.js') ? [nodePath, launch, ...args] : [launch, ...args]);
  return {
    // Tests start a fake agent script in its place.
    async command() {
      server = { url: `http://${SERVER_HOST}:${await freePort()}`, password: randomBytes(24).toString('base64url') };
      env.OPENCODE_SERVER_PASSWORD = server.password;
      return run('acp', '--hostname', SERVER_HOST, '--port', new URL(server.url).port);
    },
    env,
    // The terminal UI on a chat, attached to the agent's server.
    async tuiCommand({ sessionId, cwd }) {
      if (!server) throw new Error('OpenCode is not running');
      return run('attach', server.url, '--session', sessionId, ...(cwd ? ['--dir', cwd] : []));
    },
    // `codeflower tui`: its terminal UI alone, with a server of its own. It
    // lists its sessions itself (pick), so only the last or a named one is opened.
    async soloCommand({ resume }) {
      return run(...(resume === 'last' ? ['--continue'] : resume && resume !== 'pick' ? ['--session', resume] : []));
    },
    // What ACP leaves out of turns started in the terminal UI: the user's
    // message, busy and idle, and permissions answered there (events.js).
    watch({ emit, log }) {
      if (!server) return () => {};
      return watchEvents({ ...server, emit, log });
    },
    // A key alone does not say whose it is, among OpenCode's providers.
    async provideKey() {
      return "OpenCode needs to know the key's provider: sign in from the chat (Sign in…) instead";
    },
    // A login or key it stored, or a provider of the user's own in its config
    // (e.g. vLLM on the cluster), which may need neither.
    async signedIn() {
      if (!home) return false;
      return (await storedCredential(join(home, DATABASE))) || (await configuredProvider(home));
    }
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, SERVER_HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function storedCredential(file) {
  if (!(await exists(file))) return false;
  const { DatabaseSync } = await importSqlite();
  try {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      return Boolean(database.prepare('SELECT 1 FROM credential LIMIT 1').get());
    } finally {
      database.close();
    }
  } catch {
    // Not migrated yet, or a schema of another version: no login to go by.
    return false;
  }
}

// Loaded only here, without the warning Node 22 prints the first time that
// node:sqlite is experimental, which would read as a problem in the worker's log.
async function importSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning?.message ?? warning).includes('SQLite')) emitWarning.call(process, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

async function configuredProvider(home) {
  for (const name of CONFIG_FILES) {
    if (/"provider"\s*:/.test(await readText(join(home, name)))) return true;
  }
  return false;
}
