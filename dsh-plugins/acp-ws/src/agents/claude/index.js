// Claude Code through its ACP adapter.
import { join } from 'node:path';
import { exists, InvalidRequest, readJson, readText, writePrivate } from '../support.js';

export default function claude({ home }) {
  return {
    // No NO_BROWSER: with it the adapter offers only Claude's full-screen
    // /login instead of the `auth login` commands.
    async signedIn() {
      return Boolean(await this.authKind());
    },
    // Until the agent reports its login (`_auth/status_update`).
    async authKind() {
      if (!home) return undefined;
      if (await exists(join(home, '.credentials.json'))) return 'subscription';
      if (/"primaryApiKey"\s*:\s*"[^"]+"/.test(await readText(join(home, '.claude.json')))) return 'api_key';
      return (await readJson(join(home, 'settings.json')))?.env?.ANTHROPIC_API_KEY ? 'api_key' : undefined;
    },
    // The app config's key goes into the env of Claude Code's own
    // settings, which it applies to its sessions. A subscription login is kept.
    async provideKey(key) {
      if (!home) throw new InvalidRequest('CLAUDE_CONFIG_DIR is not set');
      if (await exists(join(home, '.credentials.json'))) return 'kept the existing subscription login';
      const file = join(home, 'settings.json');
      const settings = (await readJson(file)) ?? {};
      if (settings.env !== undefined &&
          (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
        throw new Error(`Expected env to be a JSON object in ${file}`);
      }
      if (settings.env?.ANTHROPIC_API_KEY === key) return undefined;
      await writePrivate(file, `${JSON.stringify({ ...settings, env: { ...settings.env, ANTHROPIC_API_KEY: key } }, null, 2)}\n`);
      return undefined;
    },
    // Asks for the rate limit events, which the adapter otherwise passes on
    // only once a turn's first answer has started.
    sessionMeta: { claudeCode: { emitRawSDKMessages: [{ type: 'rate_limit_event' }] } }
  };
}
