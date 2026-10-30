// DeepSeek Harness, whose ACP app runs on keys that code flower stores for it.
import { join } from 'node:path';
import { exists, InvalidRequest, readText, requireString, writePrivate } from '../support.js';

export const OPENAI_COMPAT_PROVIDER = 'codeflower-openai-compat';
const ENDPOINT_PATCH = 'codeflower-endpoint.patch.yml';
// Reports dsh's token counts to the bridge, in the image.
const USAGE_PATCH = '/opt/codeflower/dsh-usage/cordis.patch.yml';
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high'];

function effortMap(efforts) {
  return Object.fromEntries(efforts.map((effort) => [effort, effort]));
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
            models: route.models.map((id) => ({
              id,
              reasoningEfforts: route.reasoningEfforts.length ? effortMap(route.reasoningEfforts) : false
            }))
          }
        }
      }
    }
  ];
}

async function addDefaultEffortsToExistingRoute(path) {
  let patches;
  try {
    patches = JSON.parse(await readText(path));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
  if (!Array.isArray(patches)) throw new Error(`Expected an array of Cordis patches in ${path}`);
  const provider = patches.find((patch) => patch?.id === 'llm-pi-ai')?.config?.providers?.[OPENAI_COMPAT_PROVIDER];
  if (!Array.isArray(provider?.models)) return;

  let changed = false;
  for (const model of provider.models) {
    if (model && typeof model === 'object' && typeof model.id === 'string' && model.reasoningEfforts === undefined) {
      model.reasoningEfforts = effortMap(DEFAULT_REASONING_EFFORTS);
      changed = true;
    }
  }
  if (changed) await writePrivate(path, `${JSON.stringify(patches, null, 2)}\n`);
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
  const efforts = value.reasoningEfforts === undefined ? DEFAULT_REASONING_EFFORTS : value.reasoningEfforts;
  if (!Array.isArray(efforts)) throw new InvalidRequest('openaiCompatible.reasoningEfforts must be a list');
  return {
    baseURL,
    models: value.models.map((model) => requireString(model, 'openaiCompatible.models[]')),
    reasoningEfforts: [...new Set(efforts.map((effort) => requireString(effort, 'openaiCompatible.reasoningEfforts[]')))],
    apiKey: requireString(value.apiKey, 'openaiCompatible.apiKey')
  };
}

function setEnvLine(text, name, value) {
  const lines = text.split('\n').filter((line) => line && !line.startsWith(`${name}=`));
  lines.push(`${name}=${value}`);
  return `${lines.join('\n')}\n`;
}

export default function dsh({ home, launch, nodePath, modules }) {
  // In the image only; tests start a fake agent without it.
  const usagePatch = modules ? USAGE_PATCH : undefined;
  return {
    async command() {
      const command = [nodePath, launch, '--profile', 'codeflower'];
      const endpointPatch = home ? join(home, ENDPOINT_PATCH) : undefined;
      if (endpointPatch && (await exists(endpointPatch))) {
        await addDefaultEffortsToExistingRoute(endpointPatch);
        command.push('--patch', endpointPatch);
      }
      if (usagePatch && (await exists(usagePatch))) command.push('--patch', usagePatch);
      return command;
    },
    // Its usage plugin writes token counts to this extra pipe.
    usageFd: 3,
    // dsh runs on keys only.
    async authKind() {
      return 'api_key';
    },
    async signedIn() {
      const env = home ? await readText(join(home, '.env')) : '';
      return /^(DEEPSEEK_API_KEY|CODEFLOWER_OPENAI_COMPAT_API_KEY)=./m.test(env);
    },
    // The app config's key goes where setCredentials puts it.
    async provideKey(key) {
      await this.setCredentials({ deepseekApiKey: key });
    },
    // dsh has no ACP sign-in; its keys go into its own .env in the project.
    async setCredentials(params) {
      if (!home) throw new InvalidRequest('DSH_HOME is not set');
      const envFile = join(home, '.env');
      let env = await readText(envFile);
      let changed = false;
      if (params.deepseekApiKey !== undefined) {
        env = setEnvLine(env, 'DEEPSEEK_API_KEY', requireString(params.deepseekApiKey, 'deepseekApiKey'));
        changed = true;
      }
      if (params.openaiCompatible !== undefined) {
        const route = validateRoute(params.openaiCompatible);
        env = setEnvLine(env, 'CODEFLOWER_OPENAI_COMPAT_API_KEY', route.apiKey);
        await writePrivate(join(home, ENDPOINT_PATCH), `${JSON.stringify(dshEndpointPatch(route), null, 2)}\n`);
        changed = true;
      }
      if (!changed) throw new InvalidRequest('Give deepseekApiKey and/or openaiCompatible');
      await writePrivate(envFile, env);
    }
  };
}
