// DeepSeek Harness, whose ACP app runs on keys that code flower stores for it.
import { join } from 'node:path';
import { exists, InvalidRequest, readText, requireString, writePrivate } from '../support.js';

export const OPENAI_COMPAT_PROVIDER = 'codeflower-openai-compat';
const ENDPOINT_PATCH = 'codeflower-endpoint.patch.yml';
// Fresh chats' model (defaultModelPatch), and the last one chosen in a chat.
const DEFAULT_MODEL_PATCH = 'codeflower-default-model.patch.yml';
const LAST_MODEL = 'codeflower-model.json';
const DEEPSEEK_PROVIDER = 'deepseek-official';
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
            models: route.models.map(({ reasoning, ...model }) => ({
              ...model,
              reasoningEfforts: reasoning !== false && route.reasoningEfforts.length ? effortMap(route.reasoningEfforts) : false
            }))
          }
        }
      }
    }
  ];
}

/**
 * The model fresh chats start on. dsh's own default is DeepSeek's, which
 * fails without a DeepSeek key: its ACP app takes it from its `acp` row
 * (dsh-acp-app's bundle), other entry points from dsh-base's
 * `agent-default-model`. So both rows start on the model the user chose last
 * in the project (lastModel), while its route is signed in, or else, with
 * only the OpenAI-compatible route signed in, on that route's first model.
 * A patch replaces a row's whole config, and these hold only the provider and
 * model (the `acp` row's `sessionListPageSize` keeps its default).
 */
export function defaultModelPatch({ provider, model }) {
  const config = { provider, model };
  return [
    { id: 'acp', config },
    { id: 'agent-default-model', config }
  ];
}

// The route's models, from the endpoint patch the bridge wrote.
async function routeModels(path) {
  try {
    const patches = JSON.parse(await readText(path));
    const models = patches.find((patch) => patch?.id === 'llm-pi-ai')?.config?.providers?.[OPENAI_COMPAT_PROVIDER]?.models;
    return Array.isArray(models) ? models.map((model) => model?.id).filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The route the endpoint patch holds, as `_codeflower/credentials/get` shows it to edit: its models with their
 * settings (`reasoning: false` for those without efforts), and the effort values of those that have them.
 */
async function savedRoute(path) {
  let provider;
  try {
    provider = JSON.parse(await readText(path)).find((patch) => patch?.id === 'llm-pi-ai')?.config?.providers?.[OPENAI_COMPAT_PROVIDER];
  } catch {
    return undefined;
  }
  if (typeof provider?.baseURL !== 'string' || !Array.isArray(provider.models)) return undefined;
  const models = provider.models.filter((model) => typeof model?.id === 'string');
  const efforts = models.find((model) => model.reasoningEfforts && typeof model.reasoningEfforts === 'object')?.reasoningEfforts;
  return {
    baseURL: provider.baseURL,
    models: models.map(({ id, name, contextWindow, input, reasoningEfforts }) => ({
      id,
      ...(typeof name === 'string' ? { name } : {}),
      ...(positive(contextWindow) ? { contextWindow } : {}),
      ...(Array.isArray(input) ? { input } : {}),
      reasoning: reasoningEfforts !== false
    })),
    reasoningEfforts: efforts ? Object.keys(efforts) : []
  };
}

const envValue = (env, name) => new RegExp(`^${name}=(.+)$`, 'm').exec(env)?.[1];

// A model choice: dsh's values are JSON `["provider", "model"]`.
function parseModel(value) {
  try {
    const [provider, model] = JSON.parse(value);
    return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
  } catch {
    return undefined;
  }
}

async function readLastModel(file) {
  try {
    const saved = JSON.parse(await readText(file));
    return typeof saved?.provider === 'string' && typeof saved?.model === 'string' ? { provider: saved.provider, model: saved.model } : undefined;
  } catch {
    return undefined;
  }
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

function requireBaseURL(value, field) {
  const baseURL = requireString(value, field);
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new InvalidRequest(`${field} must be a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidRequest(`${field} must use http or https`);
  }
  return baseURL;
}

const positive = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);

/**
 * A model of the route: its id, or an entry of listModels, of which dsh's
 * profile takes the name, context window and input; `reasoning: false` turns
 * the effort picker off for it.
 */
function routeModel(value) {
  if (typeof value === 'string') return { id: requireString(value, 'openaiCompatible.models[]') };
  const model = { id: requireString(value?.id, 'openaiCompatible.models[].id') };
  if (typeof value.name === 'string' && value.name.trim()) model.name = value.name.trim();
  if (positive(value.contextWindow)) model.contextWindow = value.contextWindow;
  if (Array.isArray(value.input) && value.input.includes('text')) model.input = value.input.filter((kind) => kind === 'text' || kind === 'image');
  if (value.reasoning === false) model.reasoning = false;
  return model;
}

/**
 * The models an OpenAI-compatible endpoint serves, from its `GET /models`,
 * with what it says of each: OpenRouter's name, context length, input
 * modalities and supported parameters, vLLM's `max_model_len`. `reasoning` is
 * left out when the endpoint does not say.
 */
function endpoint(params) {
  const baseURL = requireBaseURL(params?.baseURL, 'baseURL');
  const apiKey = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
  return {
    baseURL,
    root: baseURL.replace(/\/+$/, ''),
    apiKey,
    headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
  };
}

const unreachable = (baseURL, error) => `Could not reach ${baseURL}: ${error.cause?.message ?? error.message}`;
const rejectsKey = (status) => status === 401 || status === 403;

/**
 * Whether an OpenAI-compatible endpoint answers, with the status of its
 * `GET /models`, and whether it takes the key. A key is tried with an empty
 * `POST /chat/completions`, which costs nothing: servers check the key before
 * the body, so 401 or 403 rejects it and 400 or 422 takes it. Some, like
 * OpenRouter, list their models without a key.
 */
export async function checkEndpoint(params, { fetch: get = fetch } = {}) {
  const { baseURL, root, apiKey, headers } = endpoint(params);
  let models;
  try {
    models = (await get(`${root}/models`, { headers, signal: AbortSignal.timeout(15_000) })).status;
  } catch (error) {
    return { reachable: false, error: unreachable(baseURL, error) };
  }
  const result = { reachable: true, modelsStatus: models };
  if (!apiKey) return result;
  if (rejectsKey(models)) return { ...result, keyAccepted: false, keyStatus: models };
  try {
    const chat = (
      await get(`${root}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000)
      })
    ).status;
    result.keyStatus = chat;
    if (rejectsKey(chat)) result.keyAccepted = false;
    else if (chat < 300 || chat === 400 || chat === 422) result.keyAccepted = true;
  } catch (error) {
    result.error = unreachable(baseURL, error);
  }
  return result;
}

export async function listEndpointModels(params, { fetch: get = fetch } = {}) {
  const { baseURL, root, headers } = endpoint(params);
  let response;
  try {
    response = await get(`${root}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new InvalidRequest(unreachable(baseURL, error));
  }
  if (!response.ok) throw new InvalidRequest(`${baseURL}/models answered ${response.status} ${response.statusText}`.trim());
  let body;
  try {
    body = await response.json();
  } catch {
    throw new InvalidRequest(`${baseURL}/models did not answer with JSON`);
  }
  const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  const models = new Map();
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !id.trim() || models.has(id)) continue;
    const model = { id };
    if (typeof entry.name === 'string' && entry.name.trim() && entry.name !== id) model.name = entry.name.trim();
    const contextWindow = positive(entry.context_length) ?? positive(entry.max_model_len) ?? positive(entry.context_window);
    if (contextWindow) model.contextWindow = contextWindow;
    const modalities = entry.architecture?.input_modalities;
    if (Array.isArray(modalities) && modalities.includes('text')) model.input = modalities.includes('image') ? ['text', 'image'] : ['text'];
    if (Array.isArray(entry.supported_parameters)) model.reasoning = entry.supported_parameters.includes('reasoning');
    models.set(id, model);
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function validateRoute(value) {
  const baseURL = requireBaseURL(value?.baseURL, 'openaiCompatible.baseURL');
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new InvalidRequest('openaiCompatible.models must list at least one model');
  }
  const efforts = value.reasoningEfforts === undefined ? DEFAULT_REASONING_EFFORTS : value.reasoningEfforts;
  if (!Array.isArray(efforts)) throw new InvalidRequest('openaiCompatible.reasoningEfforts must be a list');
  return {
    baseURL,
    models: value.models.map(routeModel),
    reasoningEfforts: [...new Set(efforts.map((effort) => requireString(effort, 'openaiCompatible.reasoningEfforts[]')))],
    apiKey: requireString(value.apiKey, 'openaiCompatible.apiKey')
  };
}

// dsh's shell tools, whose results end with an exit-status marker.
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

/**
 * The exit status in a dsh shell tool's result, as dsh's own parser reads it
 * (`parseExitStatus` in @deepseek-ai/dsh-shell): a last line
 * `[killed by signal: X]`, or `[exit code: N]` when N is not 0; nothing for a
 * clean exit. Only the last line, so output that merely contains a marker
 * does not count. dsh-acp reports such a tool call `completed` (it fails only
 * on `isError`, which a command that exited badly does not set), so the bridge
 * reads the marker itself until dsh-acp does.
 */
export function shellExitStatus(text) {
  if (typeof text !== 'string') return undefined;
  const signal = /(?:^|\n)\[killed by signal: ([^\]\n]+)\]$/.exec(text);
  if (signal) return { signal: signal[1] };
  const exit = /(?:^|\n)\[exit code: (\d+)\]$/.exec(text);
  return exit && Number(exit[1]) !== 0 ? { exitCode: Number(exit[1]) } : undefined;
}

/**
 * What a dsh tool call is about, for the chat's row: dsh-acp titles its file
 * tools by their names alone ("write"), with the file only in rawInput. The
 * title names the file (or the search), the kind gives the row its icon, and
 * the location makes the file a link. Other tools stay as dsh reports them.
 */
export function presentTool(title, input) {
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const file = (verb, kind, path) => (text(path) ? { title: `${verb} ${text(path)}`, kind, locations: [{ path: text(path) }] } : undefined);
  if (input === null || typeof input !== 'object') return undefined;
  switch (title) {
    case 'read':
      return file('Read', 'read', input.file_path);
    case 'read_image':
      return file('Read image', 'read', input.file_path);
    case 'write':
      return file('Write', 'edit', input.file_path);
    case 'edit':
      return file('Edit', 'edit', input.file_path);
    case 'glob':
    case 'grep': {
      const pattern = text(input.pattern);
      if (!pattern) return undefined;
      const where = [text(input.include) && `(${text(input.include)})`, text(input.path) && `in ${text(input.path)}`].filter(Boolean).join(' ');
      return { title: `${title === 'glob' ? 'Find files' : 'Search for'} ${pattern}${where ? ` ${where}` : ''}`, kind: 'search' };
    }
    case 'str_replace_editor': {
      const verb = { view: 'View', create: 'Create', str_replace: 'Edit', insert: 'Edit', undo_edit: 'Undo the edit of' }[input.command];
      return verb ? file(verb, input.command === 'view' ? 'read' : 'edit', input.path) : undefined;
    }
    default:
      return undefined;
  }
}

const resultText = (content) =>
  (Array.isArray(content) ? content : [])
    .map((item) => (item?.type === 'content' && item.content?.type === 'text' ? item.content.text : ''))
    .join('');

function setEnvLine(text, name, value) {
  const lines = text.split('\n').filter((line) => line && !line.startsWith(`${name}=`));
  lines.push(`${name}=${value}`);
  return `${lines.join('\n')}\n`;
}

export default function dsh({ home, launch, nodePath, modules }) {
  // In the image only; tests start a fake agent without it.
  const usagePatch = modules ? USAGE_PATCH : undefined;
  // The shell tool calls that have not ended, by id.
  const shellCalls = new Set();

  /** The saved endpoint key, only for the URL it was saved with, so that it never goes to another server. */
  async function savedKey(baseURL) {
    if (!home || typeof baseURL !== 'string') return undefined;
    const route = await savedRoute(join(home, ENDPOINT_PATCH));
    if (route?.baseURL !== baseURL.trim()) return undefined;
    return envValue(await readText(join(home, '.env')), 'CODEFLOWER_OPENAI_COMPAT_API_KEY');
  }
  /** The request with the saved key when it gives none. */
  async function withSavedKey(params) {
    if (typeof params?.apiKey === 'string' && params.apiKey.trim()) return params;
    return { ...params, apiKey: (await savedKey(params?.baseURL)) ?? '' };
  }
  return {
    async command() {
      const command = [nodePath, launch, '--profile', 'codeflower'];
      const endpointPatch = home ? join(home, ENDPOINT_PATCH) : undefined;
      const hasRoute = Boolean(endpointPatch) && (await exists(endpointPatch));
      if (hasRoute) {
        await addDefaultEffortsToExistingRoute(endpointPatch);
        command.push('--patch', endpointPatch);
      }
      if (home) {
        const deepseek = /^DEEPSEEK_API_KEY=./m.test(await readText(join(home, '.env')));
        const models = hasRoute ? await routeModels(endpointPatch) : [];
        const last = await readLastModel(join(home, LAST_MODEL));
        const usable = (choice) =>
          (choice?.provider === DEEPSEEK_PROVIDER && deepseek) || (choice?.provider === OPENAI_COMPAT_PROVIDER && models.includes(choice.model));
        const fresh = usable(last) ? last : !deepseek && models.length ? { provider: OPENAI_COMPAT_PROVIDER, model: models[0] } : undefined;
        if (fresh) {
          const defaultPatch = join(home, DEFAULT_MODEL_PATCH);
          await writePrivate(defaultPatch, `${JSON.stringify(defaultModelPatch(fresh), null, 2)}\n`);
          command.push('--patch', defaultPatch);
        }
      }
      if (usagePatch && (await exists(usagePatch))) command.push('--patch', usagePatch);
      return command;
    },
    // Its usage plugin writes token counts to this extra pipe.
    usageFd: 3,
    // The model chosen in a chat is the one fresh chats start on (defaultModelPatch):
    // saved for the next start, and given to new chats of this one.
    async followSetting({ configId, value, configOptions, started }) {
      if (!home) return undefined;
      const option = configOptions.find((candidate) => candidate?.category === 'model');
      if (!option) return undefined;
      const file = join(home, LAST_MODEL);
      if (!started) {
        const chosen = configId === option.id && typeof value === 'string' ? parseModel(value) : undefined;
        if (chosen) await writePrivate(file, `${JSON.stringify(chosen, null, 2)}\n`);
        return undefined;
      }
      const last = await readLastModel(file);
      const current = parseModel(option.currentValue);
      if (!last || (current?.provider === last.provider && current.model === last.model)) return undefined;
      // dsh offers its DeepSeek models without a DeepSeek key too.
      if (last.provider === DEEPSEEK_PROVIDER && !/^DEEPSEEK_API_KEY=./m.test(await readText(join(home, '.env')))) return undefined;
      const offered = (option.options ?? [])
        .flatMap((entry) => entry?.options ?? [entry])
        .find((choice) => {
          const parsed = parseModel(choice?.value);
          return parsed?.provider === last.provider && parsed.model === last.model;
        });
      return offered ? { configId: option.id, value: offered.value } : undefined;
    },
    // A shell command that exited badly, or was killed, failed (shellExitStatus),
    // and a file tool names its file (presentTool).
    adjustUpdate(update) {
      if (update?.sessionUpdate === 'tool_call' && SHELL_TOOLS.has(update.title)) {
        shellCalls.add(update.toolCallId);
        return undefined;
      }
      if (update?.sessionUpdate === 'tool_call') {
        const shown = presentTool(update.title, update.rawInput);
        // Locations dsh gave itself are kept.
        return shown ? { ...update, ...shown, ...(update.locations?.length ? { locations: update.locations } : {}) } : undefined;
      }
      if (update?.sessionUpdate !== 'tool_call_update' || !shellCalls.has(update.toolCallId)) return undefined;
      if (update.status !== 'completed' && update.status !== 'failed') return undefined;
      shellCalls.delete(update.toolCallId);
      const status = update.status === 'completed' ? shellExitStatus(resultText(update.content)) : undefined;
      return status ? { ...update, status: 'failed', rawOutput: { ...update.rawOutput, ...status } } : undefined;
    },
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
    // The keys there are, and the route to edit, without its key.
    async credentials() {
      const env = home ? await readText(join(home, '.env')) : '';
      const route = home ? await savedRoute(join(home, ENDPOINT_PATCH)) : undefined;
      return {
        deepseekKey: Boolean(envValue(env, 'DEEPSEEK_API_KEY')),
        ...(route ? { openaiCompatible: { ...route, hasKey: Boolean(envValue(env, 'CODEFLOWER_OPENAI_COMPAT_API_KEY')) } } : {})
      };
    },
    // What an OpenAI-compatible endpoint serves, to choose the route's models from.
    async listModels(params) {
      return listEndpointModels(await withSavedKey(params));
    },
    async checkEndpoint(params) {
      return checkEndpoint(await withSavedKey(params));
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
        const given = params.openaiCompatible;
        const keep = !(typeof given?.apiKey === 'string' && given.apiKey.trim());
        if (keep && !(await savedKey(given?.baseURL))) {
          throw new InvalidRequest('openaiCompatible.apiKey is needed: no key is saved for this URL');
        }
        const route = validateRoute(keep ? { ...given, apiKey: await savedKey(given.baseURL) } : given);
        env = setEnvLine(env, 'CODEFLOWER_OPENAI_COMPAT_API_KEY', route.apiKey);
        await writePrivate(join(home, ENDPOINT_PATCH), `${JSON.stringify(dshEndpointPatch(route), null, 2)}\n`);
        changed = true;
      }
      if (!changed) throw new InvalidRequest('Give deepseekApiKey and/or openaiCompatible');
      await writePrivate(envFile, env);
    }
  };
}
