import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createActivity } from '../src/activity.js';
import { readActions } from '../src/actions.js';
import { createAgents, loadRegistry } from '../src/agents.js';
import { writeCommentsSlot } from '../src/files.js';
import { agentEnvironment, certificateFingerprint, clientLink, connectionUrl, pageLink, startBridge, vscodeLink } from '../src/server.js';
import { parseMcpServers } from '../src/mcp.js';
import { createPlugins } from '../src/plugins.js';
import { listSessions, readTranscript, sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const token = 'k'.repeat(43);
const inboxes = new WeakMap();

function trackSocket(socket) {
  const inbox = { messages: [], waiters: [] };
  inboxes.set(socket, inbox);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = inbox.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      inbox.messages.push(message);
      return;
    }
    const [waiter] = inbox.waiters.splice(index, 1);
    waiter.resolve(message);
  });
  return socket;
}

async function openSocket(address) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp`, {
    headers: { authorization: `Bearer ${token}` }
  });
  await once(socket, 'open');
  return trackSocket(socket);
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

function receive(socket, predicate) {
  const inbox = inboxes.get(socket);
  const index = inbox.messages.findIndex(predicate);
  if (index !== -1) {
    return Promise.resolve(inbox.messages.splice(index, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    const onError = (error) => {
      const waiterIndex = inbox.waiters.indexOf(waiter);
      if (waiterIndex !== -1) {
        inbox.waiters.splice(waiterIndex, 1);
      }
      reject(error);
    };
    waiter.resolve = (message) => {
      socket.off('error', onError);
      resolve(message);
    };
    inbox.waiters.push(waiter);
    socket.once('error', onError);
  });
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}


const ptyHelper = [
  'python3',
  fileURLToPath(new URL('../../../bin/codeflower-pty', import.meta.url))
];

test('does not pass the initial prompt file path to the agent', () => {
  const environment = agentEnvironment({
    CODEFLOWER_INITIAL_PROMPT_FILE: '/codeflower-state/runs/run-id/prompt.txt',
    CODEFLOWER_TOKEN: token
  });
  assert.equal(environment.CODEFLOWER_INITIAL_PROMPT_FILE, undefined);
  assert.equal(environment.CODEFLOWER_TOKEN, undefined);
});

test('lists actions loaded from the configured templates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-actions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actionsDirectory = join(directory, 'actions');
  await mkdir(actionsDirectory);
  await writeFile(
    join(actionsDirectory, '01-checkpoint.md'),
    '---\ntitle: Checkpoint\ndescription: Save progress\nicon: save\nmode: queue\n---\nSave progress.'
  );
  const actions = await readActions(actionsDirectory);
  const { bridge } = await startTestBridge(t, { actions });
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  await initialize(socket);
  assert.deepEqual((await call(socket, '_codeflower/actions/list')).result, { actions });
});

async function startTestBridge(t, { agentName = 'claude', ...overrides } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-acp-ws-'));
  const sessionsDirectory = join(directory, 'sessions');
  const environment = {
    ...process.env,
    CODEFLOWER_TOKEN: token,
    ANTHROPIC_API_KEY: 'host-anthropic-key',
    OPENAI_API_KEY: 'host-openai-key',
    DSH_HOME: join(directory, 'dsh-home'),
    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEX_HOME: join(directory, 'codex')
  };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({
    nodePath: process.execPath,
    launch: { dsh: fakeAgent, claude: fakeAgent, codex: fakeAgent },
    environment
  });
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-test',
    sessionsDirectory,
    agentName,
    agent: agents[agentName],
    ptyHelper,
    environment,
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message),
    ...overrides
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { bridge, directory, sessionsDirectory, environment };
}

let nextId = 100;
async function call(socket, method, params = {}) {
  const id = nextId++;
  send(socket, { jsonrpc: '2.0', id, method, params });
  return receive(socket, (message) => message.id === id && message.method === undefined);
}

async function initialize(socket, clientCapabilities = {}) {
  return (await call(socket, 'initialize', { protocolVersion: 1, clientCapabilities })).result;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met in time');
}

test('rejects missing or invalid bearer tokens without starting an agent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-acp-ws-'));
  const childMarker = join(directory, 'child-started');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    agentName: 'dsh',
    agent: {
      label: 'Marker',
      env: {},
      command: async () => [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync(process.env.TEST_CHILD_MARKER, 'started')"
      ]
    },
    environment: { ...process.env, TEST_CHILD_MARKER: childMarker },
    log: () => {}
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/acp`, {
    headers: { authorization: `Bearer ${'x'.repeat(43)}` }
  });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /Unexpected server response: 401/);
  await assert.rejects(readFile(childMarker), { code: 'ENOENT' });
});

test('starts the worker agent on connect without passing it any credentials', async (t) => {
  const logs = [];
  const { bridge, directory } = await startTestBridge(t, { agentName: 'codex', log: (message) => logs.push(message) });
  const connection = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'));
  assert.equal((await stat(join(directory, 'instance.json'))).mode & 0o777, 0o600);
  assert.equal(connection.agent, 'codex');
  assert.equal(connection.url, `codeflower://localhost:${bridge.address.port}?token=${token}`);

  // Windows attach side by side, and each one is logged.
  const other = await openSocket(bridge.address);
  const socket = await openSocket(bridge.address);
  await call(other, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codeflower-web', version: '1.2.3' } });
  assert.equal(other.readyState, WebSocket.OPEN);
  assert.match(logs.find((line) => line.startsWith('Client 1 connected')), /^Client 1 connected from \S+; 1 connected$/);
  assert.ok(logs.includes('Client 1 is codeflower-web 1.2.3'));
  assert.match(logs.find((line) => line.startsWith('Client 2 connected')), /; 2 connected$/);
  await closeSocket(other);
  await waitFor(() => logs.some((line) => line.startsWith('Client 1 disconnected')));
  assert.match(logs.find((line) => line.startsWith('Client 1 disconnected')), /\(\d+\); 1 connected$/);

  const initialized = await initialize(socket);
  assert.equal(initialized._meta['codeflower/multiClient'], true);
  assert.deepEqual(initialized.credentialVariables, []);
  assert.equal(initialized.leakedAppToken, null);
  assert.equal(initialized.noBrowser, '1');

  const status = (await call(socket, '_codeflower/status')).result;
  assert.equal(status.agent, 'codex');
  assert.equal(status.agentLabel, 'Codex');
  assert.equal(status.signedIn, false);
  assert.equal(status.credentials, 'agent');

  const apiKey = await call(socket, 'authenticate', { methodId: 'api-key', _meta: { 'api-key': { apiKey: 'sk-test' } } });
  assert.equal(apiKey.result.keyLength, 7);
  await closeSocket(socket);
});

test('runs an agent added as a folder with only its descriptor', async (t) => {
  const agentsDirectory = await mkdtemp(join(tmpdir(), 'codeflower-agents-'));
  t.after(() => rm(agentsDirectory, { recursive: true, force: true }));
  await mkdir(join(agentsDirectory, 'pi'));
  await writeFile(
    join(agentsDirectory, 'pi', 'agent.json'),
    JSON.stringify({ id: 'pi', name: 'Pi', color: '#3a7bd5', launch: 'pi-acp/dist/index.js', env: { PI_FLAG: '1' } })
  );
  const agents = createAgents({ nodePath: process.execPath, launch: { pi: fakeAgent }, agents: await loadRegistry(agentsDirectory) });
  assert.deepEqual(Object.keys(agents), ['pi']);
  const { bridge } = await startTestBridge(t, { agentName: 'pi', agent: agents.pi });
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const status = (await call(socket, '_codeflower/status')).result;
  assert.equal(status.agent, 'pi');
  assert.equal(status.agentLabel, 'Pi');
  assert.deepEqual(status.agentInfo, { id: 'pi', name: 'Pi', color: '#3a7bd5' });
  // No hooks: the agent signs in through ACP itself.
  assert.equal(status.signedIn, true);
  assert.equal(status.credentials, 'agent');
  const sessionId = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const answer = call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello pi' }] });
  const update = await receive(socket, (message) => message.method === 'session/update');
  assert.equal(update.params.update.content.text, `reply to hello pi in ${sessionId}`);
  assert.equal((await answer).result.stopReason, 'end_turn');
  await closeSocket(socket);
});

test("gives every session the config's MCP servers the agent supports, next to the window's", async (t) => {
  const logs = [];
  const { bridge } = await startTestBridge(t, {
    agentName: 'codex',
    log: (message) => logs.push(message),
    mcpServers: parseMcpServers(
      JSON.stringify([
        { name: 'node', command: 'node', args: ['server.js'] },
        { type: 'http', name: 'docs', url: 'https://mcp.example.org/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
        { type: 'sse', name: 'events', url: 'https://mcp.example.org/sse' }
      ])
    )
  });
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  assert.ok(logs.includes('MCP servers left out for Codex: events (the agent does not support sse servers)'));
  const own = { name: 'mine', command: '/bin/true', args: [], env: [] };
  const session = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [own] })).result;
  assert.deepEqual(
    session.mcpServers.map((server) => server.name),
    ['mine', 'node', 'docs']
  );
  // dsh takes only absolute commands.
  assert.match(session.mcpServers[1].command, /^\/.*\/node$/);
  assert.deepEqual(session.mcpServers[2].headers, [{ name: 'Authorization', value: 'Bearer x' }]);
  await closeSocket(socket);
});

test('starts a chat without a configured MCP server that fails it, and tells every window', async (t) => {
  const logs = [];
  const { bridge } = await startTestBridge(t, {
    agentName: 'dsh',
    log: (message) => logs.push(message),
    mcpServers: parseMcpServers(
      JSON.stringify([
        { name: 'broken', command: '/opt/failing-mcp' },
        { type: 'http', name: 'docs', url: 'https://mcp.example.org/mcp' },
        { type: 'sse', name: 'events', url: 'https://mcp.example.org/sse' }
      ])
    )
  });
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const leftOut = [
    { name: 'events', reason: 'the agent does not support sse servers' },
    { name: 'broken', reason: 'it did not start' }
  ];
  const session = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result;
  assert.deepEqual(
    session.mcpServers.map((server) => server.name),
    ['docs']
  );
  assert.deepEqual(session._meta['codeflower/mcpLeftOut'], leftOut);
  assert.ok(logs.some((line) => /^MCP server broken did not start in .*; session\/new again without$/.test(line)));

  // Another window opening the chat hears it too.
  const other = await openSocket(bridge.address);
  await initialize(other);
  const resumed = (await call(other, 'session/resume', { sessionId: session.sessionId, cwd: '/workspace', mcpServers: [] })).result;
  assert.deepEqual(resumed._meta['codeflower/mcpLeftOut'], leftOut);

  // A window's own failing server is its own error.
  const refused = await call(socket, 'session/new', {
    cwd: '/workspace',
    mcpServers: [{ name: 'mine', command: '/opt/failing-mcp', args: [], env: [] }]
  });
  assert.match(refused.error.data.details, /^mcp-client\(mine\)/);
  await closeSocket(other);
  await closeSocket(socket);
});

test('runs OpenCode with its database in its home until it is signed in', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codeflower-opencode-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agents = createAgents({
    nodePath: process.execPath,
    launch: { opencode: fakeAgent },
    environment: { OPENCODE_CONFIG_DIR: home },
    agents: (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'opencode')
  });
  const { bridge } = await startTestBridge(t, { agentName: 'opencode', agent: agents.opencode });
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  const initialized = await initialize(socket);
  // Its server on a port the bridge picked, for its terminal UI to join.
  assert.deepEqual(initialized.argv.slice(0, 4), ['acp', '--hostname', '127.0.0.1', '--port']);
  assert.match(initialized.argv[4], /^\d+$/);
  assert.equal(initialized.opencodeDatabase, join(home, 'opencode.db'));
  assert.deepEqual(initialized.credentialVariables, []);
  const status = (await call(socket, '_codeflower/status')).result;
  assert.deepEqual(status.agentInfo, { id: 'opencode', name: 'OpenCode', color: 'violet' });
  assert.equal(status.signedIn, false);
});

test("OpenCode's model follows its mode, in every window and in a new chat", async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codeflower-opencode-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agents = createAgents({
    nodePath: process.execPath,
    launch: { opencode: fakeAgent },
    environment: { OPENCODE_CONFIG_DIR: home },
    agents: (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'opencode')
  });
  assert.equal(agents.opencode.env.OPENCODE_CONFIG, join(home, 'codeflower-models.json'));
  const { bridge } = await startTestBridge(t, { agentName: 'opencode', agent: agents.opencode });
  const window = await openSocket(bridge.address);
  const other = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  t.after(() => closeSocket(other));
  await initialize(window);
  await initialize(other);
  const sessionId = await newChat(window);
  await call(other, 'session/resume', { sessionId, cwd: '/w', mcpServers: [] });
  const model = (options) => options.find((option) => option.id === 'model').currentValue;
  const set = async (configId, value) => (await call(window, 'session/set_config_option', { sessionId, configId, value })).result.configOptions;

  // Chosen per mode, and saved for OpenCode's terminal UI.
  await set('model', 'openrouter/qwen/qwen3-32b');
  await set('mode', 'plan');
  await set('model', 'openrouter/openrouter/free');
  const saved = async () => JSON.parse(await readFile(join(home, 'codeflower-models.json'), 'utf8').catch(() => '{}'));
  await waitFor(async () => (await saved()).agent?.plan?.model === 'openrouter/openrouter/free');
  assert.deepEqual(await saved(), {
    agent: { default: { model: 'openrouter/qwen/qwen3-32b' }, plan: { model: 'openrouter/openrouter/free' } }
  });

  // Back in the first mode, its model comes back, in both windows.
  const followed = (socket) =>
    receive(socket, (message) => message.params?.update?.sessionUpdate === 'config_option_update' && model(message.params.update.configOptions) === 'openrouter/qwen/qwen3-32b');
  const seen = [followed(window), followed(other)];
  assert.equal(model(await set('mode', 'default')), 'openrouter/openrouter/free');
  await Promise.all(seen);

  // A new chat starts on its mode's model.
  const fresh = receive(window, (message) => message.params?.update?.sessionUpdate === 'config_option_update' && model(message.params.update.configOptions) === 'openrouter/qwen/qwen3-32b');
  const next = await newChat(window);
  assert.equal((await fresh).params.sessionId, next);
});

test('describes every built-in agent completely', async () => {
  for (const { descriptor } of await loadRegistry()) {
    assert.match(descriptor.id, /^[a-z][a-z0-9-]*$/);
    for (const field of ['name', 'color', 'launch']) assert.equal(typeof descriptor[field], 'string', `${descriptor.id}.${field}`);
    assert.match(descriptor.home.variable, /^[A-Z_]+$/);
    assert.ok(!descriptor.home.path.startsWith('/') && !descriptor.home.path.includes('..'), descriptor.id);
    assert.ok(descriptor.providerHosts.length > 0, descriptor.id);
    for (const path of Object.keys(descriptor.files ?? {})) assert.ok(!path.startsWith('/') && !path.includes('..'), path);
  }
});

test('starts and records an initial prompt in a session that VS Code can resume', async (t) => {
  const { bridge, directory, sessionsDirectory, environment } = await startTestBridge(t, {
    initialPrompt: 'Analyse the input and generate a report',
    signInPollMs: 10
  });
  assert.equal(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')).initialPrompt, true);
  const nativeSessionId = 'session-1';
  const key = sessionKey('claude', nativeSessionId);

  // Not signed in: the prompt waits for the sign-in instead of failing.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await listSessions(sessionsDirectory), []);
  await writeFile(join(environment.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  await waitFor(async () => (await readTranscript(sessionsDirectory, key)).some((entry) => entry.kind === 'turn_end'));

  const transcript = await readTranscript(sessionsDirectory, key);
  assert.deepEqual(transcript.map((entry) => entry.kind), ['prompt', 'update', 'turn_end']);
  assert.equal(transcript[0].prompt[0].text, 'Analyse the input and generate a report');

  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const sessions = (await call(socket, '_codeflower/sessions/list')).result.sessions;
  assert.equal(sessions.find((session) => session.key === key)?.nativeSessionId, nativeSessionId);
  const resumed = (await call(socket, 'session/resume', {
    sessionId: nativeSessionId,
    cwd: '/workspace',
    mcpServers: []
  })).result;
  assert.equal(resumed._meta['codeflower/transcriptEntries'], transcript.length);
  assert.equal(resumed._meta['codeflower/busy'], false);
  await closeSocket(socket);
});

test('relays chat, permissions, cancellation, and several sessions, and records them', async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);
  await initialize(socket);

  const first = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const second = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  assert.notEqual(first, second);

  const answer = call(socket, 'session/prompt', { sessionId: first, prompt: [{ type: 'text', text: 'say hello' }] });
  const update = await receive(socket, (message) => message.method === 'session/update');
  assert.equal(update.params.update.content.text, `reply to say hello in ${first}`);
  assert.equal((await answer).result.stopReason, 'end_turn');

  const permitted = call(socket, 'session/prompt', { sessionId: second, prompt: [{ type: 'text', text: 'ask permission' }] });
  const permission = await receive(socket, (message) => message.method === 'session/request_permission');
  send(socket, { jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.equal((await permitted).result.stopReason, 'end_turn');

  const cancelled = call(socket, 'session/prompt', { sessionId: first, prompt: [{ type: 'text', text: 'cancel me' }] });
  send(socket, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: first } });
  assert.equal((await cancelled).result.stopReason, 'cancelled');

  const firstKey = sessionKey('claude', first);
  await waitFor(async () =>
    (await call(socket, '_codeflower/sessions/transcript', { key: firstKey })).result.entries.length >= 5
  );
  const sessions = (await call(socket, '_codeflower/sessions/list')).result.sessions;
  assert.deepEqual(sessions.map((session) => session.key).sort(), [firstKey, sessionKey('claude', second)].sort());
  assert.equal(sessions.find((session) => session.key === firstKey).title, 'say hello');
  assert.equal(sessions[0].openOn, 'instance-test');
  // The app lists the same chats over HTTP, without opening a window.
  const listing = (headers) => fetch(`http://127.0.0.1:${bridge.address.port}/sessions`, { headers });
  assert.equal((await listing({})).status, 401);
  const listed = await listing({ authorization: `Bearer ${token}` });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).sessions, sessions);

  assert.deepEqual(
    (await call(socket, '_codeflower/sessions/transcript', { key: firstKey })).result.entries.map((entry) => entry.kind),
    ['prompt', 'update', 'turn_end', 'prompt', 'turn_end']
  );
  // Clients that page get the newest turns and where they start.
  const page = (await call(socket, '_codeflower/sessions/transcript', { key: firstKey, maxBytes: 1 })).result;
  assert.deepEqual([page.start, page.total, page.entries.map((entry) => entry.kind)], [0, 5, ['prompt', 'update', 'turn_end', 'prompt', 'turn_end']]);
  const before = (await call(socket, '_codeflower/sessions/transcript', { key: firstKey, before: 3 })).result;
  assert.deepEqual([before.start, before.entries.length], [0, 3]);
  assert.deepEqual((await call(socket, '_codeflower/sessions/rename', { key: firstKey, title: 'Greeting' })).result, {});
  assert.match((await call(socket, '_codeflower/sessions/rename', { key: 'codex-x', title: 'y' })).error.message, /Invalid/);
  await closeSocket(socket);

  // A later connection reattaches to the session the agent still has loaded.
  const again = await openSocket(bridge.address);
  await initialize(again);
  const resumed = (await call(again, 'session/resume', { sessionId: first, cwd: '/workspace', mcpServers: [] })).result;
  assert.equal(resumed._meta['codeflower/transcriptEntries'], 5);
  assert.equal(resumed._meta['codeflower/busy'], false);
  // An idle chat is released for deleting; the worker keeps its lease meanwhile.
  assert.ok(await readFile(join(sessionsDirectory, firstKey, 'lease.json')));
  assert.deepEqual((await call(again, '_codeflower/sessions/delete', { key: firstKey })).result, {});
  assert.equal((await call(again, '_codeflower/sessions/list')).result.sessions.length, 1);
  await closeSocket(again);
});

test('asks chats with a turn running to wrap up before the job ends', async (t) => {
  const lead = 60_000;
  const allocationEnd = Date.now() + lead + 1500;
  const { bridge, sessionsDirectory } = await startTestBridge(t, {
    allocationEnd,
    wrapUpLeadMs: lead,
    wrapUpTemplate: 'wrap up: the job ends at {{end}}, in {{minutes}} minutes\n'
  });
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  assert.equal((await call(socket, '_codeflower/status')).result.allocationEnd, new Date(allocationEnd).toISOString());

  const newSession = async () => (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const working = await newSession();
  const waiting = await newSession();
  const idle = await newSession();
  const cancelled = call(socket, 'session/prompt', { sessionId: working, prompt: [{ type: 'text', text: 'cancel me' }] });
  const permitted = call(socket, 'session/prompt', { sessionId: waiting, prompt: [{ type: 'text', text: 'ask permission' }] });
  const permission = await receive(socket, (message) => message.method === 'session/request_permission');

  const notice = await receive(socket, (message) => message.method === '_codeflower/wrapUp' && !message.params.key);
  assert.equal(notice.params.chats, 2);
  assert.equal(notice.params.minutes, 1);
  assert.equal((await cancelled).result.stopReason, 'cancelled');
  assert.equal((await permitted).result.stopReason, 'end_turn');
  // The bridge answered the permission request; the window's late answer is dropped.
  send(socket, { jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });

  const expected = `wrap up: the job ends at ${new Date(allocationEnd).toISOString()}, in 1 minutes`;
  for (const sessionId of [working, waiting]) {
    const prompt = await receive(
      socket,
      (message) => message.method === '_codeflower/wrapUp' && message.params.key === sessionKey('claude', sessionId)
    );
    assert.equal(prompt.params.prompt, expected);
    const reply = await receive(
      socket,
      (message) => message.method === 'session/update' && message.params.sessionId === sessionId &&
        message.params.update.content?.text?.startsWith('reply to wrap up')
    );
    assert.equal(reply.params.update.content.text, `reply to ${expected} in ${sessionId}`);
  }

  const waitingKey = sessionKey('claude', waiting);
  await waitFor(async () =>
    (await call(socket, '_codeflower/sessions/transcript', { key: waitingKey })).result.entries.length >= 8
  );
  const entries = (await call(socket, '_codeflower/sessions/transcript', { key: waitingKey })).result.entries;
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['prompt', 'permission', 'permission_outcome', 'update', 'turn_end', 'prompt', 'update', 'turn_end']
  );
  assert.deepEqual(entries[2].outcome, { outcome: 'cancelled' });
  assert.equal(entries[5].prompt[0].text, expected);
  // A chat with no turn running is left alone.
  assert.deepEqual(await readTranscript(sessionsDirectory, sessionKey('claude', idle)), []);
  await closeSocket(socket);
});

async function wrapUp(address, body, headers = { authorization: `Bearer ${token}` }) {
  const response = await fetch(`http://127.0.0.1:${address.port}/wrap-up`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { code: response.status, body: await response.json().catch(() => undefined) };
}

test('asks working chats to wrap up when the client quits', async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t, {
    wrapUpQuitTemplate: 'wrap up: the client quits, at most {{minutes}} minutes\n'
  });
  assert.equal((await wrapUp(bridge.address, { reason: 'quit', minutes: 10 }, {})).code, 401);
  assert.equal((await wrapUp(bridge.address, { reason: 'time', minutes: 10 })).code, 400);
  assert.equal((await wrapUp(bridge.address, { reason: 'quit' })).code, 400);

  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const newSession = async () => (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const working = await newSession();
  const idle = await newSession();
  const cancelled = call(socket, 'session/prompt', { sessionId: working, prompt: [{ type: 'text', text: 'cancel me' }] });
  await receive(socket, (message) => message.method === '_codeflower/activity' && message.params.working === 1);
  assert.equal((await status(bridge.address)).body.wrapUp, undefined);

  assert.deepEqual(await wrapUp(bridge.address, { reason: 'quit', minutes: 10 }), { code: 202, body: { chats: 1 } });
  assert.deepEqual((await status(bridge.address)).body.wrapUp, { reason: 'quit', state: 'running', chats: 1 });
  // A second request does not ask the same chat again.
  assert.deepEqual(await wrapUp(bridge.address, { reason: 'quit', minutes: 10 }), { code: 202, body: { chats: 0 } });

  const notice = await receive(socket, (message) => message.method === '_codeflower/wrapUp' && !message.params.key);
  assert.deepEqual(notice.params, { reason: 'quit', minutes: 10, chats: 1 });
  assert.equal((await cancelled).result.stopReason, 'cancelled');
  const expected = 'wrap up: the client quits, at most 10 minutes';
  const prompt = await receive(
    socket,
    (message) => message.method === '_codeflower/wrapUp' && message.params.key === sessionKey('claude', working)
  );
  assert.equal(prompt.params.prompt, expected);
  await waitFor(async () => (await status(bridge.address)).body.wrapUp.state === 'done');
  assert.deepEqual((await status(bridge.address)).body.wrapUp, { reason: 'quit', state: 'done', chats: 1 });
  assert.deepEqual(await readTranscript(sessionsDirectory, sessionKey('claude', idle)), []);
  await closeSocket(socket);
});

test('refuses a wrap-up on request without its template', async (t) => {
  const { bridge } = await startTestBridge(t);
  assert.equal((await wrapUp(bridge.address, { reason: 'quit', minutes: 10 })).code, 501);
});

test('refuses to resume a session leased by another worker', async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t, { agentName: 'codex' });
  const directory = join(sessionsDirectory, sessionKey('codex', 'busy'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'lease.json'), JSON.stringify({ instanceId: 'other', heartbeatAt: new Date().toISOString() }));

  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const refused = await call(socket, 'session/resume', { sessionId: 'busy', cwd: '/w', mcpServers: [] });
  assert.equal(refused.error.code, -32010);
  assert.equal(refused.error.data.instanceId, 'other');

  await writeFile(join(directory, 'lease.json'), JSON.stringify({ instanceId: 'other', heartbeatAt: new Date(0).toISOString() }));
  const resumed = (await call(socket, 'session/resume', { sessionId: 'busy', cwd: '/w', mcpServers: [] })).result;
  assert.equal(resumed._meta['codeflower/transcriptEntries'], 0);
  await closeSocket(socket);
});

test('runs only the terminal sign-ins the agent announced', async (t) => {
  const { bridge, environment } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);

  assert.match((await call(socket, '_codeflower/terminal/start', { methodId: 'claude-ai-login' })).error.message, /no sign-in method/);
  const initialized = await initialize(socket, { _meta: { 'terminal-auth': true }, auth: { terminal: true } });
  assert.ok(initialized.authMethods.some((method) => method.id === 'claude-ai-login'));
  assert.match((await call(socket, '_codeflower/terminal/start', { methodId: 'api-key' })).error.message, /not a terminal/);

  const { terminalId } = (await call(socket, '_codeflower/terminal/start', { methodId: 'claude-ai-login', columns: 80, rows: 24 })).result;
  let output = '';
  await waitFor(async () => {
    while (true) {
      const inbox = inboxes.get(socket).messages;
      const index = inbox.findIndex((message) => message.method === '_codeflower/terminal/output');
      if (index === -1) break;
      output += inbox.splice(index, 1)[0].params.data;
    }
    return output.includes('Paste code');
  });
  assert.deepEqual((await call(socket, '_codeflower/terminal/input', { terminalId, data: 'CODE-42\r' })).result, {});
  const exit = await receive(socket, (message) => message.method === '_codeflower/terminal/exit');
  assert.equal(exit.params.exitCode, 0);
  assert.equal(JSON.parse(await readFile(join(environment.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8')).code, 'CODE-42');
  assert.equal((await call(socket, '_codeflower/status')).result.signedIn, true);
  assert.match((await call(socket, '_codeflower/credentials/set', { deepseekApiKey: 'x' })).error.message, /signs in through the agent/);
  await closeSocket(socket);
});

test('relays device-code sign-in requests to the client', async (t) => {
  const { bridge } = await startTestBridge(t, { agentName: 'codex' });
  const socket = await openSocket(bridge.address);
  const initialized = await initialize(socket, { elicitation: { url: {} } });
  assert.ok(initialized.authMethods.some((method) => method.id === 'chat-gpt-device-code'));

  const login = call(socket, 'authenticate', { methodId: 'chat-gpt-device-code' });
  const elicitation = await receive(socket, (message) => message.method === 'elicitation/create');
  assert.equal(elicitation.params.url, 'https://auth.example.org/device');
  assert.match(elicitation.params.message, /ABCD-1234/);
  send(socket, { jsonrpc: '2.0', id: elicitation.id, result: { action: 'accept' } });
  assert.ok(await receive(socket, (message) => message.method === 'elicitation/complete'));
  assert.equal((await login).result.accepted, true);
  await closeSocket(socket);
});

test('stores dsh keys in its own files and adds the endpoint on the next start', async (t) => {
  const { bridge, environment } = await startTestBridge(t, { agentName: 'dsh' });
  const socket = await openSocket(bridge.address);
  const status = (await call(socket, '_codeflower/status')).result;
  assert.equal(status.signedIn, false);
  assert.equal(status.credentials, 'keys');

  assert.match((await call(socket, '_codeflower/credentials/set', {})).error.message, /deepseekApiKey/);
  const set = await call(socket, '_codeflower/credentials/set', {
    deepseekApiKey: 'sk-deepseek-secret',
    openaiCompatible: { baseURL: 'https://llm.example.org/v1', models: ['qwen3-coder'], apiKey: 'sk-compat-secret' }
  });
  assert.deepEqual(set.result, { restartRequired: true });
  const env = await readFile(join(environment.DSH_HOME, '.env'), 'utf8');
  assert.match(env, /^DEEPSEEK_API_KEY=sk-deepseek-secret$/m);
  assert.match(env, /^CODEFLOWER_OPENAI_COMPAT_API_KEY=sk-compat-secret$/m);
  assert.equal((await stat(join(environment.DSH_HOME, '.env'))).mode & 0o777, 0o600);
  const patch = await readFile(join(environment.DSH_HOME, 'codeflower-endpoint.patch.yml'), 'utf8');
  assert.match(patch, /llm\.example\.org/);
  assert.doesNotMatch(patch, /sk-compat-secret/);
  assert.deepEqual(JSON.parse(patch)[0].config.providers['codeflower-openai-compat'].models, [
    { id: 'qwen3-coder', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } }
  ]);
  assert.equal((await call(socket, '_codeflower/status')).result.signedIn, true);
  const ended = once(socket, 'close');
  assert.deepEqual((await call(socket, '_codeflower/agent/restart')).result, {});
  await ended;

  const again = await openSocket(bridge.address);
  const initialized = await initialize(again);
  assert.ok(initialized.argv.includes('--patch'));
  assert.deepEqual(initialized.credentialVariables, []);
  await closeSocket(again);
});

test('starts a run\'s prompt once dsh has restarted with its keys', async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t, {
    agentName: 'dsh',
    initialPrompt: 'Analyse the input',
    signInPollMs: 10
  });
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  await call(socket, '_codeflower/credentials/set', { deepseekApiKey: 'sk-deepseek-secret' });
  // Signed in, but the agent running has no keys yet.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await listSessions(sessionsDirectory), []);

  const ended = once(socket, 'close');
  await call(socket, '_codeflower/agent/restart');
  await ended;
  await waitFor(async () => (await listSessions(sessionsDirectory)).length === 1);
  const [session] = await listSessions(sessionsDirectory);
  await waitFor(async () => (await readTranscript(sessionsDirectory, session.key)).some((entry) => entry.kind === 'turn_end'));
  assert.equal((await readTranscript(sessionsDirectory, session.key))[0].prompt[0].text, 'Analyse the input');
});

test("manages the agent's plugins and starts the agent with them", async (t) => {
  const pluginsDirectory = await mkdtemp(join(tmpdir(), 'codeflower-plugins-'));
  t.after(() => rm(pluginsDirectory, { recursive: true, force: true }));
  const calls = [];
  const plugins = createPlugins({
    agentName: 'claude',
    hooks: {
      async fetch(entries) {
        calls.push('fetch');
        return entries.map((entry) => ({ id: entry.id, version: '2.0.0' }));
      },
      async activate(entries) {
        calls.push(`activate ${entries.length}`);
        return { env: { CLAUDE_CODE_PLUGIN_SEED_DIR: entries.length ? '/seed' : '/empty' } };
      }
    },
    descriptor: { kinds: ['github'] },
    directory: pluginsDirectory,
    canFetch: true
  });
  const { bridge } = await startTestBridge(t, { plugins });
  const socket = await openSocket(bridge.address);
  assert.equal((await initialize(socket)).pluginSeed, '/empty');
  const { subagents, ...capabilities } = (await call(socket, '_codeflower/status')).result.capabilities;
  assert.deepEqual(capabilities, { plugins: true, chatTerminals: true });
  assert.deepEqual(subagents.settings, { model: { applies: 'session' } });

  assert.match((await call(socket, '_codeflower/plugins/add', { source: 'npm:x@1' })).error.message, /github:, not npm:/);
  const added = (await call(socket, '_codeflower/plugins/add', { source: 'github:org/mine' })).result;
  assert.deepEqual(added, { id: 'claude:github:org/mine', pendingFetch: false });
  await receive(socket, (message) => message.method === '_codeflower/plugins/changed');
  await waitFor(async () => (await call(socket, '_codeflower/plugins/list')).result.entries[0].state === 'fetched');
  const listed = (await call(socket, '_codeflower/plugins/list')).result;
  assert.equal(listed.restartPending, true);
  assert.equal(listed.entries[0].version, '2.0.0');

  // Applied with the restart the windows already offer.
  const ended = once(socket, 'close');
  await call(socket, '_codeflower/agent/restart');
  await ended;
  const again = await openSocket(bridge.address);
  t.after(() => closeSocket(again));
  assert.equal((await initialize(again)).pluginSeed, '/seed');
  assert.equal((await call(again, '_codeflower/plugins/list')).result.restartPending, false);
  assert.deepEqual(calls, ['activate 0', 'fetch', 'activate 1']);
});

test('an agent without plugins says so and refuses the plugin methods', async (t) => {
  const { bridge } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  await initialize(socket);
  const { subagents: _, ...capabilities } = (await call(socket, '_codeflower/status')).result.capabilities;
  assert.deepEqual(capabilities, { plugins: false, chatTerminals: true });
  assert.deepEqual((await call(socket, '_codeflower/plugins/list')).result, { available: false });
  assert.match((await call(socket, '_codeflower/plugins/add', { source: 'github:a/b' })).error.message, /no plugins/);
});

test('shows the files the agent asks for and lets the client read them', async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'codeflower-workspace-'));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const { bridge, sessionsDirectory } = await startTestBridge(t, {
    workspace: workspaceDirectory,
    showSocket: join(workspaceDirectory, 'show.sock')
  });
  const showCommand = fileURLToPath(new URL('../../../bin/codeflower-show', import.meta.url));
  const show = (...args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [showCommand, ...args],
        { cwd: workspaceDirectory, env: { ...process.env, CODEFLOWER_SHOW_SOCKET: join(workspaceDirectory, 'show.sock') } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
    });
  await mkdir(join(workspaceDirectory, 'figures'));
  await writeFile(join(workspaceDirectory, 'figures', 'umap.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  // Nobody is connected yet.
  assert.match((await show('figures/umap.svg')).stderr, /No window is connected/);

  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const shown = await show('--title', 'UMAP', '--message', 'Clusters by cell type', 'figures/umap.svg');
  assert.equal(shown.code, 0, shown.stderr);
  const notification = await receive(socket, (message) => message.method === '_codeflower/show');
  assert.equal(notification.params.title, 'UMAP');
  assert.equal(notification.params.message, 'Clusters by cell type');
  assert.equal(notification.params.files[0].mimeType, 'image/svg+xml');
  const path = notification.params.files[0].path;
  assert.ok(path.endsWith('/figures/umap.svg'));

  const file = (await call(socket, '_codeflower/files/read', { path })).result;
  assert.equal(Buffer.from(file.data, 'base64').toString(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.ok((await call(socket, '_codeflower/files/stat', { path })).result.mtimeMs > 0);
  const listing = (await call(socket, '_codeflower/files/list', { path: workspaceDirectory })).result;
  // The socket is neither a file nor a folder, so it is not listed.
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.type]),
    [['figures', 'directory']]
  );

  // Session records and logins in the project state stay private; missing files are reported.
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(join(sessionsDirectory, 'secret.txt'), 'private');
  const denied = await call(socket, '_codeflower/files/read', { path: join(sessionsDirectory, 'secret.txt') });
  assert.match(denied.error.message, /cannot be shown/);
  assert.match((await show('missing.png')).stderr, /No such file: missing.png/);
  await closeSocket(socket);
});

test('takes files attached to messages in chunks, into the workspace uploads folder only', async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'codeflower-workspace-'));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const uploadsFolder = join(workspaceDirectory, 'uploads');
  await mkdir(uploadsFolder);
  // A part an earlier bridge left behind.
  await writeFile(join(uploadsFolder, '.left-over.part'), 'stale');
  const { bridge } = await startTestBridge(t, { workspace: workspaceDirectory, uploadMaxBytes: 64 });
  assert.deepEqual(await readdir(uploadsFolder), []);
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  const initialized = await initialize(socket);
  assert.deepEqual(initialized._meta['codeflower/uploads'], { maxBytes: 64, chunkBytes: 1024 * 1024 });

  const upload = async (name, content, chunkSize = 7) => {
    const data = Buffer.from(content);
    const started = await call(socket, '_codeflower/files/upload', { name, size: data.length });
    if (started.error) return started;
    const { uploadId } = started.result;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const sent = await call(socket, '_codeflower/files/upload', {
        uploadId, offset, data: data.subarray(offset, offset + chunkSize).toString('base64')
      });
      assert.equal(sent.result.received, Math.min(offset + chunkSize, data.length));
    }
    return call(socket, '_codeflower/files/upload', { uploadId, finish: true });
  };

  const kit = (await upload('../../etc/SMART-Heart.pptx', 'slides of the heart')).result;
  assert.equal(kit.path, join(uploadsFolder, 'SMART-Heart.pptx'));
  assert.equal(kit.size, 19);
  assert.equal(kit.sha256, createHash('sha256').update('slides of the heart').digest('hex'));
  assert.equal(await readFile(kit.path, 'utf8'), 'slides of the heart');
  // The same name again is numbered, never overwritten; odd names stay in the folder.
  assert.equal((await upload('SMART-Heart.pptx', 'other slides')).result.name, 'SMART-Heart-1.pptx');
  assert.equal((await upload('C:\\Users\\ana\\.hidden\u0007.svg', '<svg/>')).result.name, 'hidden.svg');
  assert.match((await upload('big.zip', 'x'.repeat(65))).error.message, /larger than/);

  // Chunks out of order, or larger than announced, are refused.
  const { uploadId } = (await call(socket, '_codeflower/files/upload', { name: 'a.png', size: 4 })).result;
  assert.match((await call(socket, '_codeflower/files/upload', { uploadId, offset: 2, data: 'AA==' })).error.message, /Expected the chunk at byte 0/);
  assert.match((await call(socket, '_codeflower/files/upload', { uploadId, finish: true })).error.message, /0 of 4 bytes/);
  assert.deepEqual((await call(socket, '_codeflower/files/upload', { uploadId, cancel: true })).result, {});
  assert.match((await call(socket, '_codeflower/files/upload', { uploadId, offset: 0, data: 'AA==' })).error.message, /Unknown upload/);

  // Another window cannot continue this window's upload; a window that leaves takes its parts along.
  const started = (await call(socket, '_codeflower/files/upload', { name: 'b.png', size: 4 })).result;
  const other = await openSocket(bridge.address);
  await initialize(other);
  assert.match((await call(other, '_codeflower/files/upload', { uploadId: started.uploadId, offset: 0, data: 'AA==' })).error.message, /Unknown upload/);
  await closeSocket(other);
  await closeSocket(socket);
  await waitFor(async () => !(await readdir(uploadsFolder)).some((name) => name.endsWith('.part')));
  assert.deepEqual((await readdir(uploadsFolder)).sort(), ['SMART-Heart-1.pptx', 'SMART-Heart.pptx', 'hidden.svg']);
});

test('sends files and folders to writable folders only, asking before replacing, checked by hash', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDirectory = join(root, 'workspace');
  const output = join(root, 'output');
  const input = join(root, 'input');
  await mkdir(join(workspaceDirectory, '.git'), { recursive: true });
  await mkdir(output);
  await mkdir(input);
  const { bridge } = await startTestBridge(t, { workspace: workspaceDirectory, writableFolders: [output] });
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  const initialized = await initialize(socket);
  assert.deepEqual(initialized._meta['codeflower/files'], {
    upload: { maxBytes: 1024 * 1024 * 1024, chunkBytes: 1024 * 1024, folders: true },
    download: { chunkBytes: 1024 * 1024, folders: true }
  });

  // Chunks sent without waiting for each answer still land in order.
  const send = async (params, content, { chunkSize = 3, sha256 } = {}) => {
    const data = Buffer.from(content);
    const started = await call(socket, '_codeflower/files/upload', { ...params, size: data.length });
    if (started.error) return started;
    const { uploadId } = started.result;
    const chunks = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      chunks.push(call(socket, '_codeflower/files/upload', { uploadId, offset, data: data.subarray(offset, offset + chunkSize).toString('base64') }));
    }
    for (const sent of await Promise.all(chunks)) assert.equal(sent.error, undefined);
    return call(socket, '_codeflower/files/upload', {
      uploadId,
      finish: true,
      sha256: sha256 ?? createHash('sha256').update(data).digest('hex')
    });
  };

  // A dropped folder keeps its structure.
  const csv = (await send({ dir: workspaceDirectory, relativePath: 'data/run1/a.csv' }, 'x,y\n1,2\n')).result;
  assert.equal(csv.path, join(workspaceDirectory, 'data', 'run1', 'a.csv'));
  assert.equal(await readFile(csv.path, 'utf8'), 'x,y\n1,2\n');
  const listing = (await call(socket, '_codeflower/files/list', { path: workspaceDirectory })).result;
  assert.equal(listing.writable, true);
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.writable]), [['data', true]]);
  assert.equal((await call(socket, '_codeflower/files/list', { path: input })).result.writable, false);
  assert.equal((await call(socket, '_codeflower/files/list', { path: join(workspaceDirectory, '.git') })).result.writable, false);

  // Clashes are found first; then numbered, or replaced when the user chose so.
  const exists = await call(socket, '_codeflower/files/exists', { dir: workspaceDirectory, paths: ['data/run1/a.csv', 'b.txt', 'data'] });
  assert.deepEqual(exists.result.existing, [{ path: 'data/run1/a.csv', type: 'file' }, { path: 'data', type: 'directory' }]);
  assert.equal((await send({ dir: join(workspaceDirectory, 'data', 'run1'), name: 'a.csv' }, 'second')).result.name, 'a-1.csv');
  const replaced = (await send({ dir: workspaceDirectory, relativePath: 'data/run1/a.csv', conflict: 'replace' }, 'third')).result;
  assert.equal(replaced.replaced, true);
  assert.equal(await readFile(csv.path, 'utf8'), 'third');
  assert.equal((await send({ dir: output, name: 'table.tsv' }, 'a\tb')).result.path, join(output, 'table.tsv'));

  // Only the workspace and read-write mounts, never a hidden folder, never out through a link.
  assert.match((await send({ dir: input, name: 'x.txt' }, 'x')).error.message, /read-only/);
  assert.match((await send({ dir: workspaceDirectory, relativePath: '../x.txt' }, 'x')).error.message, /Hidden files and folders/);
  assert.match((await send({ dir: workspaceDirectory, relativePath: '.git/hooks/pre-commit' }, 'x')).error.message, /Hidden files/);
  assert.match((await send({ dir: join(workspaceDirectory, '.git'), name: 'config' }, 'x')).error.message, /read-only/);
  await symlink(input, join(workspaceDirectory, 'linked'));
  assert.match((await send({ dir: workspaceDirectory, relativePath: 'linked/deeper/x.txt' }, 'x')).error.message, /read-only/);
  assert.deepEqual(await readdir(input), []);
  await symlink(csv.path, join(workspaceDirectory, 'link.csv'));
  assert.match((await send({ dir: workspaceDirectory, name: 'link.csv', conflict: 'replace' }, 'x')).error.message, /not a file/);

  // A file that arrives damaged is not kept.
  assert.match((await send({ dir: output, name: 'damaged.txt' }, 'abc', { sha256: '0'.repeat(64) })).error.message, /damaged/);
  assert.deepEqual((await readdir(output)).sort(), ['table.tsv']);
});

test('sends files and folders to the window in chunks, a folder as a zip', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDirectory = join(root, 'workspace');
  const input = join(root, 'input');
  await mkdir(join(workspaceDirectory, 'results'), { recursive: true });
  await mkdir(join(input, 'run', 'figures'), { recursive: true });
  await mkdir(join(input, 'run', 'empty'));
  const big = Buffer.alloc(2.5 * 1024 * 1024, 7);
  await writeFile(join(workspaceDirectory, 'results', 'big.bin'), big);
  await writeFile(join(input, 'run', 'notes.txt'), 'six thousand cells');
  await writeFile(join(input, 'run', 'figures', 'umap.png'), 'not really a png');
  await writeFile(join(input, 'run', '.secret'), 'hidden');
  await symlink('/etc/passwd', join(input, 'run', 'passwd'));
  const { bridge } = await startTestBridge(t, { workspace: workspaceDirectory });
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  await initialize(socket);

  const fetchAll = async (path) => {
    const started = (await call(socket, '_codeflower/files/download', { path })).result;
    const parts = [];
    let offset = 0;
    for (;;) {
      const answer = await call(socket, '_codeflower/files/download', { downloadId: started.downloadId, offset });
      if (answer.error) return answer;
      const data = Buffer.from(answer.result.data, 'base64');
      parts.push(data);
      offset += data.length;
      if (answer.result.done) return { started, data: Buffer.concat(parts), sha256: answer.result.sha256 };
    }
  };

  const file = await fetchAll(join(workspaceDirectory, 'results', 'big.bin'));
  assert.deepEqual([file.started.kind, file.started.name, file.started.size], ['file', 'big.bin', big.length]);
  assert.ok(file.data.equals(big));
  assert.equal(file.sha256, createHash('sha256').update(big).digest('hex'));

  // Requests out of order, from another window, or for a file that changed meanwhile, are refused.
  const { downloadId } = (await call(socket, '_codeflower/files/download', { path: join(workspaceDirectory, 'results', 'big.bin') })).result;
  assert.match((await call(socket, '_codeflower/files/download', { downloadId, offset: 5 })).error.message, /Expected a request for byte 0/);
  const other = await openSocket(bridge.address);
  await initialize(other);
  assert.match((await call(other, '_codeflower/files/download', { downloadId, offset: 0 })).error.message, /Unknown download/);
  await closeSocket(other);
  await call(socket, '_codeflower/files/download', { downloadId, offset: 0 });
  await appendFile(join(workspaceDirectory, 'results', 'big.bin'), 'more');
  await call(socket, '_codeflower/files/download', { downloadId, offset: 1024 * 1024 });
  assert.match((await call(socket, '_codeflower/files/download', { downloadId, offset: 2 * 1024 * 1024 })).error.message, /changed while downloading/);

  // A folder, here a read-only input, comes as a zip of its visible files; links are not followed.
  const zip = await fetchAll(join(input, 'run'));
  assert.deepEqual([zip.started.kind, zip.started.name, zip.started.files], ['zip', 'run.zip', 2]);
  assert.equal(zip.sha256, createHash('sha256').update(zip.data).digest('hex'));
  const zipPath = join(root, 'run.zip');
  await writeFile(zipPath, zip.data);
  const unzip = (...args) =>
    new Promise((resolve, reject) => execFile('unzip', args, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  try {
    assert.deepEqual((await unzip('-Z1', zipPath)).trim().split('\n').sort(), ['empty/', 'figures/umap.png', 'notes.txt']);
    assert.equal(await unzip('-p', zipPath, 'notes.txt'), 'six thousand cells');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.diagnostic('unzip is not installed; the zip was not opened');
  }

  // Too many files for one zip are refused before anything is sent.
  const many = join(workspaceDirectory, 'many');
  await mkdir(many);
  await Promise.all(Array.from({ length: 10_001 }, (_, index) => writeFile(join(many, `${index}.txt`), '')));
  assert.match((await call(socket, '_codeflower/files/download', { path: many })).error.message, /more than 10000 files/);
});

test("saves the user's comments on a report into its store and its page, and nowhere else", async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'codeflower-workspace-'));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const output = join(workspaceDirectory, 'output');
  const input = join(workspaceDirectory, 'input');
  const { bridge, sessionsDirectory } = await startTestBridge(t, {
    workspace: join(workspaceDirectory, 'workspace'),
    writableFolders: [output]
  });
  const reports = join(workspaceDirectory, 'workspace', 'reports');
  await mkdir(join(reports, 'pbmc.report'), { recursive: true });
  await writeFile(join(reports, 'pbmc.report', 'report.json'), '{}');
  const page = (slot) => `<html><body><p>6,000 cells</p><script type="application/json" id="cf-comments">${slot}</script></body></html>`;
  await writeFile(join(reports, 'pbmc.html'), page('[]'));
  await writeFile(join(reports, 'loose.html'), page('[]'));
  await writeFile(join(reports, 'other.html'), '<html><body>no slot</body></html>');
  await mkdir(join(output, 'pbmc.report'), { recursive: true });
  await writeFile(join(output, 'pbmc.report', 'report.json'), '{}');
  await writeFile(join(output, 'pbmc.html'), page('[]'));
  await mkdir(input, { recursive: true });
  await writeFile(join(input, 'pbmc.html'), page('[]'));

  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const save = (path, comments) => call(socket, '_codeflower/reports/comments', { path, comments });
  const comments = JSON.stringify([{ id: 'c-1', kind: 'request', body: 'Say </script> kept', anchor: { exact: '6,000 cells' } }]);

  assert.equal((await save(join(reports, 'pbmc.html'), comments)).result.stored, true);
  assert.equal(JSON.parse(await readFile(join(reports, 'pbmc.report', 'comments.json'), 'utf8'))[0].body, 'Say </script> kept');
  assert.equal(
    await readFile(join(reports, 'pbmc.html'), 'utf8'),
    page('[{"id":"c-1","kind":"request","body":"Say \\u003c/script> kept","anchor":{"exact":"6,000 cells"}}]')
  );
  // A page without a store keeps them in the page only.
  assert.equal((await save(join(reports, 'loose.html'), '[]')).result.stored, false);
  // Reports in an output folder too, but not in a read-only one.
  assert.equal((await save(join(output, 'pbmc.html'), comments)).result.stored, true);
  assert.equal(JSON.parse(await readFile(join(output, 'pbmc.report', 'comments.json'), 'utf8'))[0].id, 'c-1');
  assert.match((await save(join(input, 'pbmc.html'), '[]')).error.message, /workspace or an output folder/);

  assert.match((await save(join(reports, 'other.html'), '[]')).error.message, /does not take comments/);
  assert.match((await save(join(reports, 'pbmc.report', 'report.json'), '[]')).error.message, /only be saved on HTML reports/);
  assert.match((await save(join(reports, 'pbmc.html'), '{"not": "a list"}')).error.message, /must be a list/);
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(join(sessionsDirectory, 'page.html'), page('[]'));
  assert.match((await save(join(sessionsDirectory, 'page.html'), '[]')).error.message, /cannot be shown|in the workspace/);
  await closeSocket(socket);
});

test('saves text files the user edited in the workspace and output folders, over the version they opened', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codeflower-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const output = join(root, 'output');
  const input = join(root, 'input');
  const { bridge, sessionsDirectory } = await startTestBridge(t, { workspace, writableFolders: [output] });
  for (const folder of [workspace, output, input]) await mkdir(folder, { recursive: true });
  await writeFile(join(workspace, 'run.sh'), 'echo one\n', { mode: 0o755 });
  await writeFile(join(output, 'notes.md'), '# Notes\n');
  await writeFile(join(input, 'meta.csv'), 'id\n1\n');

  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const stat_ = async (path) => (await call(socket, '_codeflower/files/stat', { path })).result;
  const write = (path, text, expectedMtimeMs) => call(socket, '_codeflower/files/write', { path, text, expectedMtimeMs });

  const script = await stat_(join(workspace, 'run.sh'));
  assert.equal(script.writable, true);
  assert.equal((await stat_(join(output, 'notes.md'))).writable, true);
  assert.equal((await stat_(join(input, 'meta.csv'))).writable, false);

  const saved = (await write(script.path, 'echo two\n', script.mtimeMs)).result;
  assert.equal(await readFile(join(workspace, 'run.sh'), 'utf8'), 'echo two\n');
  assert.equal(saved.size, 9);
  // The script stays executable.
  assert.equal((await stat(join(workspace, 'run.sh'))).mode & 0o777, 0o755);

  // The agent wrote the file since: the user's older version is not saved over it.
  const conflict = await write(script.path, 'echo three\n', script.mtimeMs);
  assert.match(conflict.error.message, /changed since you opened it/);
  assert.deepEqual(conflict.error.data, { conflict: true });
  assert.equal(await readFile(join(workspace, 'run.sh'), 'utf8'), 'echo two\n');

  const notes = await stat_(join(output, 'notes.md'));
  assert.ok((await write(notes.path, '# Notes\n\nMore.\n', notes.mtimeMs)).result);
  const meta = await stat_(join(input, 'meta.csv'));
  assert.match((await write(meta.path, 'id\n2\n', meta.mtimeMs)).error.message, /read-only/);
  assert.equal(await readFile(join(input, 'meta.csv'), 'utf8'), 'id\n1\n');
  assert.match((await write(notes.path, 'x'.repeat(10 * 1024 * 1024 + 1), notes.mtimeMs)).error.message, /at most 10 MB/);
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(join(sessionsDirectory, 'secret.txt'), 'private');
  assert.match((await write(join(sessionsDirectory, 'secret.txt'), 'x', 0)).error.message, /cannot be shown/);
  await closeSocket(socket);
});

test('does not report success when the report changes during every comment save attempt', async () => {
  const html = '<html><script type="application/json" id="cf-comments">[]</script></html>';
  let version = 0;
  let reads = 0;
  let writes = 0;
  await assert.rejects(
    writeCommentsSlot(
      '/report.html',
      '[]',
      { mtimeMs: 0, size: html.length },
      html,
      {
        stat: async () => ({ mtimeMs: ++version, size: html.length }),
        readFile: async () => {
          reads++;
          return html;
        },
        writeAtomic: async () => {
          writes++;
        }
      }
    ),
    /report kept changing while comments were saved/
  );
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

async function status(address, headers = { authorization: `Bearer ${token}` }) {
  const response = await fetch(`http://127.0.0.1:${address.port}/status`, { headers });
  return { code: response.status, body: response.ok ? await response.json() : undefined };
}

function text(message) {
  return message.params?.update?.content?.text;
}

test('keeps the agent and its chats working while no window is connected', async (t) => {
  const { bridge } = await startTestBridge(t);
  const first = await openSocket(bridge.address);
  const { pid } = await initialize(first);
  const sessionId = (await call(first, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const promptId = nextId++;
  send(first, { jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'long task' }] } });
  assert.equal(text(await receive(first, (message) => message.method === 'session/update')), 'started');
  const working = await receive(first, (message) => message.method === '_codeflower/activity' && message.params.working === 1);
  assert.deepEqual(working.params.chats, [{ key: sessionKey('claude', sessionId), state: 'working' }]);
  assert.match((await call(first, '_codeflower/agent/restart')).error.message, /still working/);
  assert.match((await call(first, '_codeflower/sessions/delete', { key: sessionKey('claude', sessionId) })).error.message, /still working/);
  await closeSocket(first);

  const { usage: _, ...unattended } = (await status(bridge.address)).body;
  assert.deepEqual(unattended, {
    agent: 'claude',
    agentLabel: 'Claude Code',
    connected: false,
    clients: 0,
    multiClient: true,
    running: true,
    working: 1,
    waiting: 0,
    chats: [{ key: sessionKey('claude', sessionId), state: 'working', title: 'long task' }],
    ended: [],
    turns: 0
  });

  // The next window gets the same agent and reattaches to the running turn.
  const second = await openSocket(bridge.address);
  assert.equal((await initialize(second)).pid, pid);
  const resumed = (await call(second, 'session/resume', { sessionId, cwd: '/workspace', mcpServers: [] })).result;
  assert.equal(resumed._meta['codeflower/busy'], true);
  assert.equal(resumed.configOptions[0].currentValue, 'default');
  const recorded = resumed._meta['codeflower/transcriptEntries'];
  assert.equal(recorded, 2);

  // Its own request with the id of the first window's prompt gets its own answer only.
  send(second, {
    jsonrpc: '2.0',
    id: promptId,
    method: 'session/set_config_option',
    params: { sessionId, configId: 'mode', value: 'plan' }
  });
  assert.equal((await receive(second, (message) => message.id === promptId)).result.configOptions[0].currentValue, 'plan');
  send(second, { jsonrpc: '2.0', method: 'fake/finish', params: { sessionId } });
  assert.equal(text(await receive(second, (message) => message.method === 'session/update')), 'done');
  await receive(second, (message) => message.method === '_codeflower/activity' && message.params.working === 0);
  assert.equal(inboxes.get(second).messages.filter((message) => message.id === promptId).length, 0);
  // Pollers (the client's notifications) see the turn that ended.
  const finished = (await status(bridge.address)).body;
  assert.deepEqual(finished.ended, [{ seq: 1, key: sessionKey('claude', sessionId), stopReason: 'end_turn', title: 'long task' }]);
  assert.equal(finished.turns, 1);

  // The transcript up to the reattach plus what came live is the whole chat.
  const entries = (await call(second, '_codeflower/sessions/transcript', { key: sessionKey('claude', sessionId) })).result.entries;
  assert.deepEqual(entries.slice(0, recorded).map((entry) => entry.kind), ['prompt', 'update']);
  assert.deepEqual(entries.slice(recorded).map((entry) => entry.kind), ['update', 'turn_end']);
  assert.equal(entries[recorded].update.content.text, 'done');

  // A reattach later reports the settings changed meanwhile.
  await closeSocket(second);
  const third = await openSocket(bridge.address);
  await initialize(third);
  const later = (await call(third, 'session/resume', { sessionId, cwd: '/workspace', mcpServers: [] })).result;
  assert.equal(later.configOptions[0].currentValue, 'plan');
  assert.equal(later._meta['codeflower/busy'], false);
  await closeSocket(third);
});

test('takes a message into the running turn and shows it in every window', async (t) => {
  const { bridge } = await startTestBridge(t);
  const first = await openSocket(bridge.address);
  const second = await openSocket(bridge.address);
  t.after(() => Promise.all([first, second].map(closeSocket)));
  for (const socket of [first, second]) await initialize(socket);
  const sessionId = (await call(first, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  await call(second, 'session/resume', { sessionId, cwd: '/workspace', mcpServers: [] });
  const steer = (text) => call(first, '_session/steering', { sessionId, prompt: [{ type: 'text', text }] });

  // Without a turn the window sends it as a prompt; the agent never starts one of its own.
  assert.deepEqual((await steer('too early')).result, { outcome: 'promptRequired', reason: 'noRunningTurn' });
  assert.deepEqual((await call(first, 'fake/steers', {})).result.steers, []);

  const longTask = nextId++;
  send(first, { jsonrpc: '2.0', id: longTask, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'long task' }] } });
  await receive(first, (message) => text(message) === 'started');
  const steered = await steer('also this');
  assert.equal(steered.result.outcome, 'injected');
  assert.equal(steered.result._meta['codeflower/prompted'], true);
  // The agent is asked to leave a message it cannot take in to the window.
  assert.deepEqual((await call(first, 'fake/steers', {})).result.steers[0]._meta, { steering: { idleBehavior: 'promptRequired' } });
  for (const socket of [first, second]) {
    const prompted = await receive(socket, (message) => message.method === '_codeflower/prompted' && message.params.prompt[0].text === 'also this');
    assert.equal(prompted.params.sessionId, sessionId);
    assert.equal(text(await receive(socket, (message) => text(message)?.startsWith('steered'))), 'steered by also this');
  }
  send(first, { jsonrpc: '2.0', method: 'fake/finish', params: { sessionId } });
  await receive(first, (message) => message.id === longTask);

  // The transcript has it where it came, inside the turn.
  const entries = (await call(second, '_codeflower/sessions/transcript', { key: sessionKey('claude', sessionId) })).result.entries;
  const prompts = entries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.prompt[0].text);
  assert.deepEqual(prompts, ['long task', 'also this']);
  assert.equal(entries.at(-1).kind, 'turn_end');
});

test('keeps several windows on one chat in sync', async (t) => {
  const { bridge } = await startTestBridge(t);
  const first = await openSocket(bridge.address);
  const second = await openSocket(bridge.address);
  const bystander = await openSocket(bridge.address);
  t.after(() => Promise.all([first, second, bystander].map(closeSocket)));
  for (const socket of [first, second, bystander]) await initialize(socket);
  const sessionId = (await call(first, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  await call(second, 'session/resume', { sessionId, cwd: '/workspace', mcpServers: [] });
  const key = sessionKey('claude', sessionId);
  const prompt = (socket, text, meta) => {
    const id = nextId++;
    send(socket, { jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }], ...meta } });
    return id;
  };
  const got = (socket, predicate) => inboxes.get(socket).messages.some(predicate);

  // A prompt from one window: both show it, then the agent's reply.
  const longTask = prompt(first, 'long task', { _meta: { 'codeflower/action': 'checkpoint' } });
  for (const socket of [first, second]) {
    const prompted = await receive(socket, (message) => message.method === '_codeflower/prompted');
    assert.deepEqual(prompted.params, {
      key,
      sessionId,
      prompt: [{ type: 'text', text: 'long task' }],
      _meta: { 'codeflower/action': 'checkpoint' }
    });
    assert.equal(text(await receive(socket, (message) => message.method === 'session/update')), 'started');
  }

  // One sent while the turn runs waits for its end.
  const queued = prompt(second, 'hello');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(got(first, (message) => message.method === '_codeflower/prompted'), false);
  send(first, { jsonrpc: '2.0', method: 'fake/finish', params: { sessionId } });
  assert.equal((await receive(first, (message) => message.id === longTask)).result.stopReason, 'end_turn');
  for (const socket of [first, second]) {
    assert.equal((await receive(socket, (message) => message.method === '_codeflower/prompted')).params.prompt[0].text, 'hello');
  }
  assert.equal(text(await receive(first, (message) => text(message)?.startsWith('reply'))), `reply to hello in ${sessionId}`);
  await receive(second, (message) => message.id === queued);
  assert.equal(got(first, (message) => message.id === queued), false);

  // Stop cancels the turn and the prompts waiting for it.
  const cancelled = prompt(first, 'cancel me');
  const waiting = prompt(second, 'never sent');
  await receive(second, (message) => message.method === '_codeflower/prompted' && message.params.prompt[0].text === 'cancel me');
  send(second, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  assert.equal((await receive(second, (message) => message.id === waiting)).result.stopReason, 'cancelled');
  assert.equal((await receive(first, (message) => message.id === cancelled)).result.stopReason, 'cancelled');

  // A change of settings in one window shows in the other.
  await call(first, 'session/set_config_option', { sessionId, configId: 'mode', value: 'plan' });
  const followed = await receive(second, (message) => message.params?.update?.sessionUpdate === 'config_option_update');
  assert.equal(followed.params.update.configOptions[0].currentValue, 'plan');

  // A permission request goes to both; the first answer wins and the other window closes it.
  const asking = prompt(first, 'ask permission');
  const asked = await receive(first, (message) => message.method === 'session/request_permission');
  const alsoAsked = await receive(second, (message) => message.method === 'session/request_permission');
  const requestKey = asked.params._meta['codeflower/requestKey'];
  assert.equal(alsoAsked.id, asked.id);
  assert.equal(alsoAsked.params._meta['codeflower/requestKey'], requestKey);
  const allow = { outcome: { outcome: 'selected', optionId: 'allow' } };
  send(second, { jsonrpc: '2.0', id: asked.id, result: allow });
  send(first, { jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'cancelled' } } });
  const resolved = await receive(first, (message) => message.method === '_codeflower/requestResolved');
  assert.deepEqual(resolved.params, { key, sessionId, requestKey, result: allow });
  assert.equal(text(await receive(first, (message) => text(message)?.startsWith('outcome'))), 'outcome allow');
  await receive(first, (message) => message.id === asking);
  assert.equal(got(second, (message) => message.method === '_codeflower/requestResolved'), false);

  // A shell command from one window runs live in the other.
  const ran = call(first, '_codeflower/shell/run', { sessionId, runId: 'run-1', command: 'echo hi' });
  const started = await receive(second, (message) => message.method === '_codeflower/shell/started');
  assert.deepEqual(started.params, { key, sessionId, runId: 'run-1', command: 'echo hi' });
  assert.equal((await receive(second, (message) => message.method === '_codeflower/shell/output')).params.data, 'hi\n');
  assert.equal((await receive(first, (message) => message.method === '_codeflower/shell/output')).params.data, 'hi\n');
  assert.equal((await ran).result.exitCode, 0);
  assert.equal((await receive(second, (message) => message.method === '_codeflower/shell/ended')).params.exitCode, 0);
  assert.equal(got(first, (message) => message.method?.startsWith('_codeflower/shell/') && message.method !== '_codeflower/shell/output'), false);

  // A window that did not open the chat gets none of it.
  const chatMethods = ['session/update', 'session/request_permission', '_codeflower/prompted', '_codeflower/shell/output'];
  assert.equal(got(bystander, (message) => chatMethods.includes(message.method)), false);
  assert.equal((await status(bridge.address)).body.clients, 3);

  // The transcript has each prompt once.
  const entries = (await call(second, '_codeflower/sessions/transcript', { key })).result.entries;
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.prompt[0].text),
    ['long task', 'hello', 'cancel me', 'ask permission']
  );
});

test('shows a plan to approve to the window of its chat, when the user may see it', async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'codeflower-workspace-'));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const { bridge, sessionsDirectory } = await startTestBridge(t, { workspace: workspaceDirectory });
  await mkdir(join(workspaceDirectory, 'plans'));
  const plan = join(workspaceDirectory, 'plans', 'tidy-plan.md');
  await writeFile(plan, '# The plan\n');
  // Claude Code's default, next to its login: not shown.
  const hidden = join(dirname(sessionsDirectory), 'harness-plan.md');
  await writeFile(hidden, '# Hidden\n');

  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  await initialize(socket);
  const sessionId = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const ask = async (path) => {
    send(socket, { jsonrpc: '2.0', id: nextId++, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: `approve plan in ${path}` }] } });
    const asked = await receive(socket, (message) => message.method === 'session/request_permission');
    return () => send(socket, { jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  };

  const answer = await ask(plan);
  const shown = await receive(socket, (message) => message.method === '_codeflower/show');
  assert.equal(shown.params.sessionId, sessionId);
  assert.ok(shown.params.files[0].path.endsWith('/plans/tidy-plan.md'));
  assert.equal(shown.params.files[0].writable, true);
  answer();
  await receive(socket, (message) => message.method === 'session/update' && text(message) === 'outcome allow');

  const answerHidden = await ask(hidden);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(inboxes.get(socket).messages.some((message) => message.method === '_codeflower/show'), false);
  answerHidden();
});

test('keeps questions for the user until a window opens their chat', async (t) => {
  const { bridge } = await startTestBridge(t);
  const first = await openSocket(bridge.address);
  await initialize(first);
  const sessionId = (await call(first, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  send(first, { jsonrpc: '2.0', id: nextId++, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'approve plan' }] } });
  const asked = await receive(first, (message) => message.method === 'session/request_permission');
  await closeSocket(first);

  assert.deepEqual((await status(bridge.address)).body.chats, [
    { key: sessionKey('claude', sessionId), state: 'waiting', waitingFor: 'plan', title: 'approve plan' }
  ]);

  const second = await openSocket(bridge.address);
  await initialize(second);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(inboxes.get(second).messages.some((message) => message.method === 'session/request_permission'), false);
  await call(second, 'session/resume', { sessionId, cwd: '/workspace', mcpServers: [] });
  const again = await receive(second, (message) => message.method === 'session/request_permission');
  assert.equal(again.id, asked.id);
  assert.equal(again.params._meta['codeflower/replayed'], true);
  send(second, { jsonrpc: '2.0', id: again.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.equal(text(await receive(second, (message) => message.method === 'session/update' && text(message))), 'outcome allow');
  await waitFor(async () => (await status(bridge.address)).body.chats.length === 0);
  const entries = (await call(second, '_codeflower/sessions/transcript', { key: sessionKey('claude', sessionId) })).result.entries;
  assert.deepEqual(
    entries.filter((entry) => entry.kind.startsWith('permission')).map((entry) => entry.kind),
    ['permission', 'permission_outcome']
  );
  await closeSocket(second);
});

test('reports its activity only to holders of the token', async (t) => {
  const { bridge } = await startTestBridge(t);
  assert.equal((await status(bridge.address, {})).code, 401);
  assert.equal((await status(bridge.address, { authorization: `Bearer ${'x'.repeat(43)}` })).code, 401);
  assert.equal((await fetch(`http://127.0.0.1:${bridge.address.port}/other`)).status, 404);
  const { body } = await status(bridge.address);
  const { usage, ...activity } = body;
  assert.deepEqual(activity, {
    agent: 'claude',
    agentLabel: 'Claude Code',
    connected: false,
    clients: 0,
    multiClient: true,
    running: false,
    working: 0,
    waiting: 0,
    chats: [],
    ended: [],
    turns: 0
  });
  // Numbers only: the account and the worker's totals, never a chat's.
  assert.deepEqual(Object.keys(usage).sort(), ['auth', 'costEstimate', 'limits', 'limitsUpdatedAt', 'totals']);
});

test('reports ended turns with their stop reason for a minute', async (t) => {
  const { bridge } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const sessionId = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const key = sessionKey('claude', sessionId);
  assert.ok((await call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'fail me' }] })).error);
  const cancelled = call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'cancel me' }] });
  await receive(socket, (message) => message.method === '_codeflower/activity' && message.params.working === 1);
  send(socket, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  assert.equal((await cancelled).result.stopReason, 'cancelled');
  const { ended, turns } = (await status(bridge.address)).body;
  assert.deepEqual(
    ended.map(({ seq, key, stopReason }) => ({ seq, key, stopReason })),
    [
      { seq: 1, key, stopReason: 'error' },
      { seq: 2, key, stopReason: 'cancelled' }
    ]
  );
  assert.equal(turns, 2);
  await closeSocket(socket);
});

test('forgets ended turns after a minute, keeping their count', () => {
  let clock = 0;
  const activity = createActivity(undefined, () => clock);
  activity.turnStarted('a', 's1');
  activity.turnEnded('a', 'end_turn');
  assert.deepEqual(activity.snapshot().ended, [{ seq: 1, sessionId: 's1', stopReason: 'end_turn' }]);
  clock = 60_000;
  assert.deepEqual(activity.snapshot().ended, []);
  assert.equal(activity.snapshot().turns, 1);
});

test('tracks token counts, cost, and quota, and records them with the session', async (t) => {
  const { bridge, directory } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const sessionId = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [], _meta: { mine: true } })).result.sessionId;
  const key = sessionKey('claude', sessionId);

  // The bridge asks Claude Code for its rate limit events and puts its plans in
  // the workspace, next to the window's own _meta.
  const metaReply = call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what meta' }] });
  const meta = JSON.parse(text(await receive(socket, (message) => message.method === 'session/update')));
  assert.deepEqual(meta, {
    mine: true,
    claudeCode: {
      emitRawSDKMessages: [{ type: 'rate_limit_event' }],
      options: { settings: { plansDirectory: 'plans' } }
    }
  });
  await metaReply;

  const answer = (await call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'use tokens' }] })).result;
  assert.equal(answer.usage.totalTokens, 170);
  const notified = await receive(socket, (message) => message.method === '_codeflower/usage');
  assert.equal(notified.params.sessions.find((session) => session.key === key)?.tokens.totalTokens, 170);

  const usage = (await call(socket, '_codeflower/usage')).result;
  assert.deepEqual(usage.auth, { kind: 'subscription', plan: 'max', label: 'Claude Max' });
  assert.equal(usage.costEstimate, true);
  assert.deepEqual(
    usage.limits.map((limit) => [limit.id, Math.round(limit.usedPercent), limit.status]),
    [['five_hour', 25, 'allowed'], ['seven_day', 80, 'allowed_warning']]
  );
  assert.deepEqual(usage.sessions, [
    {
      key,
      tokens: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 170 },
      cost: { amount: 0.25, currency: 'USD' },
      context: { used: 1000, size: 200000 }
    }
  ]);
  assert.equal(usage.totals.tokens.outputTokens, 20);
  // The raw SDK messages were for the bridge.
  assert.equal(inboxes.get(socket).messages.some((message) => message.method === '_claude/sdkMessage'), false);

  // The transcript and the session list keep the counts, for later workers.
  await waitFor(async () =>
    (await call(socket, '_codeflower/sessions/transcript', { key })).result.entries.some((entry) => entry.usage)
  );
  const turnEnd = (await call(socket, '_codeflower/sessions/transcript', { key })).result.entries.find((entry) => entry.usage);
  assert.deepEqual(turnEnd.cost, { amount: 0.25, currency: 'USD' });
  const listed = (await call(socket, '_codeflower/sessions/list')).result.sessions.find((session) => session.key === key);
  assert.equal(listed.usage.tokens.totalTokens, 170);
  assert.deepEqual(listed.usage.cost, { amount: 0.25, currency: 'USD' });

  // The quota outlives the worker in the project.
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(join(directory, 'usage', 'claude.json'), 'utf8')).limits.length === 2;
    } catch {
      return false;
    }
  });
  const { body } = await status(bridge.address);
  assert.equal(body.usage.auth.kind, 'subscription');
  assert.equal(body.usage.limits.length, 2);
  assert.equal(body.usage.sessions, undefined);
  await closeSocket(socket);
});

test("gives dsh's turns the token counts its usage plugin reports", async (t) => {
  const { bridge } = await startTestBridge(t, { agentName: 'dsh' });
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const sessionId = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const answer = (await call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'use tokens' }] })).result;
  // Its own call and its subagent's.
  assert.deepEqual(answer.usage, {
    inputTokens: 11,
    outputTokens: 6,
    cachedReadTokens: 2,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
    totalTokens: 19
  });
  const usage = (await call(socket, '_codeflower/usage')).result;
  assert.deepEqual(usage.auth, { kind: 'api_key' });
  assert.equal(usage.costEstimate, false);
  assert.equal(usage.totals.tokens.totalTokens, 19);
  await closeSocket(socket);
});

test('prints a link that adds the worker in the code flower app', () => {
  const line = connectionUrl('10.20.3.17', 41234, 'a+b/c=');
  assert.equal(line, 'codeflower://10.20.3.17:41234?token=a%2Bb%2Fc%3D');
  const link = new URL(clientLink(line));
  assert.equal(link.origin, 'http://127.0.0.1:7720');
  // The line, token included, travels only in the fragment, which the browser never sends.
  assert.equal(link.search, '');
  assert.equal(decodeURIComponent(link.hash.slice('#add='.length)), line);
});

test('prints a link that connects VS Code to the worker', () => {
  const line = connectionUrl('127.0.0.1', 41234, 'a+b/c=', 'x'.repeat(43));
  const link = new URL(vscodeLink(line));
  assert.equal(link.protocol, 'vscode:');
  assert.equal(link.host, 'codeflower.codeflower');
  assert.equal(link.pathname, '/connect');
  assert.equal(link.searchParams.get('address'), line);
});

test('serves TLS with the run\'s certificate, whose fingerprint its line carries', async (t) => {
  const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
  const cert = await readFile(join(fixtures, 'tls-cert.pem'), 'utf8');
  const key = await readFile(join(fixtures, 'tls-key.pem'), 'utf8');
  const fingerprint = certificateFingerprint(cert);
  assert.match(fingerprint, /^[A-Za-z0-9_-]{43}$/);
  const { bridge, directory } = await startTestBridge(t, { tls: { cert, key } });
  const { address } = bridge;

  // The line and the connection file name the fingerprint.
  assert.equal(address.fingerprint, fingerprint);
  assert.equal(address.url, connectionUrl('localhost', address.port, token, fingerprint));
  assert.match(address.url, /&fp=[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')).fingerprint, fingerprint);

  // Plain HTTP gets no answer; TLS with the pinned certificate does.
  const plain = await get(address, '/status', { authorization: `Bearer ${token}` }).catch((error) => error);
  assert.ok(plain instanceof Error || plain.code !== 200, 'answered plain HTTP');
  const pinned = await new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port: address.port, path: '/status', headers: { authorization: `Bearer ${token}` }, rejectUnauthorized: false },
      (response) => {
        const seen = certificateFingerprint(`-----BEGIN CERTIFICATE-----\n${response.socket.getPeerCertificate().raw.toString('base64')}\n-----END CERTIFICATE-----\n`);
        response.resume();
        resolve({ code: response.statusCode, seen });
      }
    );
    request.on('error', reject);
    request.end();
  });
  assert.deepEqual(pinned, { code: 200, seen: fingerprint });

  // The agent's environment never holds the key.
  const environment = agentEnvironment({ CODEFLOWER_TLS_CERT: cert, CODEFLOWER_TLS_KEY: key, PATH: '/usr/bin' });
  assert.equal(environment.CODEFLOWER_TLS_KEY, undefined);
  assert.equal(environment.CODEFLOWER_TLS_CERT, undefined);
});

// A request with any Host header, which fetch does not let a test set.
function get(address, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ code: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('serves the chat page only with --server, to the link\'s holder, on its own host', async (t) => {
  const plain = await startTestBridge(t);
  assert.equal((await get(plain.bridge.address, '/')).code, 404);

  const page = await mkdtemp(join(tmpdir(), 'codeflower-page-'));
  t.after(() => rm(page, { recursive: true, force: true }));
  await writeFile(join(page, 'index.html'), '<!doctype html><title>code flower</title>');
  let quit = 0;
  const { bridge } = await startTestBridge(t, { page: { directory: page }, onQuit: () => quit++ });
  const { address } = bridge;
  assert.equal(pageLink('node7.example', 8123, 'a+b'), 'http://node7.example:8123/?key=a%2Bb');

  // The page's files load without the key, and set no cookie (browsers send
  // cookies to every port of a host); the API needs the key as a bearer token.
  // A link with a wrong key says so.
  assert.equal((await get(address, '/?key=wrong')).code, 403);
  const opened = await get(address, `/?key=${token}`);
  assert.equal(opened.code, 200);
  assert.equal(opened.headers['set-cookie'], undefined);
  const index = await get(address, '/');
  assert.equal(index.code, 200);
  assert.match(index.body, /code flower/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await get(address, '/../package.json')).code, 404);
  const authorization = `Bearer ${token}`;
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { cookie: `codeflower-worker=${token}` }]) {
    assert.equal((await get(address, '/api/workers', headers)).code, 403);
  }

  // Another host name (DNS rebinding) is refused, even with the key.
  assert.equal((await get(address, '/api/workers', { authorization, host: `evil.example:${address.port}` })).code, 403);
  assert.equal((await get(address, '/', { host: `evil.example:${address.port}` })).code, 403);

  // The page API for one sandbox.
  const system = JSON.parse((await get(address, '/api/system', { authorization })).body);
  assert.deepEqual(system.capabilities, { connect: false, start: false, connectOnly: true, single: true });
  const [worker, ...others] = JSON.parse((await get(address, '/api/workers', { authorization })).body);
  assert.equal(others.length, 0);
  assert.equal(worker.id, 'local');
  assert.equal(worker.status, 'ready');
  assert.equal(worker.activity.agent, 'claude');
  assert.deepEqual(JSON.parse((await get(address, '/api/workers/local/sessions', { authorization })).body), { sessions: [] });
  const frame = await get(address, '/frame');
  assert.equal(frame.code, 200);
  assert.match(frame.headers['content-security-policy'], /default-src 'none'.*frame-ancestors 'self'/);

  // The agent, with a one-time ticket, from the page only.
  const origin = `http://127.0.0.1:${address.port}`;
  const ticket = async () =>
    (await (await fetch(`${origin}/api/ticket`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' })).json()).ticket;
  const url = `ws://127.0.0.1:${address.port}/api/workers/local/acp`;
  const used = await ticket();
  const socket = trackSocket(new WebSocket(`${url}?ticket=${used}`, { headers: { origin } }));
  await once(socket, 'open');
  assert.equal((await initialize(socket)).protocolVersion, 1);
  await closeSocket(socket);
  for (const [query, headers] of [
    [`?ticket=${await ticket()}`, { origin: 'http://evil.example' }],
    [`?ticket=${await ticket()}`, {}],
    [`?ticket=${used}`, { origin }],
    ['', { origin, authorization }]
  ]) {
    const refused = new WebSocket(`${url}${query}`, { headers });
    const [error] = await once(refused, 'error');
    assert.match(error.message, /Unexpected server response: 40[13]/);
  }

  // Quit with no chat working: the worker stops at once.
  const response = await fetch(`${origin}/api/quit`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ wrapUp: true })
  });
  assert.equal((await response.json()).stopping, true);
  await waitFor(() => quit === 1);
});
  const ticket = async () =>
    (await (await fetch(`${origin}/api/ticket`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' })).json()).ticket;

// ---- subagents (src/subagents) ----

const isUpdateOf = (sessionId) => (message) => message.method === 'session/update' && message.params?.sessionId === sessionId;

async function newChat(socket) {
  return (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
}

async function prompt(socket, sessionId, text) {
  return call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
}

test('asks the agent for subagents whichever window initializes it first', async (t) => {
  const { bridge } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);
  t.after(() => closeSocket(socket));
  // A window that does not show subagents: the agent is asked all the same.
  assert.equal((await initialize(socket)).subagents, true);
});

test("shows a chat's subagents in chats of their own, opened lazily, with summaries in the parent", async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t);
  const window = await openSocket(bridge.address);
  const old = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  t.after(() => closeSocket(old));
  await initialize(window, { subagents: {} });
  await initialize(old);
  const parentId = await newChat(window);
  await call(old, 'session/resume', { sessionId: parentId, cwd: '/workspace', mcpServers: [] });
  const parentKey = sessionKey('claude', parentId);
  const childKey = sessionKey('claude', 'child-1');

  const changed = receive(window, (message) => message.method === '_codeflower/subagents/changed' && message.params.subagent.state === 'idle');
  assert.equal((await prompt(window, parentId, 'spawn subagent')).result.stopReason, 'end_turn');
  const { params } = await changed;
  assert.equal(params.parentKey, parentKey);
  assert.equal(params.subagent.key, childKey);

  // The parent's windows hear of the child, never its own work.
  await call(window, '_codeflower/status');
  for (const socket of [window, old]) {
    assert.equal(inboxes.get(socket).messages.some(isUpdateOf('child-1')), false);
  }
  assert.equal(inboxes.get(window).messages.some((message) => message.params?.update?.sessionUpdate === 'subagent_update'), true);

  const [subagent] = (await call(window, '_codeflower/subagents/list', { key: parentKey })).result.subagents;
  assert.equal(subagent.key, childKey);
  assert.equal(subagent.parentKey, parentKey);
  assert.equal(subagent.title, 'Notes finder (Explore)');
  assert.equal(subagent.prompt, 'Find the notes');
  assert.equal(subagent.state, 'idle');
  assert.equal(subagent.stopReason, 'end_turn');
  assert.deepEqual(subagent.model, { value: 'small', name: 'Small model' });
  assert.deepEqual(subagent.effort, { value: 'low', name: 'Low' });
  assert.deepEqual(subagent.usage, { context: { used: 500, size: 100000 } });
  assert.equal(subagent.lastMessage, 'The notes are in notes.txt');
  assert.ok(subagent.startedAt && subagent.endedAt);

  // Its chat is recorded beside its parent's, out of the chat list.
  assert.deepEqual((await listSessions(sessionsDirectory)).map((session) => session.key), [parentKey]);
  const recorded = await readTranscript(sessionsDirectory, childKey);
  assert.deepEqual(
    recorded.map((entry) => entry.update?.sessionUpdate),
    ['session_message', 'config_option_update', 'usage_update', 'tool_call', 'agent_message_chunk', 'agent_message_chunk']
  );
  // The worker's usage is the chats'.
  assert.equal((await call(window, '_codeflower/usage')).result.sessions.some((session) => session.key === childKey), false);

  const opened = (await call(window, '_codeflower/subagents/open', { key: childKey })).result;
  assert.deepEqual(
    { live: opened.live, parentKey: opened.parentKey, entries: opened.transcriptEntries },
    { live: true, parentKey, entries: recorded.length }
  );
  assert.match((await call(old, '_codeflower/subagents/open', { key: childKey })).error.message, /does not show subagents/);
  assert.match((await call(window, '_codeflower/subagents/open', { key: parentKey })).error.message, /Not a subagent/);
});

test("a running subagent's updates reach the windows that opened it, its permissions its parent's, and it stops when asked", async (t) => {
  const { bridge } = await startTestBridge(t);
  const window = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  await initialize(window, { subagents: {} });
  const parentId = await newChat(window);
  const childKey = sessionKey('claude', 'child-1');

  const answered = prompt(window, parentId, 'spawn subagent child asks keep running');
  const permission = await receive(window, (message) => message.method === 'session/request_permission');
  assert.equal(permission.params.sessionId, 'child-1');
  assert.deepEqual(permission.params._meta['codeflower/parentSessionIds'], [parentId]);
  send(window, { jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.equal((await answered).result.stopReason, 'end_turn');
  const [running] = (await call(window, '_codeflower/subagents/list', { key: sessionKey('claude', parentId) })).result.subagents;
  assert.equal(running.state, 'running');

  await call(window, '_codeflower/subagents/open', { key: childKey });
  const said = receive(window, (message) => isUpdateOf('child-1')(message) && message.params.update.content?.text === 'still here');
  await call(window, 'fake/childSays', { childId: 'child-1', text: 'still here' });
  await said;

  // Closed: no more of its updates.
  await call(window, '_codeflower/subagents/close', { key: childKey });
  await call(window, 'fake/childSays', { childId: 'child-1', text: 'unheard' });
  await call(window, '_codeflower/status');
  assert.equal(inboxes.get(window).messages.some((message) => message.params?.update?.content?.text === 'unheard'), false);

  const stopped = receive(window, (message) => message.method === '_codeflower/subagents/changed' && message.params.subagent.state === 'idle');
  assert.equal((await call(window, '_codeflower/subagents/cancel', { key: childKey })).error, undefined);
  assert.equal((await stopped).params.subagent.stopReason, 'cancelled');
});

test("translates the draft form of subagents, and a subagent that cannot be stopped says so", async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t, { agentName: 'codex' });
  const window = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  await initialize(window, { subagents: {} });
  const parentId = await newChat(window);
  const parentKey = sessionKey('codex', parentId);
  await prompt(window, parentId, 'spawn draft subagent keep running');
  const [subagent] = (await call(window, '_codeflower/subagents/list', { key: parentKey })).result.subagents;
  assert.deepEqual({ title: subagent.title, prompt: subagent.prompt, state: subagent.state }, { title: 'Notes finder', prompt: 'Find the notes', state: 'running' });
  assert.match((await call(window, '_codeflower/subagents/cancel', { key: subagent.key })).error.message, /cannot stop/);

  const ended = receive(window, (message) => message.method === '_codeflower/subagents/changed' && message.params.subagent.state === 'idle');
  await call(window, 'fake/finishChild', { childId: 'child-1' });
  assert.equal((await ended).params.subagent.stopReason, 'end_turn');
  // Recorded in the canonical form.
  const kinds = async () => (await readTranscript(sessionsDirectory, parentKey)).map((entry) => entry.update?.sessionUpdate).filter(Boolean);
  await waitFor(async () => (await kinds()).filter((kind) => kind === 'subagent_update').length === 2);
  assert.equal((await kinds()).includes('subagent_spawned'), false);
});

test("dsh's command that exited badly reaches the windows and the transcript as failed", async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t, { agentName: 'dsh' });
  const window = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  await initialize(window);
  const sessionId = await newChat(window);
  const ended = receive(window, (message) => message.params?.update?.sessionUpdate === 'tool_call_update');
  await prompt(window, sessionId, 'run failing command');
  assert.equal((await ended).params.update.status, 'failed');
  const toolEnd = async () => (await readTranscript(sessionsDirectory, sessionKey('dsh', sessionId))).find((entry) => entry.update?.sessionUpdate === 'tool_call_update');
  await waitFor(async () => (await toolEnd()) !== undefined);
  const recorded = await toolEnd();
  assert.deepEqual({ status: recorded.update.status, rawOutput: recorded.update.rawOutput }, { status: 'failed', rawOutput: { exitCode: 1 } });
});

test('an agent without subagents in code flower keeps its own stream', async (t) => {
  const { bridge } = await startTestBridge(t, { agentName: 'dsh' });
  const window = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  assert.equal((await initialize(window, { subagents: {} })).subagents, true);
  assert.equal((await call(window, '_codeflower/status')).result.capabilities.subagents, undefined);
  assert.match((await call(window, '_codeflower/subagents/settings')).error.message, /no subagents/);
});

test('sets the default subagent model per session or for the next agent start, as the agent takes it', async (t) => {
  const { bridge } = await startTestBridge(t);
  const window = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  await initialize(window, { subagents: {} });
  const unset = (await call(window, '_codeflower/subagents/settings')).result;
  assert.deepEqual(unset.settings, { model: 'same', effort: 'same' });
  const set = (await call(window, '_codeflower/subagents/settings', { settings: { model: 'small' } })).result;
  assert.deepEqual({ settings: set.settings, restartPending: set.restartPending }, { settings: { model: 'small', effort: 'same' }, restartPending: false });
  const sessionId = await newChat(window);
  const reply = receive(window, (message) => isUpdateOf(sessionId)(message) && message.params.update.sessionUpdate === 'agent_message_chunk');
  await prompt(window, sessionId, 'what meta');
  const told = JSON.parse((await reply).params.update.content.text);
  assert.equal(told.claudeCode.options.env.CLAUDE_CODE_SUBAGENT_MODEL, 'small');
  assert.deepEqual(told.claudeCode.options.settings, { plansDirectory: 'plans' });
});

test('a setting the agent reads at start waits for its restart', async (t) => {
  const { bridge } = await startTestBridge(t, { agentName: 'codex' });
  const window = await openSocket(bridge.address);
  // Codex's own config from its descriptor (multi_agent_v2), to which the settings add theirs.
  assert.deepEqual(JSON.parse((await initialize(window, { subagents: {} })).codexConfig), { 'features.multi_agent_v2': true });
  const changed = receive(window, (message) => message.method === '_codeflower/subagents/settingsChanged');
  const set = (await call(window, '_codeflower/subagents/settings', { settings: { model: 'gpt-small', effort: 'low' } })).result;
  assert.equal(set.restartPending, true);
  assert.deepEqual(set.features.settings, { model: { applies: 'restart' }, effort: { applies: 'restart' } });
  assert.equal((await changed).params.restartPending, true);
  const ended = once(window, 'close');
  await call(window, '_codeflower/agent/restart');
  await ended;
  const again = await openSocket(bridge.address);
  t.after(() => closeSocket(again));
  assert.deepEqual(JSON.parse((await initialize(again, { subagents: {} })).codexConfig), {
    'features.multi_agent_v2': true,
    'agents.default_subagent_model': 'gpt-small',
    'agents.default_subagent_reasoning_effort': 'low'
  });
  assert.equal((await call(again, '_codeflower/subagents/settings')).result.restartPending, false);
});

test("deleting a chat deletes its subagents' chats", async (t) => {
  const { bridge, sessionsDirectory } = await startTestBridge(t);
  const window = await openSocket(bridge.address);
  t.after(() => closeSocket(window));
  await initialize(window, { subagents: {} });
  const parentId = await newChat(window);
  await prompt(window, parentId, 'spawn subagent');
  await waitFor(async () => (await readdir(sessionsDirectory)).length === 2);
  assert.equal((await call(window, '_codeflower/sessions/delete', { key: sessionKey('claude', parentId) })).error, undefined);
  assert.deepEqual(await readdir(sessionsDirectory), []);
});
