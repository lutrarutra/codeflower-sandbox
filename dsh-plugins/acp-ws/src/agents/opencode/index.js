// OpenCode, which speaks ACP itself (`opencode acp`). It is a native binary,
// not a Node script: the image links this machine's build as
// node_modules/.bin/opencode, which also puts `opencode` on the PATH for its
// sign-in command (`opencode auth login`).
import { join } from 'node:path';
import { exists, readText } from '../support.js';

const DATABASE = 'opencode.db';
const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];

export default function opencode({ descriptor, home, launch, nodePath }) {
  return {
    // Tests start a fake agent script in its place.
    async command() {
      return launch.endsWith('.js') ? [nodePath, launch, 'acp'] : [launch, 'acp'];
    },
    // Its logins and sessions are in one SQLite database, which goes into its
    // home with its config; the rest of its data stays in HOME.
    env: { ...descriptor.env, ...(home ? { OPENCODE_DB: join(home, DATABASE) } : {}) },
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
