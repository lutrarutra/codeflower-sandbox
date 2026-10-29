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
import { writeCommentsSlot } from '../src/files.js';
import { agentEnvironment, startBridge } from '../src/server.js';
import { readTranscript, sessionKey } from '../src/sessions.js';

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

  // The newest window takes the worker over.
  const replaced = await openSocket(bridge.address);
  const replacedClosed = once(replaced, 'close');
  const socket = await openSocket(bridge.address);
  assert.equal((await replacedClosed)[0], 4001);

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

test('starts and records an initial prompt in a session that VS Code can resume', async (t) => {
  const { bridge, directory, sessionsDirectory } = await startTestBridge(t, {
    initialPrompt: 'Analyse the input and generate a report'
  });
  assert.equal(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')).initialPrompt, true);
  const nativeSessionId = 'session-1';
  const key = sessionKey('claude', nativeSessionId);
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

  assert.deepEqual(
    (await call(socket, '_codeflower/sessions/transcript', { key: firstKey })).result.entries.map((entry) => entry.kind),
    ['prompt', 'update', 'turn_end', 'prompt', 'turn_end']
  );
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

test("saves the user's comments on a report into its store and its page, and nowhere else", async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'codeflower-workspace-'));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const { bridge, sessionsDirectory } = await startTestBridge(t, { workspace: workspaceDirectory });
  const reports = join(workspaceDirectory, 'reports');
  await mkdir(join(reports, 'pbmc.report'), { recursive: true });
  await writeFile(join(reports, 'pbmc.report', 'report.json'), '{}');
  const page = (slot) => `<html><body><p>6,000 cells</p><script type="application/json" id="cf-comments">${slot}</script></body></html>`;
  await writeFile(join(reports, 'pbmc.html'), page('[]'));
  await writeFile(join(reports, 'loose.html'), page('[]'));
  await writeFile(join(reports, 'other.html'), '<html><body>no slot</body></html>');

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

  assert.match((await save(join(reports, 'other.html'), '[]')).error.message, /does not take comments/);
  assert.match((await save(join(reports, 'pbmc.report', 'report.json'), '[]')).error.message, /only be saved on HTML reports/);
  assert.match((await save(join(reports, 'pbmc.html'), '{"not": "a list"}')).error.message, /must be a list/);
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(join(sessionsDirectory, 'page.html'), page('[]'));
  assert.match((await save(join(sessionsDirectory, 'page.html'), '[]')).error.message, /cannot be shown|in the workspace/);
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
    running: true,
    working: 1,
    waiting: 0,
    chats: [{ key: sessionKey('claude', sessionId), state: 'working', title: 'long task' }]
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
  assert.deepEqual(activity, { agent: 'claude', agentLabel: 'Claude Code', connected: false, running: false, working: 0, waiting: 0, chats: [] });
  // Numbers only: the account and the worker's totals, never a chat's.
  assert.deepEqual(Object.keys(usage).sort(), ['auth', 'costEstimate', 'limits', 'limitsUpdatedAt', 'totals']);
});

test('tracks token counts, cost, and quota, and records them with the session', async (t) => {
  const { bridge, directory } = await startTestBridge(t);
  const socket = await openSocket(bridge.address);
  await initialize(socket);
  const sessionId = (await call(socket, 'session/new', { cwd: '/workspace', mcpServers: [], _meta: { mine: true } })).result.sessionId;
  const key = sessionKey('claude', sessionId);

  // The bridge asks Claude Code for its rate limit events, next to the window's own _meta.
  const metaReply = call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what meta' }] });
  const meta = JSON.parse(text(await receive(socket, (message) => message.method === 'session/update')));
  assert.deepEqual(meta, { mine: true, claudeCode: { emitRawSDKMessages: [{ type: 'rate_limit_event' }] } });
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
