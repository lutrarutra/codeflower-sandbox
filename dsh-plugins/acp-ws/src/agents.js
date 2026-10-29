import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

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
  'CODEFLOWER_OPENAI_COMPAT_API_KEY'
];

export const AGENT_NAMES = ['dsh', 'claude', 'codex'];
export const OPENAI_COMPAT_PROVIDER = 'codeflower-openai-compat';
const ENDPOINT_PATCH = 'codeflower-endpoint.patch.yml';

export class InvalidRequest extends Error {}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
export function createAgents({ nodePath, dshBin, claudeAcpBin, codexAcpBin, environment = process.env }) {
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
        return command;
      },
      env: {},
      async signedIn() {
        const env = dshHome ? await readText(join(dshHome, '.env')) : '';
        return /^(DEEPSEEK_API_KEY|CODEFLOWER_OPENAI_COMPAT_API_KEY)=./m.test(env);
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
      async signedIn() {
        if (!claudeHome) return false;
        if (await exists(join(claudeHome, '.credentials.json'))) return true;
        return /"primaryApiKey"\s*:\s*"[^"]+"/.test(await readText(join(claudeHome, '.claude.json')));
      }
    },
    codex: {
      label: 'Codex',
      async command() {
        return [nodePath, codexAcpBin];
      },
      // Hides the browser-redirect login, which cannot work inside a sandbox;
      // the device-code login works through the client instead.
      env: { NO_BROWSER: '1' },
      async signedIn() {
        return Boolean(codexHome) && (await exists(join(codexHome, 'auth.json')));
      }
    }
  };
}
