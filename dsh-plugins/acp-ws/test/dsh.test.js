import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgents, loadRegistry } from '../src/agents.js';
import { checkEndpoint, dshEndpointPatch, listEndpointModels, shellExitStatus } from '../src/agents/dsh/index.js';

async function dsh() {
  const agents = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'dsh');
  return createAgents({ nodePath: 'node', environment: {}, agents }).dsh;
}

test("lists an endpoint's models with what it says of each", async () => {
  let asked;
  const reply = (body, status = 200) => async (url, init) => {
    asked = { url, init };
    return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Unauthorized' });
  };
  // As OpenRouter answers.
  const openrouter = {
    data: [
      {
        id: 'qwen/qwen3-coder',
        name: 'Qwen: Qwen3 Coder',
        context_length: 262144,
        architecture: { input_modalities: ['text'] },
        supported_parameters: ['tools', 'temperature']
      },
      {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek: R1',
        context_length: 163840,
        architecture: { input_modalities: ['text', 'image', 'file'] },
        supported_parameters: ['reasoning', 'include_reasoning']
      }
    ]
  };
  assert.deepEqual(await listEndpointModels({ baseURL: 'https://openrouter.ai/api/v1/', apiKey: ' sk-or ' }, { fetch: reply(openrouter) }), [
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1', contextWindow: 163840, input: ['text', 'image'], reasoning: true },
    { id: 'qwen/qwen3-coder', name: 'Qwen: Qwen3 Coder', contextWindow: 262144, input: ['text'], reasoning: false }
  ]);
  assert.equal(asked.url, 'https://openrouter.ai/api/v1/models');
  assert.equal(asked.init.headers.authorization, 'Bearer sk-or');
  // As vLLM answers: only the context length; whether it reasons is not said.
  assert.deepEqual(await listEndpointModels({ baseURL: 'http://gpu01:8000/v1' }, { fetch: reply({ object: 'list', data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 32768 }] }) }), [
    { id: 'Qwen/Qwen3-32B', contextWindow: 32768 }
  ]);
  assert.equal(asked.init.headers.authorization, undefined);
  await assert.rejects(listEndpointModels({ baseURL: 'https://llm.example.org/v1', apiKey: 'x' }, { fetch: reply({}, 401) }), /answered 401/);
  await assert.rejects(listEndpointModels({ baseURL: 'ftp://llm.example.org' }), /http or https/);
});

test('checks that an endpoint answers and takes the key, without a completion', async () => {
  const calls = [];
  // `models` and `chat` are the statuses each route answers with.
  const server = (models, chat) => async (url, init) => {
    calls.push([init.method ?? 'GET', url, init.body]);
    return new Response('{}', { status: url.endsWith('/models') ? models : chat });
  };
  const baseURL = 'https://llm.example.org/v1';
  assert.deepEqual(await checkEndpoint({ baseURL, apiKey: 'good' }, { fetch: server(200, 400) }), {
    reachable: true,
    modelsStatus: 200,
    keyStatus: 400,
    keyAccepted: true
  });
  assert.deepEqual(calls.at(-1), ['POST', `${baseURL}/chat/completions`, '{}']);
  assert.equal((await checkEndpoint({ baseURL, apiKey: 'bad' }, { fetch: server(200, 401) })).keyAccepted, false);
  // A key rejected by /models needs no second request.
  calls.length = 0;
  assert.deepEqual(await checkEndpoint({ baseURL, apiKey: 'bad' }, { fetch: server(401, 400) }), {
    reachable: true,
    modelsStatus: 401,
    keyStatus: 401,
    keyAccepted: false
  });
  assert.equal(calls.length, 1);
  // Not the API's root: neither said.
  assert.equal((await checkEndpoint({ baseURL, apiKey: 'good' }, { fetch: server(404, 404) })).keyAccepted, undefined);
  assert.deepEqual(await checkEndpoint({ baseURL }, { fetch: server(200, 400) }), { reachable: true, modelsStatus: 200 });
  const down = await checkEndpoint({ baseURL, apiKey: 'x' }, { fetch: async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); } });
  assert.deepEqual(down, { reachable: false, error: `Could not reach ${baseURL}: ECONNREFUSED` });
});

test("writes the listed models' context window and input, and no effort picker for those that do not reason", () => {
  const route = {
    baseURL: 'https://openrouter.ai/api/v1',
    reasoningEfforts: ['low', 'high'],
    models: [{ id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1', contextWindow: 163840, input: ['text', 'image'] }, { id: 'qwen/qwen3-coder', reasoning: false }, { id: 'typed' }]
  };
  assert.deepEqual(dshEndpointPatch(route)[0].config.providers['codeflower-openai-compat'].models, [
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1', contextWindow: 163840, input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high' } },
    { id: 'qwen/qwen3-coder', reasoningEfforts: false },
    { id: 'typed', reasoningEfforts: { low: 'low', high: 'high' } }
  ]);
});

// The marker contract of dsh's shell tools (parseExitStatus in @deepseek-ai/dsh-shell).
test('reads the exit status from the last line of a shell result, as dsh does', () => {
  assert.deepEqual(shellExitStatus("[stderr]\nModuleNotFoundError: No module named 'matplotlib'\n[exit code: 1]"), { exitCode: 1 });
  assert.deepEqual(shellExitStatus('[exit code: 2]'), { exitCode: 2 });
  assert.deepEqual(shellExitStatus('partial output\n[killed by signal: SIGKILL]'), { signal: 'SIGKILL' });
  // A clean exit, no marker, or a marker that is not the last line.
  assert.equal(shellExitStatus('ok\n[exit code: 0]'), undefined);
  assert.equal(shellExitStatus('pbmc_2samples\npbmc_4donors'), undefined);
  assert.equal(shellExitStatus('[exit code: 1]\nmore output'), undefined);
  assert.equal(shellExitStatus('echo "[exit code: 1]" printed this [exit code: 1]'), undefined);
  assert.equal(shellExitStatus(undefined), undefined);
});

// As dsh-acp 0.1.6 reports a command that exited 1 (recorded).
test('a shell command that exited badly fails; other tools and clean exits stay as reported', async () => {
  const agent = await dsh();
  const text = (value) => [{ type: 'content', content: { type: 'text', text: value } }];
  const started = { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'python3 -c "import matplotlib"' } };
  assert.equal(agent.adjustUpdate(started), undefined);
  const ended = { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: text("[stderr]\nModuleNotFoundError: No module named 'matplotlib'\n[exit code: 1]") };
  assert.deepEqual(agent.adjustUpdate(ended), { ...ended, status: 'failed', rawOutput: { exitCode: 1 } });
  // Only once: the call has ended.
  assert.equal(agent.adjustUpdate(ended), undefined);

  agent.adjustUpdate({ ...started, toolCallId: 'call-2' });
  assert.equal(agent.adjustUpdate({ ...ended, toolCallId: 'call-2', content: text('pbmc_2samples\npbmc_4donors') }), undefined);
  // A progress update without an end is left alone, and the end still counts.
  agent.adjustUpdate({ ...started, toolCallId: 'call-3' });
  assert.equal(agent.adjustUpdate({ ...ended, toolCallId: 'call-3', status: 'in_progress' }), undefined);
  assert.equal(agent.adjustUpdate({ ...ended, toolCallId: 'call-3' }).status, 'failed');

  // Not a shell tool: a file whose last line looks like a marker.
  agent.adjustUpdate({ ...started, toolCallId: 'read-1', title: 'read' });
  assert.equal(agent.adjustUpdate({ ...ended, toolCallId: 'read-1' }), undefined);
  assert.equal(agent.adjustUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[exit code: 1]' } }), undefined);
});

// dsh-base starts fresh chats on DeepSeek's model (its agent-default-model row),
// which fails when only the OpenAI-compatible route has a key.
test('starts fresh chats on the endpoint route when it is the only one with a key', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codeflower-dsh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agents = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'dsh');
  const agent = createAgents({ nodePath: 'node', launch: { dsh: 'x' }, environment: { DSH_HOME: home }, agents }).dsh;
  const defaultPatch = join(home, 'codeflower-default-model.patch.yml');
  // No route: dsh's own default.
  assert.equal((await agent.command()).includes(defaultPatch), false);

  await agent.setCredentials({ openaiCompatible: { baseURL: 'https://openrouter.ai/api/v1', models: ['openrouter/free', 'qwen/qwen3-32b'], apiKey: 'sk-or-test' } });
  const command = await agent.command();
  assert.deepEqual(command.slice(-2), ['--patch', defaultPatch]);
  const config = { provider: 'codeflower-openai-compat', model: 'openrouter/free' };
  assert.deepEqual(JSON.parse(await readFile(defaultPatch, 'utf8')), [
    { id: 'acp', config },
    { id: 'agent-default-model', config }
  ]);

  // With a DeepSeek key as well, DeepSeek stays the default.
  await agent.setCredentials({ deepseekApiKey: 'sk-ds-test' });
  assert.equal((await agent.command()).includes(defaultPatch), false);
});

// As dsh's ACP app offers its models: JSON ["provider", "model"] values.
test('fresh chats start on the model chosen last, while its route is signed in', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codeflower-dsh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agents = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'dsh');
  const agent = createAgents({ nodePath: 'node', launch: { dsh: 'x' }, environment: { DSH_HOME: home }, agents }).dsh;
  await agent.setCredentials({ openaiCompatible: { baseURL: 'https://openrouter.ai/api/v1', models: ['openrouter/free', 'qwen/qwen3-32b'], apiKey: 'sk-or-test' } });
  const value = (provider, model) => JSON.stringify([provider, model]);
  const options = (current) => [
    {
      id: 'model',
      category: 'model',
      currentValue: current,
      options: [
        { group: 'deepseek', options: [{ value: value('deepseek-official', 'deepseek-v4-flash') }] },
        { group: 'compat', options: [{ value: value('codeflower-openai-compat', 'openrouter/free') }, { value: value('codeflower-openai-compat', 'qwen/qwen3-32b') }] }
      ]
    },
    { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [] }
  ];
  const freshModel = async () => {
    const command = await agent.command();
    const at = command.indexOf(join(home, 'codeflower-default-model.patch.yml'));
    return at < 0 ? undefined : JSON.parse(await readFile(command[at], 'utf8'))[0].config;
  };

  // Nothing chosen yet: a new chat keeps what dsh started it on.
  const started = { configId: undefined, value: undefined, configOptions: options(value('codeflower-openai-compat', 'openrouter/free')), started: true };
  assert.equal(await agent.followSetting(started), undefined);
  // Chosen in a chat: other settings are not, and the choice is saved.
  assert.equal(await agent.followSetting({ configId: 'reasoning_effort', value: 'low', configOptions: options(value('codeflower-openai-compat', 'qwen/qwen3-32b')) }), undefined);
  assert.equal(await agent.followSetting({ configId: 'model', value: value('codeflower-openai-compat', 'qwen/qwen3-32b'), configOptions: options(value('codeflower-openai-compat', 'qwen/qwen3-32b')) }), undefined);
  // A new chat of this run gets it, and the next start begins there.
  assert.deepEqual(await agent.followSetting(started), { configId: 'model', value: value('codeflower-openai-compat', 'qwen/qwen3-32b') });
  assert.equal(await agent.followSetting({ ...started, configOptions: options(value('codeflower-openai-compat', 'qwen/qwen3-32b')) }), undefined);
  assert.deepEqual(await freshModel(), { provider: 'codeflower-openai-compat', model: 'qwen/qwen3-32b' });

  // A DeepSeek model chosen last needs the DeepSeek key, which dsh offers its models without.
  await agent.followSetting({ configId: 'model', value: value('deepseek-official', 'deepseek-v4-flash'), configOptions: options(value('deepseek-official', 'deepseek-v4-flash')) });
  assert.deepEqual(await freshModel(), { provider: 'codeflower-openai-compat', model: 'openrouter/free' });
  assert.equal(await agent.followSetting(started), undefined);
  await agent.setCredentials({ deepseekApiKey: 'sk-ds-test' });
  assert.deepEqual(await freshModel(), { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.deepEqual(await agent.followSetting(started), { configId: 'model', value: value('deepseek-official', 'deepseek-v4-flash') });
  // A model the route no longer serves: with the DeepSeek key, dsh's own default.
  await agent.followSetting({ configId: 'model', value: value('codeflower-openai-compat', 'gone/model'), configOptions: options(value('codeflower-openai-compat', 'gone/model')) });
  assert.equal(await freshModel(), undefined);
});

// dsh-acp 0.1.6 titles its file tools by their names, the file only in rawInput (recorded for write).
test('a file tool names its file, a search what it looks for; other tools stay as reported', async () => {
  const agent = await dsh();
  const started = (title, rawInput) => ({ sessionUpdate: 'tool_call', toolCallId: `${title}-1`, title, kind: 'other', status: 'in_progress', rawInput });
  const write = started('write', { file_path: '/codeflower-state/workspace/perm-test.txt', content: 'hello' });
  assert.deepEqual(agent.adjustUpdate(write), {
    ...write,
    title: 'Write /codeflower-state/workspace/perm-test.txt',
    kind: 'edit',
    locations: [{ path: '/codeflower-state/workspace/perm-test.txt' }]
  });
  const shown = (title, rawInput) => {
    const update = agent.adjustUpdate(started(title, rawInput));
    return update && { title: update.title, kind: update.kind, locations: update.locations };
  };
  assert.deepEqual(shown('read', { file_path: 'notes.txt', offset: 10 }), { title: 'Read notes.txt', kind: 'read', locations: [{ path: 'notes.txt' }] });
  assert.deepEqual(shown('edit', { file_path: 'a.py', old_string: 'x', new_string: 'y' }), { title: 'Edit a.py', kind: 'edit', locations: [{ path: 'a.py' }] });
  assert.deepEqual(shown('read_image', { file_path: 'fig.png' }).title, 'Read image fig.png');
  assert.deepEqual(shown('glob', { pattern: '**/*.h5ad', path: '/data/input' }), { title: 'Find files **/*.h5ad in /data/input', kind: 'search', locations: undefined });
  assert.deepEqual(shown('grep', { pattern: 'CD14', include: '*.csv' }).title, 'Search for CD14 (*.csv)');
  assert.deepEqual(shown('str_replace_editor', { command: 'view', path: 'a.py' }), { title: 'View a.py', kind: 'read', locations: [{ path: 'a.py' }] });
  assert.equal(shown('str_replace_editor', { command: 'str_replace', path: 'a.py' }).title, 'Edit a.py');
  // Not enough to say more, or not a file tool: as dsh reported it.
  assert.equal(agent.adjustUpdate(started('write', { content: 'x' })), undefined);
  assert.equal(agent.adjustUpdate(started('job_output', { job_id: 'bash-1', wait: true })), undefined);
  assert.equal(agent.adjustUpdate(started('bash', { command: 'ls', description: 'List files' })), undefined);
  // Locations dsh gave itself are kept.
  assert.deepEqual(agent.adjustUpdate({ ...write, locations: [{ path: 'elsewhere' }] }).locations, [{ path: 'elsewhere' }]);
});
