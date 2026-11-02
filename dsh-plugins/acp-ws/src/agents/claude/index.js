// Claude Code through its ACP adapter.
import { join } from 'node:path';
import { exists, InvalidRequest, readJson, readText, writePrivate } from '../support.js';
import { claudePlugins } from './plugins.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_TIMEOUT_MS = 15_000;

export default function claude({ descriptor, home, modules, environment }) {
  return {
    // Claude Code is not in the image, whose license does not allow passing it
    // on: the app downloads it and binds the SDK into `modules` and the CLI at
    // CLAUDE_CODE_EXECUTABLE. Says what is missing, if anything.
    async missing() {
      if (!modules) return undefined;
      const sdk = join(modules, '@anthropic-ai/claude-agent-sdk/package.json');
      const executable = descriptor.env.CLAUDE_CODE_EXECUTABLE;
      if ((await exists(sdk)) && (await exists(executable))) return undefined;
      return 'Claude Code is not installed in this sandbox. The code flower app downloads it and binds it in ' +
        'when it starts a Claude Code worker: update the app, or run `codeflower pull` where there is internet access.';
    },
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
    // The login's quota as Claude Code's `/usage` reads it, for windows that
    // open a chat before its first turn. Only with a subscription token that
    // Claude Code has not let expire; it refreshes the token itself.
    async readUsage() {
      if (!home) return undefined;
      const oauth = (await readJson(join(home, '.credentials.json')))?.claudeAiOauth;
      if (typeof oauth?.accessToken !== 'string' || (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now())) {
        return undefined;
      }
      const response = await fetch(USAGE_URL, {
        headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`${USAGE_URL} answered ${response.status}`);
      return response.json();
    },
    // Asks for the rate limit events, which the adapter otherwise passes on
    // only once a turn's first answer has started. Plans go to `plans/` in the
    // workspace (relative to the session's folder), where the user can open
    // and edit them: the default, `$CLAUDE_CONFIG_DIR/plans`, is next to the
    // login, which the bridge does not show.
    sessionMeta: {
      claudeCode: {
        emitRawSDKMessages: [{ type: 'rate_limit_event' }],
        options: { settings: { plansDirectory: 'plans' } }
      }
    },
    // Plugins from Claude Code's marketplaces, fetched into a seed (plugins.js).
    plugins: claudePlugins({ descriptor, home, environment }),
    // Its own terminal UI on a chat (`codeflower attach`). It cannot share a
    // session with the adapter, so the bridge hands the chat over: the
    // adapter lets go of it, Claude Code resumes it, and the bridge follows
    // it through hooks and the transcript (mirror.js) until it quits.
    handoff: true,
    home,
    async tuiCommand({ sessionId, mode, settings, mcpConfig }) {
      return [
        descriptor.env.CLAUDE_CODE_EXECUTABLE,
        '--resume',
        sessionId,
        '--settings',
        JSON.stringify(settings),
        ...(mode ? ['--permission-mode', mode] : []),
        ...(mcpConfig ? ['--mcp-config', mcpConfig] : [])
      ];
    },
    // `codeflower tui`: its terminal UI alone in the sandbox, without the
    // bridge. resume: undefined (a new chat), 'last', 'pick', or a session id.
    async soloCommand({ resume, settings, mcpConfig }) {
      return [
        descriptor.env.CLAUDE_CODE_EXECUTABLE,
        '--settings',
        JSON.stringify(settings),
        ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
        ...(resume === 'last' ? ['--continue'] : resume === 'pick' ? ['--resume'] : resume ? ['--resume', resume] : [])
      ];
    },
    // It takes the config's MCP servers in its own form (mcp.js claudeMcpConfig).
    mcpConfigFile: true,
    // The image's copy is bound read-only and updated by the app.
    tuiEnv: { DISABLE_AUTOUPDATER: '1' },
    // What the sessions get from sessionMeta above, which the terminal UI never sees.
    tuiSettings: { plansDirectory: 'plans' },
    // Its first-run screens (theme, notes, trusting the folder) would take
    // the user's first keys: they were answered for the sandbox.
    async prepareTui({ cwd }) {
      if (!home) return;
      const file = join(home, '.claude.json');
      const config = (await readJson(file)) ?? {};
      const project = config.projects?.[cwd] ?? {};
      if (config.hasCompletedOnboarding && config.theme && project.hasTrustDialogAccepted) return;
      await writePrivate(
        file,
        `${JSON.stringify(
          {
            ...config,
            hasCompletedOnboarding: true,
            theme: config.theme ?? 'dark',
            projects: { ...config.projects, [cwd]: { ...project, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
          },
          null,
          2
        )}\n`
      );
    }
  };
}
