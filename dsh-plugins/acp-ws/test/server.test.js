import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

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

async function openSocketAfterReconnect(address) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp`, {
      headers: { authorization: `Bearer ${token}` }
    });
    try {
      await once(socket, 'open');
      return trackSocket(socket);
    } catch (error) {
      if (!error.message.includes('503') && !error.message.includes('ECONNREFUSED')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('ACP bridge did not become available for reconnect');
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
    dshBin: fakeAgent,
    claudeAcpBin: fakeAgent,
    codexAcpBin: fakeAgent,
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
  const { bridge, directory } = await startTestBridge(t, { agentName: 'codex' });
  const connection = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'));
  assert.equal((await stat(join(directory, 'instance.json'))).mode & 0o777, 0o600);
  assert.equal(connection.agent, 'codex');
  assert.equal(connection.url, `codeflower://localhost:${bridge.address.port}?token=${token}`);

  const socket = await openSocket(bridge.address);
  const competing = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/acp`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.match((await once(competing, 'error'))[0].message, /503/);

  const initialized = await initialize(socket);
  assert.deepEqual(initialized.credentialVariables, []);
  assert.equal(initialized.leakedLauncherToken, null);
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

  assert.deepEqual(
    (await call(socket, '_codeflower/sessions/transcript', { key: firstKey })).result.entries.map((entry) => entry.kind),
    ['prompt', 'update', 'turn_end', 'prompt', 'turn_end']
  );
  assert.deepEqual((await call(socket, '_codeflower/sessions/rename', { key: firstKey, title: 'Greeting' })).result, {});
  assert.match((await call(socket, '_codeflower/sessions/delete', { key: firstKey })).error.message, /open on a worker/);
  assert.match((await call(socket, '_codeflower/sessions/rename', { key: 'codex-x', title: 'y' })).error.message, /Invalid/);
  await closeSocket(socket);

  // A later connection resumes the session; once released it can be deleted.
  const again = await openSocketAfterReconnect(bridge.address);
  await initialize(again);
  assert.deepEqual((await call(again, 'session/resume', { sessionId: first, cwd: '/workspace', mcpServers: [] })).result, {});
  await closeSocket(again);
  await waitFor(async () => !(await readFile(join(sessionsDirectory, firstKey, 'lease.json')).catch(() => null)));
  const third = await openSocketAfterReconnect(bridge.address);
  assert.deepEqual((await call(third, '_codeflower/sessions/delete', { key: firstKey })).result, {});
  assert.equal((await call(third, '_codeflower/sessions/list')).result.sessions.length, 1);
  await closeSocket(third);
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
  assert.deepEqual((await call(socket, 'session/resume', { sessionId: 'busy', cwd: '/w', mcpServers: [] })).result, {});
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
  assert.equal((await call(socket, '_codeflower/status')).result.signedIn, true);
  await closeSocket(socket);

  const again = await openSocketAfterReconnect(bridge.address);
  const initialized = await initialize(again);
  assert.ok(initialized.argv.includes('--patch'));
  assert.deepEqual(initialized.credentialVariables, []);
  await closeSocket(again);
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
  assert.match((await show('figures/umap.svg')).stderr, /No VS Code window is connected/);

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
