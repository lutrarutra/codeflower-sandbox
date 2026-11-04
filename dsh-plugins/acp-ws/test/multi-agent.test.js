// One worker, several agents: each window speaks to one (`/acp?agent=NAME`)
// or to none (`/acp`, the worker's own requests), and nothing of one agent
// reaches another's windows, though both name their first chat session-1.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const token = 'm'.repeat(43);

async function startTwoAgents(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-multi-'));
  const environment = {
    ...process.env,
    CODEFLOWER_TOKEN: token,
    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEX_HOME: join(directory, 'codex')
  };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const all = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent, codex: fakeAgent }, environment });
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-multi',
    sessionsDirectory: join(directory, 'sessions'),
    agents: { claude: all.claude, codex: all.codex },
    wrapUpQuitTemplate: 'Wrap up within {{minutes}} minutes.',
    environment,
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message),
    ...overrides
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  return bridge;
}

const inboxes = new WeakMap();

async function connect(bridge, agent) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/acp${agent ? `?agent=${agent}` : ''}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const inbox = { messages: [], waiters: [] };
  inboxes.set(socket, inbox);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = inbox.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) inbox.messages.push(message);
    else inbox.waiters.splice(index, 1)[0].resolve(message);
  });
  await once(socket, 'open');
  return socket;
}

function receive(socket, predicate) {
  const inbox = inboxes.get(socket);
  const index = inbox.messages.findIndex(predicate);
  if (index !== -1) return Promise.resolve(inbox.messages.splice(index, 1)[0]);
  return new Promise((resolve) => inbox.waiters.push({ predicate, resolve }));
}

const received = (socket, predicate) => inboxes.get(socket).messages.some(predicate);

let nextId = 1;
async function call(socket, method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return receive(socket, (message) => message.id === id && message.method === undefined);
}

async function newChat(socket) {
  await call(socket, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  return (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
}

function prompt(socket, sessionId, text) {
  const id = nextId++;
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }));
  return receive(socket, (message) => message.id === id && message.method === undefined);
}

async function status(bridge) {
  const response = await fetch(`http://127.0.0.1:${bridge.address.port}/status`, { headers: { authorization: `Bearer ${token}` } });
  return response.json();
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met in time');
}

const updateText = (message) => message.params?.update?.content?.text;

test("the worker's own window starts no agent and tells of them all", async (t) => {
  const bridge = await startTwoAgents(t);
  const control = await connect(bridge);
  const { agents } = (await call(control, '_codeflower/agents')).result;
  assert.deepEqual(
    agents.map(({ id, name, running, credentials }) => ({ id, name, running, credentials })),
    [
      { id: 'claude', name: 'Claude Code', running: false, credentials: 'agent' },
      { id: 'codex', name: 'Codex', running: false, credentials: 'agent' }
    ]
  );
  for (const agent of agents) {
    assert.equal(agent.signedIn, false);
    assert.match(agent.icon, /^data:image\/svg\+xml;base64,/);
  }
  // Its status has the worker's fields and the agents, not one agent's.
  const workerStatus = (await call(control, '_codeflower/status')).result;
  assert.equal(workerStatus.agent, undefined);
  assert.equal(workerStatus.agents.length, 2);
  assert.equal(workerStatus.capabilities.shellTerminals, false);
  // ACP needs an agent.
  assert.match((await call(control, 'initialize', { protocolVersion: 1 })).error.message, /connect with \/acp\?agent=NAME/);
  // An agent's own request needs to know which.
  assert.match((await call(control, '_codeflower/usage')).error.message, /name the agent/);
  assert.equal((await call(control, '_codeflower/usage', { agent: 'codex' })).result.costEstimate, false);
  assert.deepEqual((await status(bridge)).agents.map(({ id, running }) => [id, running]), [['claude', false], ['codex', false]]);

  // An agent's window starts that agent only, and every window hears of it.
  const codex = await connect(bridge, 'codex');
  await call(codex, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const changed = await receive(control, (message) => message.method === '_codeflower/agents' && message.params.agents[1].running);
  assert.equal(changed.params.agents[0].running, false);
  assert.equal((await call(codex, '_codeflower/status')).result.agent, 'codex');
  control.close();
  codex.close();
});

test('two agents run chats with the same session id side by side', async (t) => {
  const bridge = await startTwoAgents(t);
  const claude = await connect(bridge, 'claude');
  const codex = await connect(bridge, 'codex');
  const claudeChat = await newChat(claude);
  const codexChat = await newChat(codex);
  assert.equal(claudeChat, 'session-1');
  assert.equal(codexChat, 'session-1');

  void prompt(claude, claudeChat, 'long task');
  const codexTurn = prompt(codex, codexChat, 'long task');
  assert.equal(updateText(await receive(claude, (message) => message.method === 'session/update')), 'started');
  assert.equal(updateText(await receive(codex, (message) => message.method === 'session/update')), 'started');
  await waitFor(async () => (await status(bridge)).working === 2);
  assert.deepEqual(
    (await status(bridge)).chats.map((chat) => chat.key).sort(),
    [sessionKey('claude', 'session-1'), sessionKey('codex', 'session-1')]
  );

  // One ends; the other still works, and each window saw only its own chat.
  codex.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'fake/finish', params: { sessionId: codexChat } }));
  assert.equal((await codexTurn).result.stopReason, 'end_turn');
  await waitFor(async () => (await status(bridge)).working === 1);
  assert.deepEqual((await status(bridge)).chats.map((chat) => chat.key), [sessionKey('claude', 'session-1')]);
  assert.equal(received(claude, (message) => updateText(message) === 'done'), false);

  // The worker's window lists both chats, and reads either by its key.
  const control = await connect(bridge);
  const { sessions } = (await call(control, '_codeflower/sessions/list')).result;
  assert.deepEqual(sessions.map((session) => session.harness).sort(), ['claude', 'codex']);
  const transcript = (await call(control, '_codeflower/sessions/transcript', { key: sessionKey('codex', 'session-1') })).result;
  assert.ok(transcript.entries.some((entry) => entry.update && updateText({ params: entry }) === 'done'));
  for (const socket of [claude, codex, control]) socket.close();
});

test("a permission request goes only to its agent's windows", async (t) => {
  const bridge = await startTwoAgents(t);
  const claude = await connect(bridge, 'claude');
  const codex = await connect(bridge, 'codex');
  const claudeChat = await newChat(claude);
  const codexChat = await newChat(codex);
  const answered = prompt(codex, codexChat, 'ask permission');
  const asked = await receive(codex, (message) => message.method === 'session/request_permission');
  await waitFor(async () => (await status(bridge)).waiting === 1);
  assert.equal(received(claude, (message) => message.method === 'session/request_permission'), false);
  codex.send(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
  await answered;
  assert.equal((await status(bridge)).waiting, 0);
  // The other agent's chat still answers.
  assert.equal((await prompt(claude, claudeChat, 'hello')).result.stopReason, 'end_turn');
  claude.close();
  codex.close();
});

test("restarting one agent leaves the other's windows and chats alone", async (t) => {
  const bridge = await startTwoAgents(t);
  const claude = await connect(bridge, 'claude');
  const codex = await connect(bridge, 'codex');
  const claudeChat = await newChat(claude);
  await newChat(codex);
  const claudeTurn = prompt(claude, claudeChat, 'long task');
  await receive(claude, (message) => message.method === 'session/update');
  // Codex is idle: it restarts though Claude Code works.
  assert.deepEqual((await call(codex, '_codeflower/agent/restart')).result, {});
  await once(codex, 'close');
  assert.equal(claude.readyState, WebSocket.OPEN);
  claude.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'fake/finish', params: { sessionId: claudeChat } }));
  assert.equal((await claudeTurn).result.stopReason, 'end_turn');
  // Claude Code, which works, does not restart.
  void prompt(claude, claudeChat, 'long task');
  await waitFor(async () => (await status(bridge)).working === 1);
  assert.match((await call(claude, '_codeflower/agent/restart')).error.message, /still working/);
  claude.close();
});

test('a wrap-up asks the working chats of every agent', async (t) => {
  const bridge = await startTwoAgents(t);
  const claude = await connect(bridge, 'claude');
  const codex = await connect(bridge, 'codex');
  // Turns the wrap-up can stop.
  void prompt(claude, await newChat(claude), 'cancel me');
  void prompt(codex, await newChat(codex), 'cancel me');
  await waitFor(async () => (await status(bridge)).working === 2);
  const response = await fetch(`http://127.0.0.1:${bridge.address.port}/wrap-up`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'quit', minutes: 5 })
  });
  assert.deepEqual(await response.json(), { chats: 2 });
  // Every window hears of each chat's wrap-up prompt.
  const asked = () => receive(claude, (message) => message.method === '_codeflower/wrapUp' && message.params.prompt);
  const keys = [(await asked()).params.key, (await asked()).params.key].sort();
  assert.deepEqual(keys, [sessionKey('claude', 'session-1'), sessionKey('codex', 'session-1')]);
  claude.close();
  codex.close();
});

test('an unknown agent is refused, and one that cannot run says why', async (t) => {
  const environment = { ...process.env, CODEFLOWER_TOKEN: token };
  const all = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent, codex: fakeAgent }, environment });
  const bridge = await startTwoAgents(t, {
    agents: { claude: { ...all.claude, unavailable: 'Claude Code is not installed in this sandbox.' }, codex: all.codex }
  });
  const unknown = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/acp?agent=nonsense`, { headers: { authorization: `Bearer ${token}` } });
  const [error] = await once(unknown, 'error');
  assert.match(error.message, /Unexpected server response: 404/);

  const claude = await connect(bridge, 'claude');
  const [code] = await once(claude, 'close');
  assert.equal(code, 4004);
  const control = await connect(bridge);
  const [described] = (await call(control, '_codeflower/agents')).result.agents;
  assert.equal(described.unavailable, 'Claude Code is not installed in this sandbox.');
  control.close();
});
