// OpenCode, which speaks ACP itself (`opencode acp`). It is a native binary,
// not a Node script: the image links this machine's build as
// node_modules/.bin/opencode, which also puts `opencode` on the PATH for its
// sign-in command (`opencode auth login`).
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exists, readText, writePrivate } from '../support.js';
import { watchEvents } from './events.js';

const DATABASE = 'opencode.db';
// The model chosen for each mode (OpenCode's agents), in a config of code
// flower's own that OpenCode merges under the user's (OPENCODE_CONFIG).
const MODE_MODELS = 'codeflower-models.json';
// The agent OpenCode starts a chat in, unless the config names another.
const DEFAULT_MODE = 'build';
const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];
const SERVER_HOST = '127.0.0.1';

export default function opencode({ descriptor, home, launch, nodePath, environment = {} }) {
  // Its sessions are in one SQLite database, which goes into its home with its
  // config; the rest of its data stays in HOME, including the keys that
  // `opencode auth login` saves (auth.json).
  const dataHome = environment.XDG_DATA_HOME || (environment.HOME ? join(environment.HOME, '.local', 'share') : undefined);
  const authFile = dataHome ? join(dataHome, 'opencode', 'auth.json') : undefined;
  const env = { ...descriptor.env, ...(home ? { OPENCODE_DB: join(home, DATABASE), OPENCODE_CONFIG: join(home, MODE_MODELS) } : {}) };
  const modeModels = home ? join(home, MODE_MODELS) : undefined;
  // One change of the file at a time, so none is lost.
  let modeModelsQueue = Promise.resolve();
  // `opencode acp` serves OpenCode's own API beside ACP. The bridge picks its
  // port and password, so the terminal UI (`opencode attach`) joins the same
  // server and both show the same chats live.
  let server;
  // What a change of setting means for the models saved by mode (followSetting).
  async function followMode({ configId, value, configOptions }) {
    if (!modeModels || typeof value !== 'string') return undefined;
    const model = configOptions.find((option) => option?.category === 'model');
    const mode = configOptions.find((option) => option?.category === 'mode');
    if (!model || !mode) return undefined;
    const saved = await readModeModels(modeModels);
    if (configId === model.id) {
      const current = typeof mode.currentValue === 'string' ? mode.currentValue : undefined;
      if (!current || saved.agent?.[current]?.model === value) return undefined;
      const next = { ...saved, agent: { ...saved.agent, [current]: { ...saved.agent?.[current], model: value } } };
      if (current === DEFAULT_MODE) next.model = value;
      await writePrivate(modeModels, `${JSON.stringify(next, null, 2)}\n`);
      return undefined;
    }
    if (configId !== mode.id) return undefined;
    const wanted = saved.agent?.[value]?.model;
    const offered = (model.options ?? []).flatMap((entry) => entry?.options ?? [entry]).some((choice) => choice?.value === wanted);
    return wanted && wanted !== model.currentValue && offered ? { configId: model.id, value: wanted } : undefined;
  }
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
    // The chat its terminal UI changed last, in its database.
    async lastSession({ cwd, since }) {
      return home ? latestSession(join(home, DATABASE), cwd, since) : undefined;
    },
    // What ACP leaves out of turns started in the terminal UI: the user's
    // message, busy and idle, and permissions answered there (events.js).
    watch({ emit, log }) {
      if (!server) return () => {};
      return watchEvents({ ...server, emit, log });
    },
    // A model for each mode. OpenCode itself (its terminal UI, `opencode run`)
    // takes each agent's model from its config, `agent.<mode>.model`, but
    // `opencode acp` keeps one model through mode changes and starts each chat
    // on the top-level `model`. So a model chosen in a window is saved for the
    // chat's mode (and for the default mode as the top-level model too), and a
    // change of mode, or a new chat, brings that mode's model back. OpenCode
    // reads the file when it starts, so its terminal UI follows from the next
    // start; a model the user gave a mode in their own config comes first there.
    followSetting(change) {
      const result = modeModelsQueue.then(() => followMode(change));
      modeModelsQueue = result.catch(() => {});
      return result;
    },
    // A key alone does not say whose it is, among OpenCode's providers.
    async provideKey() {
      return "OpenCode needs to know the key's provider: sign in from the chat (Sign in…) instead";
    },
    // A login or key it stored, or a provider of the user's own in its config
    // (e.g. vLLM on the cluster), which may need neither.
    async signedIn() {
      if (!home) return false;
      return (
        (await storedCredential(join(home, DATABASE))) || (await savedKey(authFile)) || (await configuredProvider(home))
      );
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

// The providers `opencode auth login` saved a key or login for.
async function savedKey(file) {
  if (!file) return false;
  try {
    const providers = JSON.parse(await readText(file));
    return Object.keys(providers ?? {}).length > 0;
  } catch {
    return false;
  }
}

async function readModeModels(file) {
  try {
    const saved = JSON.parse(await readText(file));
    return saved !== null && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

async function latestSession(file, cwd, since) {
  if (!(await exists(file))) return undefined;
  const { DatabaseSync } = await importSqlite();
  try {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const row = database
        .prepare('SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1')
        .get(cwd, since);
      return row?.id;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
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
