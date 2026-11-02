import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { createParser } from '../src/agents/opencode/events.js';
import { createChatTerminals } from '../src/chat-terminals.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const fakeTui = fileURLToPath(new URL('../fixtures/fake-tui.js', import.meta.url));
const ptyHelper = ['python3', fileURLToPath(new URL('../../../bin/codeflower-pty', import.meta.url))];
const token = 'k'.repeat(43);

// ---- a window: a WebSocket that keeps what it was sent ----

function window(address) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp`, { headers: { authorization: `Bearer ${token}` } });
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  let nextId = 1;
  const self = {
    socket,
    messages,
    opened: once(socket, 'open'),
    send: (message) => socket.send(JSON.stringify(message)),
    receive(predicate, timeout = 5000) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          if (waiters.includes(waiter)) reject(new Error('nothing came in time'));
        }, timeout).unref();
      });
    },
    async call(method, params = {}) {
      const id = `w-${nextId++}`;
      self.send({ jsonrpc: '2.0', id, method, params });
      const answer = await self.receive((message) => message.id === id && message.method === undefined);
      if (answer.error) throw new Error(answer.error.message);
      return answer.result;
    },
    // Everything a terminal printed to this window so far.
    output: (terminalId) =>
      messages
        .filter((message) => message.method === '_codeflower/terminal/output' && message.params.terminalId === terminalId)
        .map((message) => message.params.data)
        .join(''),
    async printed(terminalId, pattern) {
      const deadline = Date.now() + 5000;
      while (!pattern.test(self.output(terminalId))) {
        if (Date.now() > deadline) throw new Error(`terminal did not print ${pattern}: ${JSON.stringify(self.output(terminalId))}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    }
  };
  return self;
}

async function startTestBridge(t) {
  // Real, so the paths the bridge resolves match (macOS links /var to /private/var).
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-chat-terminals-')));
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const showSocket = join(directory, 'show.sock');
  const { claude } = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  // The agent's own events, as OpenCode's server reports them (agent.watch).
  const backend = { emit: undefined };
  const agent = {
    ...claude,
    // Shared, as OpenCode's: the handoff of Claude Code's has tests of its own.
    handoff: false,
    tuiCommand: async ({ sessionId }) => [process.execPath, fakeTui, sessionId],
    watch: ({ emit }) => {
      backend.emit = emit;
      return () => {};
    }
  };
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-test',
    sessionsDirectory: join(directory, 'sessions'),
    agentName: 'claude',
    agent,
    ptyHelper,
    environment,
    workspace,
    showSocket,
    hookSocket: join(directory, 'hook.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { bridge, backend, workspace, showSocket };
}

async function open(t, bridge) {
  const self = window(bridge.address);
  t.after(() => self.close());
  await self.opened;
  return self;
}

// ---- OpenCode's events ----

const event = (payload) => JSON.stringify({ directory: '/w', project: 'global', payload });

test("reads the user's message, busy and idle, and permissions answered in the terminal from OpenCode's events", () => {
  const events = [];
  const parse = createParser((emitted) => events.push(emitted));
  const sessionID = 'ses_1';
  // As OpenCode 1.19 sends them for a turn typed in its terminal UI.
  parse(event({ type: 'message.updated', properties: { sessionID, info: { id: 'msg_u', role: 'user', sessionID } } }));
  parse(event({ type: 'sync', syncEvent: { type: 'message.updated.1' } }));
  parse(event({ type: 'message.part.updated', properties: { sessionID, part: { type: 'text', text: 'hello', messageID: 'msg_u', sessionID } } }));
  // The same part again (the message gets a summary later) is not a new prompt.
  parse(event({ type: 'message.part.updated', properties: { sessionID, part: { type: 'text', text: 'hello', messageID: 'msg_u', sessionID } } }));
  parse(event({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }));
  parse(event({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }));
  parse(event({ type: 'message.updated', properties: { sessionID, info: { id: 'msg_a', role: 'assistant', sessionID } } }));
  parse(event({ type: 'message.part.updated', properties: { sessionID, part: { type: 'text', text: 'answer', messageID: 'msg_a', sessionID } } }));
  parse(event({ type: 'permission.asked', properties: { id: 'per_1', sessionID, permission: 'bash', tool: { messageID: 'msg_a', callID: 'call2' } } }));
  parse(event({ type: 'permission.replied', properties: { sessionID, requestID: 'per_1', reply: 'once' } }));
  parse(event({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }));
  parse('not json');
  assert.deepEqual(events, [
    { type: 'prompt', sessionId: sessionID, messageId: 'msg_u', prompt: [{ type: 'text', text: 'hello' }] },
    { type: 'busy', sessionId: sessionID },
    { type: 'permissionReplied', sessionId: sessionID, toolCallId: 'call2', reply: 'once' },
    { type: 'idle', sessionId: sessionID }
  ]);
});

// ---- the registry ----

test("keeps a chat's terminal running without windows, replays it to the next, and lets watchers only watch", async (t) => {
  const changes = [];
  const terminals = createChatTerminals({ ptyHelper, onChange: () => changes.push(terminals.list().length) });
  t.after(() => terminals.closeAll());
  const sent = (client) => client.messages.map((message) => message.params?.data ?? '').join('');
  const client = () => ({ messages: [], send(message) { this.messages.push(message); } });
  const first = client();
  const terminal = terminals.start({
    key: 'claude-s1',
    sessionId: 's1',
    command: [process.execPath, fakeTui, 's1'],
    env: process.env,
    size: { columns: 90, rows: 25 }
  });
  assert.throws(() => terminals.start({ key: 'claude-s1', sessionId: 's1', command: ['true'], env: process.env, size: { columns: 80, rows: 24 } }), /already/);
  terminals.attach(terminal, first, { size: { columns: 90, rows: 25 } });
  const until = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('not in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await until(() => /tui for s1 at 90x25/.test(sent(first)));

  terminals.resize(terminal, first, { columns: 120, rows: 40 });
  await until(() => /resized to 120x40/.test(sent(first)));
  terminals.input(terminal, first, 'hello\r');
  await until(() => /typed hello/.test(sent(first)));

  // Gone: it keeps running, and the next window gets what it printed.
  terminals.detachClient(first);
  const second = client();
  terminals.attach(terminal, second, { size: { columns: 120, rows: 40 }, watch: true });
  assert.equal(second.messages[0].params.replayed, true);
  assert.match(second.messages[0].params.data, /tui for s1[\s\S]*typed hello/);
  // A watcher cannot type or resize.
  terminals.input(terminal, second, 'ignored\r');
  terminals.resize(terminal, second, { columns: 30, rows: 10 });
  assert.equal(terminals.list()[0].viewers, 1);

  const third = client();
  terminals.attach(terminal, third, { size: { columns: 100, rows: 30 } });
  await until(() => /resized to 100x30/.test(sent(third)));
  terminals.input(terminal, third, 'quit\r');
  await until(() => third.messages.some((message) => message.method === '_codeflower/terminal/exit'));
  assert.deepEqual(third.messages.at(-1).params, { terminalId: terminal.id, exitCode: 3 });
  assert.ok(second.messages.some((message) => message.method === '_codeflower/terminal/exit'));
  assert.doesNotMatch(sent(third), /typed ignored/);
  assert.deepEqual(terminals.list(), []);
  assert.equal(changes.at(-1), 0);
});

// ---- the bridge ----

test("opens the agent's terminal UI on a chat, which outlives the window, and on a new chat", async (t) => {
  const { bridge } = await startTestBridge(t);
  const chat = await open(t, bridge);
  await chat.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal((await chat.call('_codeflower/status')).capabilities.chatTerminals, true);
  const { sessionId } = await chat.call('session/new', { cwd: '/tmp', mcpServers: [] });
  const key = sessionKey('claude', sessionId);

  // `codeflower attach`: no ACP of its own, only the terminal.
  const attach = await open(t, bridge);
  const started = await attach.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: key, columns: 90, rows: 25 });
  assert.equal(started.sessionKey, key);
  await attach.printed(started.terminalId, new RegExp(`tui for ${sessionId} at 90x25`));
  // Every window hears it, and the chat list says so.
  await chat.receive((message) => message.method === '_codeflower/terminal/changed' && message.params.terminals.length === 1);
  const listed = (await chat.call('_codeflower/sessions/list')).sessions.find((session) => session.key === key);
  assert.equal(listed.terminal.terminalId, started.terminalId);

  await attach.call('_codeflower/terminal/input', { terminalId: started.terminalId, data: 'hi there\r' });
  await attach.printed(started.terminalId, /typed hi there/);
  await attach.close();

  // It is still there; starting it again attaches to it.
  assert.equal((await chat.call('_codeflower/terminal/list')).terminals.length, 1);
  const again = await open(t, bridge);
  const reattached = await again.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: key, columns: 90, rows: 25 });
  assert.equal(reattached.terminalId, started.terminalId);
  await again.printed(started.terminalId, /typed hi there/);
  await again.call('_codeflower/terminal/resize', { terminalId: started.terminalId, columns: 110, rows: 30 });
  await again.printed(started.terminalId, /resized to 110x30/);

  // A new chat of its own.
  const fresh = await again.call('_codeflower/terminal/start', { kind: 'chat', new: true, columns: 80, rows: 24 });
  assert.notEqual(fresh.sessionKey, key);
  await again.printed(fresh.terminalId, new RegExp(`tui for ${fresh.sessionId}`));
  assert.equal((await again.call('_codeflower/terminal/list')).terminals.length, 2);

  await again.call('_codeflower/terminal/close', { terminalId: fresh.terminalId });
  await again.receive((message) => message.method === '_codeflower/terminal/exit' && message.params.terminalId === fresh.terminalId);
  await assert.rejects(again.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: 'claude-nope' }), /no such chat/);
  await assert.rejects(again.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: 'codex-x' }), /Invalid session key/);
});

test("shows a turn typed in the agent's terminal UI in the chat's windows, and holds their prompts until it ends", async (t) => {
  const { bridge, backend } = await startTestBridge(t);
  const chat = await open(t, bridge);
  await chat.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await chat.call('session/new', { cwd: '/tmp', mcpServers: [] });
  const key = sessionKey('claude', sessionId);
  const prompted = () => chat.messages.filter((message) => message.method === '_codeflower/prompted');

  // A prompt of the window's own comes back as its user message: not shown twice.
  await chat.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'from the window' }] });
  backend.emit({ type: 'prompt', sessionId, prompt: [{ type: 'text', text: 'from the window' }] });
  assert.equal(prompted().length, 1);

  // Typed in the terminal.
  backend.emit({ type: 'prompt', sessionId, prompt: [{ type: 'text', text: 'from the terminal' }] });
  const shown = await chat.receive((message) => message.method === '_codeflower/prompted' && message.params.prompt[0].text === 'from the terminal');
  assert.equal(shown.params.key, key);
  assert.equal(shown.params._meta['codeflower/from'], 'terminal');
  backend.emit({ type: 'busy', sessionId });
  await chat.receive((message) => message.method === '_codeflower/activity' && message.params.chats.some((entry) => entry.key === key && entry.state === 'working'));

  // The window's prompt waits for the terminal's turn.
  const id = 'queued';
  chat.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'next' }] } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(chat.messages.find((message) => message.id === id), undefined);
  backend.emit({ type: 'idle', sessionId });
  assert.equal((await chat.receive((message) => message.id === id)).result.stopReason, 'end_turn');

  // Events of chats not loaded here are none of the bridge's business.
  backend.emit({ type: 'prompt', sessionId: 'elsewhere', prompt: [{ type: 'text', text: 'x' }] });

  const { entries } = await chat.call('_codeflower/sessions/transcript', { key });
  const kinds = entries.map((entry) => (entry.kind === 'prompt' ? `prompt:${entry.prompt[0].text}` : entry.kind)).filter((kind) => kind !== 'update');
  assert.deepEqual(kinds, ['prompt:from the window', 'turn_end', 'prompt:from the terminal', 'turn_end', 'prompt:next', 'turn_end']);
});

test('closes a permission request in the windows when the terminal UI answered it', async (t) => {
  const { bridge, backend } = await startTestBridge(t);
  const chat = await open(t, bridge);
  await chat.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await chat.call('session/new', { cwd: '/tmp', mcpServers: [] });
  chat.send({ jsonrpc: '2.0', id: 'ask', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'ask permission' }] } });
  const asked = await chat.receive((message) => message.method === 'session/request_permission');
  const requestKey = asked.params._meta['codeflower/requestKey'];

  backend.emit({ type: 'permissionReplied', sessionId, toolCallId: 'tool-1', reply: 'once' });
  const resolved = await chat.receive((message) => message.method === '_codeflower/requestResolved');
  assert.equal(resolved.params.requestKey, requestKey);
  assert.deepEqual(resolved.params.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  // The agent got the same answer, so its turn goes on.
  assert.match(JSON.stringify((await chat.receive((message) => message.id === 'ask')).result), /end_turn/);
  assert.ok(chat.messages.some((message) => message.method === 'session/update' && /outcome allow/.test(JSON.stringify(message))));
});

// What codeflower-show sends, and its answer.
function show(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => (reply += chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(JSON.parse(reply)));
  });
}

test('links the files the agent shows for the browser of whoever uses its terminal UI', async (t) => {
  const { bridge, workspace, showSocket } = await startTestBridge(t);
  await writeFile(join(workspace, 'pca plot.png'), 'png');
  const chat = await open(t, bridge);
  await chat.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await chat.call('session/new', { cwd: workspace, mcpServers: [] });
  const key = sessionKey('claude', sessionId);

  // No terminal yet: the window opens the file, and there are no links.
  assert.deepEqual(Object.keys(await show(showSocket, { paths: ['pca plot.png'], cwd: workspace })), ['shown']);
  assert.match((await show(showSocket, { paths: ['pca plot.png'], cwd: workspace, linkOnly: true })).error, /No terminal with links/);

  const attach = await open(t, bridge);
  const base = 'http://127.0.0.1:7720/#/file/local-1a2b3c4d/';
  const started = await attach.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: key, linkBase: base });
  const url = `${base}${encodeURIComponent(join(workspace, 'pca plot.png'))}`;
  const answer = await show(showSocket, { paths: ['pca plot.png'], cwd: workspace, title: 'PCA' });
  assert.deepEqual(answer.links, [{ path: join(workspace, 'pca plot.png'), url }]);
  // The window shows it; the terminal's viewers get the link for their rail.
  await chat.receive((message) => message.method === '_codeflower/show');
  const rail = await attach.receive((message) => message.method === '_codeflower/terminal/show');
  assert.deepEqual(rail.params, { terminalId: started.terminalId, files: [{ path: join(workspace, 'pca plot.png'), url }], title: 'PCA' });
  // The agent asks for the link only.
  assert.deepEqual(await show(showSocket, { paths: ['pca plot.png'], cwd: workspace, linkOnly: true }), { links: [{ path: join(workspace, 'pca plot.png'), url }] });

  // During a turn, the link names its chat.
  chat.send({ jsonrpc: '2.0', id: 'long', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'long task' }] } });
  await chat.receive((message) => message.method === '_codeflower/activity' && message.params.chats.some((entry) => entry.state === 'working'));
  const during = await show(showSocket, { paths: ['pca plot.png'], cwd: workspace, linkOnly: true });
  assert.equal(during.links[0].url, `${url}?chat=${encodeURIComponent(key)}`);
  chat.send({ jsonrpc: '2.0', method: 'fake/finish', params: { sessionId } });

  // Only the window gets files to open: with it gone, the links remain.
  await chat.close();
  assert.deepEqual(await show(showSocket, { paths: ['pca plot.png'], cwd: workspace }), { shown: [], links: [{ path: join(workspace, 'pca plot.png'), url }] });
  // A base that is no web address is ignored.
  await attach.call('_codeflower/terminal/attach', { terminalId: started.terminalId, linkBase: 'javascript:alert(1)//' });
  assert.equal((await show(showSocket, { paths: ['pca plot.png'], cwd: workspace, linkOnly: true })).links[0].url, url);
});
