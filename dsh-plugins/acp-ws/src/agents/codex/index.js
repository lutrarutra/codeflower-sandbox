// Codex through its ACP adapter (which runs `codex app-server`).
import { join } from 'node:path';
import { exists, InvalidRequest, readJson, readText, writePrivate } from '../support.js';

export default function codex({ home, nodePath, modules }) {
  return {
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
