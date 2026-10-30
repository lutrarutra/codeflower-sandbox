import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

// Where the app passes the API key from its config, for the worker's agent.
export const PROVIDED_KEY_VARIABLE = 'CODEFLOWER_API_KEY';

// Every credential variable any agent understands. The bridge never passes
// them to an agent: logins and keys live in the agents' own files in the
// project, written by their sign-in flows.
export const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'DEEPSEEK_API_KEY',
  'CODEFLOWER_OPENAI_COMPAT_API_KEY',
  // The key the app's config gives this worker's agent; see provideKey.
  PROVIDED_KEY_VARIABLE
];

export const AGENT_NAMES = ['dsh', 'claude', 'codex'];
export const OPENAI_COMPAT_PROVIDER = 'codeflower-openai-compat';
const ENDPOINT_PATCH = 'codeflower-endpoint.patch.yml';

export class InvalidRequest extends Error {}

export async function terminalAuthCommand(agent, method) {
  const methodId = method?.id ?? 'unknown';
  const meta = method?._meta?.['terminal-auth'];
  if (meta && typeof meta.command === 'string') {
    return [meta.command, ...(Array.isArray(meta.args) ? meta.args.map(String) : [])];
  }
  if (method?.type === 'terminal') {
    return [...(await agent.command()), ...(Array.isArray(method.args) ? method.args.map(String) : [])];
  }
  throw new InvalidRequest(`${methodId} is not a terminal sign-in`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return value;
}

async function writePrivate(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

// A Cordis patch overlay that adds the OpenAI-compatible route to dsh. It names
// the key only by environment reference; JSON is valid YAML.
export function dshEndpointPatch(route) {
  return [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [OPENAI_COMPAT_PROVIDER]: {
            displayName: 'OpenAI-compatible',
            api: 'openai-completions',
            baseURL: route.baseURL,
            apiKeyEnv: 'CODEFLOWER_OPENAI_COMPAT_API_KEY',
            models: route.models.map((id) => ({ id }))
          }
        }
      }
    }
  ];
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new InvalidRequest(`${label} is required`);
  }
  return value.trim();
}

function validateRoute(value) {
  const baseURL = requireString(value?.baseURL, 'openaiCompatible.baseURL');
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new InvalidRequest('openaiCompatible.baseURL must be a URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidRequest('openaiCompatible.baseURL must use http or https');
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new InvalidRequest('openaiCompatible.models must list at least one model');
  }
  return {
    baseURL,
    models: value.models.map((model) => requireString(model, 'openaiCompatible.models[]')),
    apiKey: requireString(value.apiKey, 'openaiCompatible.apiKey')
  };
}

function setEnvLine(text, name, value) {
  const lines = text.split('\n').filter((line) => line && !line.startsWith(`${name}=`));
  lines.push(`${name}=${value}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The agents a worker can run. Each knows its command, its extra environment,
 * and whether its project already holds a login or key.
 */
export function createAgents({
  nodePath,
  dshBin,
  claudeAcpBin,
  codexAcpBin,
  // `codex` itself, for the rate limits its adapter does not pass on.
  codexBin,
  // Adds the plugin that reports dsh's token counts to the bridge.
  dshUsagePatch,
  environment = process.env
}) {
  const dshHome = environment.DSH_HOME;
  const claudeHome = environment.CLAUDE_CONFIG_DIR;
  const codexHome = environment.CODEX_HOME;

  return {
    dsh: {
      label: 'DeepSeek Harness',
      async command() {
        const command = [nodePath, dshBin, '--profile', 'codeflower'];
        if (dshHome && (await exists(join(dshHome, ENDPOINT_PATCH)))) {
          command.push('--patch', join(dshHome, ENDPOINT_PATCH));
        }
        if (dshUsagePatch && (await exists(dshUsagePatch))) command.push('--patch', dshUsagePatch);
        return command;
      },
      env: {},
      // Its usage plugin writes token counts to this extra pipe.
      usageFd: 3,
      // dsh runs on keys only.
      async authKind() {
        return 'api_key';
      },
      // dsh's /goal is a command of its own UIs, not of its ACP app.
      goal: undefined,
      async signedIn() {
        const env = dshHome ? await readText(join(dshHome, '.env')) : '';
        return /^(DEEPSEEK_API_KEY|CODEFLOWER_OPENAI_COMPAT_API_KEY)=./m.test(env);
      },
      // The app config's key goes where setCredentials puts it.
      async provideKey(key) {
        await this.setCredentials({ deepseekApiKey: key });
      },
      // dsh has no ACP sign-in; its keys go into its own .env in the project.
      async setCredentials(params) {
        if (!dshHome) throw new InvalidRequest('DSH_HOME is not set');
        const envFile = join(dshHome, '.env');
        let env = await readText(envFile);
        let changed = false;
        if (params.deepseekApiKey !== undefined) {
          env = setEnvLine(env, 'DEEPSEEK_API_KEY', requireString(params.deepseekApiKey, 'deepseekApiKey'));
          changed = true;
        }
        if (params.openaiCompatible !== undefined) {
          const route = validateRoute(params.openaiCompatible);
          env = setEnvLine(env, 'CODEFLOWER_OPENAI_COMPAT_API_KEY', route.apiKey);
          await writePrivate(join(dshHome, ENDPOINT_PATCH), `${JSON.stringify(dshEndpointPatch(route), null, 2)}\n`);
          changed = true;
        }
        if (!changed) throw new InvalidRequest('Give deepseekApiKey and/or openaiCompatible');
        await writePrivate(envFile, env);
      }
    },
    claude: {
      label: 'Claude Code',
      async command() {
        return [nodePath, claudeAcpBin];
      },
      // No NO_BROWSER: with it the adapter offers only Claude's full-screen
      // /login instead of the `auth login` commands.
      env: {},
      // `/goal CONDITION` as a prompt: Claude keeps working until a separate
      // check finds the condition met.
      goal: { maxLength: 4000 },
      async signedIn() {
        return Boolean(await this.authKind());
      },
      // Until the agent reports its login (`_auth/status_update`).
      async authKind() {
        if (!claudeHome) return undefined;
        if (await exists(join(claudeHome, '.credentials.json'))) return 'subscription';
        if (/"primaryApiKey"\s*:\s*"[^"]+"/.test(await readText(join(claudeHome, '.claude.json')))) return 'api_key';
        return (await readJson(join(claudeHome, 'settings.json')))?.env?.ANTHROPIC_API_KEY ? 'api_key' : undefined;
      },
      // The app config's key goes into the env of Claude Code's own
      // settings, which it applies to its sessions. A subscription login is kept.
      async provideKey(key) {
        if (!claudeHome) throw new InvalidRequest('CLAUDE_CONFIG_DIR is not set');
        if (await exists(join(claudeHome, '.credentials.json'))) return 'kept the existing subscription login';
        const file = join(claudeHome, 'settings.json');
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
      sessionMeta: { claudeCode: { emitRawSDKMessages: [{ type: 'rate_limit_event' }] } },
      // Claude Code's cost is its own estimate at API prices, also for subscriptions.
      costEstimate: true
    },
    codex: {
      label: 'Codex',
      async command() {
        return [nodePath, codexAcpBin];
      },
      // Hides the browser-redirect login, which cannot work inside a sandbox;
      // the device-code login works through the client instead.
      env: { NO_BROWSER: '1' },
      // `/goal OBJECTIVE` as a prompt, Codex's goals feature.
      goal: { maxLength: 4000 },
      async signedIn() {
        return Boolean(codexHome) && (await exists(join(codexHome, 'auth.json')));
      },
      // Until the agent reports its login (`_auth/status_update`).
      async authKind() {
        if (!codexHome) return undefined;
        let auth;
        try {
          auth = JSON.parse(await readText(join(codexHome, 'auth.json')));
        } catch {
          return undefined;
        }
        if (auth?.auth_mode === 'apikey' || (auth?.OPENAI_API_KEY && !auth?.tokens)) return 'api_key';
        return auth?.tokens ? 'subscription' : undefined;
      },
      // The app config's key goes into Codex's own auth.json, as its
      // API-key login does. A subscription login is kept.
      async provideKey(key) {
        if (!codexHome) throw new InvalidRequest('CODEX_HOME is not set');
        const file = join(codexHome, 'auth.json');
        const auth = await readJson(file);
        if (auth?.tokens) return 'kept the existing subscription login';
        if (auth?.OPENAI_API_KEY === key) return undefined;
        await writePrivate(file, `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }, null, 2)}\n`);
        return undefined;
      },
      // A separate app-server reads the account's rate limits.
      limitsCommand: codexBin ? () => [nodePath, codexBin, 'app-server'] : undefined
    }
  };
}
