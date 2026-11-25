// Forks and codeflower-chat (chats.js): a window forks a chat natively at the
// agent's cursor or all of it, else as a seeded chat; agents read, fork and
// start chats, which the user allows in the calling chat.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { FORK_CONTEXT_META, forkCursor, forkSeed, promptIndex, promptText, userPrompt } from '../src/chats.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const chatCommand = fileURLToPath(new URL('../../../bin/codeflower-chat', import.meta.url));
const token = 'c'.repeat(43);

const prompt = (text, meta) => ({ t: '2026-11-25T10:00:00.000Z', kind: 'prompt', prompt: [{ type: 'text', text, ...(meta ? { _meta: meta } : {}) }] });
const cursor = (cursorId) => ({ kind: 'update', update: { sessionUpdate: 'cursor_update', cursorId, capabilities: { fork: {} }, anchor: { type: 'user_message', messageId: cursorId, position: 'before' } } });
const said = (text) => ({ t: '2026-11-25T10:00:01.000Z', kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });

test('finds the user\'s messages, and the cursor before each, past notices', () => {
  const entries = [
    prompt('first'),
    cursor('c1'),
    said('one'),
    { kind: 'turn_end' },
    prompt('A job ended', { 'codeflower/notice': { title: 'Batch job' } }),
    said('noted'),
    prompt('second'),
    said('two'),
    prompt('third'),
    cursor('c3')
  ];
  assert.equal(userPrompt(entries[4]), false);
  assert.equal(promptIndex(entries, 1), 0);
  assert.equal(promptIndex(entries, 2), 6);
  assert.equal(promptIndex(entries, 3), 8);
  assert.equal(promptIndex(entries, 4), undefined);
  assert.equal(forkCursor(entries, 0), 'c1');
  // None announced for it (e.g. a slash command): no native fork there.
  assert.equal(forkCursor(entries, 6), undefined);
  assert.equal(forkCursor(entries, 8), 'c3');
  assert.equal(promptText([{ type: 'text', text: 'old', _meta: { [FORK_CONTEXT_META]: true } }, { type: 'text', text: 'new' }]), 'new');
});

test('a seeded fork tells the agent the history, its latest part when long', () => {
  const short = forkSeed([prompt('make a plot'), said('done: plot.png'), { kind: 'turn_end' }], { key: 'codex-1', title: 'Plots' });
  assert.match(short, /continues the chat "Plots" \(codex-1\)/);
  assert.match(short, /\[1\] User \(message 1\):\nmake a plot/);
  assert.match(short, /\[2\] Agent:\ndone: plot\.png/);
  assert.doesNotMatch(short, /left out; read them/);
  const long = forkSeed(Array.from({ length: 400 }, (_, index) => [prompt(`question ${index} ${'x'.repeat(300)}`), said('ok')]).flat(), { key: 'codex-1', title: 'Long' });
  assert.ok(long.length < 62_000, long.length);
  assert.match(long, /left out; read them with: codeflower-chat read codex-1 --from 1/);
  assert.match(long, /question 399/);
});

// ---- through the bridge ----

function track(socket) {
  socket.inbox = [];
  socket.waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = socket.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) socket.inbox.push(message);
    else socket.waiters.splice(index, 1)[0].resolve(message);
  });
  return socket;
}

function receive(socket, predicate) {
  const index = socket.inbox.findIndex(predicate);
  if (index !== -1) return Promise.resolve(socket.inbox.splice(index, 1)[0]);
  return new Promise((resolve) => socket.waiters.push({ predicate, resolve }));
}

let nextId = 1;
async function call(socket, method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return receive(socket, (message) => message.id === id && message.method === undefined);
}

// A chat's record, once the bridge wrote all of it.
const transcript = async (window, key) => (await call(window, '_codeflower/sessions/transcript', { key })).result.entries;

async function start(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-chats-')));
  const workspace = join(directory, 'workspace');
  const sessionsDirectory = join(directory, 'state', 'sessions');
  await mkdir(workspace, { recursive: true });
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const all = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent, codex: fakeAgent }, environment });
  // Claude forks natively, at its cursors; this Codex does not fork.
  const claude = { ...all.claude, command: async () => [process.execPath, fakeAgent, '--fork'] };
  const chatsSocket = join(directory, 'chats.sock');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-chats',
    sessionsDirectory,
    workspace,
    agents: { claude, codex: all.codex },
    environment,
    showSocket: join(directory, 'show.sock'),
    browserSocket: join(directory, 'browser.sock'),
    chatsSocket,
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = async (agent) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/acp${agent ? `?agent=${agent}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    await once(socket, 'open');
    t.after(() => socket.close());
    return track(socket);
  };
  const chat = (agent, sessionId, args, input) =>
    new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [chatCommand, ...args],
        {
          cwd: workspace,
          env: { ...process.env, CODEFLOWER_CHATS_SOCKET: chatsSocket, CODEFLOWER_AGENT_NAME: agent, CLAUDE_CODE_SESSION_ID: sessionId ?? '', CODEX_THREAD_ID: '' }
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
      child.stdin.end(input ?? '');
    });
  // A turn, to its end.
  const say = async (socket, sessionId, text) => (await call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] })).result;
  return { bridge, workspace, sessionsDirectory, open, chat, say };
}

test('a window forks a chat before a message at the agent\'s cursor, or all of it', async (t) => {
  const { sessionsDirectory, open, say } = await start(t);
  const worker = await open();
  const window = await open('claude');
  await call(window, 'initialize', { protocolVersion: 1 });
  const sessionId = (await call(window, 'session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  await say(window, sessionId, 'first');
  await say(window, sessionId, 'second');
  const key = sessionKey('claude', sessionId);
  const entries = await transcript(window, key);
  const second = promptIndex(entries, 2);
  assert.equal(second, 4);

  const forked = (await call(window, '_codeflower/sessions/fork', { key, beforeEntry: second })).result;
  assert.equal(forked.native, true);
  assert.equal(forked.draft, 'second');
  assert.equal(forked.title, `Fork of first`);
  await receive(worker, (message) => message.method === '_codeflower/sessions/changed');
  // Its record starts with the chat's before the message; the list says where it came from.
  const copied = await transcript(window, forked.key);
  assert.deepEqual(copied.slice(0, second), entries.slice(0, second));
  const listed = (await call(worker, '_codeflower/sessions/list')).result.sessions.find((session) => session.key === forked.key);
  assert.deepEqual(listed.origin, { kind: 'fork', from: key, before: 2, native: true });
  assert.equal(listed.title, 'Fork of first');

  // The agent forked at the cursor it sent before that message, in the chat's folder.
  const forkId = forked.key.slice('claude-'.length);
  const reply = await call(window, 'session/prompt', { sessionId: forkId, prompt: [{ type: 'text', text: 'fork info' }] });
  assert.equal(reply.result.stopReason, 'end_turn');
  const info = JSON.parse((await transcript(window, forked.key)).findLast((entry) => entry.update?.sessionUpdate === 'agent_message_chunk').update.content.text);
  assert.deepEqual(info.fork, { from: sessionId, cursorId: 'cursor-2', cwd: '/tmp' });
  assert.equal(info.seed, null);

  // All of it.
  const whole = (await call(window, '_codeflower/sessions/fork', { key, title: 'Another way' })).result;
  assert.equal(whole.native, true);
  assert.equal(whole.draft, undefined);
  assert.equal(whole.title, 'Another way');
  assert.equal((await transcript(window, whole.key)).filter(userPrompt).length, 2);

  // Not before a message of the user's; not a chat there is not.
  assert.match((await call(window, '_codeflower/sessions/fork', { key, beforeEntry: second + 1 })).error.message, /Fork before one of your messages/);
  assert.match((await call(window, '_codeflower/sessions/fork', { key: 'codex-x' })).error.message, /No chat codex-x/);
});

test('an agent without forks gets a new chat that brings the history with its first message', async (t) => {
  const { sessionsDirectory, open, say } = await start(t);
  const window = await open('codex');
  await call(window, 'initialize', { protocolVersion: 1 });
  const sessionId = (await call(window, 'session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  await say(window, sessionId, 'make a plot');
  const key = sessionKey('codex', sessionId);

  const forked = (await call(window, '_codeflower/sessions/fork', { key })).result;
  assert.equal(forked.native, false);
  const forkId = forked.key.slice('codex-'.length);
  await say(window, forkId, 'fork info');
  const entries = await transcript(window, forked.key);
  const info = JSON.parse(entries.findLast((entry) => entry.update?.sessionUpdate === 'agent_message_chunk').update.content.text);
  assert.equal(info.fork, null);
  assert.match(info.seed, /User \(message 1\):\nmake a plot/);
  // Recorded with the prompt for the agent, which windows hide; only the first prompt brings it.
  const sent = entries.filter(userPrompt).at(-1);
  assert.equal(sent.prompt[0]._meta[FORK_CONTEXT_META], true);
  assert.equal(promptText(sent.prompt), 'fork info');
  await say(window, forkId, 'again');
  assert.equal((await transcript(window, forked.key)).filter(userPrompt).at(-1).prompt.length, 1);
});

test('agents list and read chats, and fork or start them once the user allows it', async (t) => {
  const { sessionsDirectory, open, chat, say } = await start(t);
  const worker = await open();
  const window = await open('claude');
  await call(window, 'initialize', { protocolVersion: 1 });
  const sessionId = (await call(window, 'session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  await say(window, sessionId, 'cluster the cells');
  const key = sessionKey('claude', sessionId);

  assert.equal((await chat('claude', sessionId, ['whoami'])).stdout.trim(), key);
  const listed = await chat('claude', sessionId, ['list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`${key}  claude  .*cluster the cells`));
  const read = await chat('claude', sessionId, ['read', key]);
  assert.equal(read.code, 0, read.stderr);
  assert.match(read.stdout, /\[1\] User \(message 1\):\ncluster the cells/);
  assert.match(read.stdout, /\[2\] Agent:\nreply to cluster the cells/);
  assert.match((await chat('claude', sessionId, ['read', 'claude-nope'])).stderr, /No chat claude-nope/);

  // A new chat of another agent: asked in the calling chat, then started on its message.
  const started = chat('claude', sessionId, ['new', '--agent', 'codex', '--title', 'Review', '-'], 'Review the clustering\nin detail');
  const asked = await receive(window, (message) => message.method === 'session/request_permission');
  assert.equal(asked.params.sessionId, sessionId);
  assert.equal(asked.params.toolCall.title, 'Start the chat ‘Review’ with Codex');
  assert.match(asked.params.toolCall.content[0].content.text, /First message:\nReview the clustering\nin detail/);
  window.send(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
  const result = await started;
  assert.equal(result.code, 0, result.stderr);
  const newKey = /Started (codex-\S+) \(codex\)/.exec(result.stdout)[1];
  await receive(worker, (message) => message.method === '_codeflower/sessions/changed');
  const session = (await call(worker, '_codeflower/sessions/list')).result.sessions.find((candidate) => candidate.key === newKey);
  assert.equal(session.title, 'Review');
  assert.deepEqual(session.origin, { kind: 'agent', from: key });
  // Its first message went; its turn runs on without a window.
  const codex = await open('codex');
  const replied = async () =>
    (await transcript(codex, newKey)).some((entry) => entry.update?.content?.text === `reply to Review the clustering\nin detail in ${newKey.slice('codex-'.length)}`);
  for (let tries = 0; !(await replied()); tries++) {
    if (tries > 100) assert.fail('the new chat did not work on its message');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // A fork of this chat, denied.
  const denied = chat('claude', sessionId, ['fork', 'try', 'another', 'way']);
  const second = await receive(window, (message) => message.method === 'session/request_permission');
  assert.match(second.params.toolCall.title, /Fork the chat cluster the cells as ‘Fork of cluster the cells’/);
  window.send(JSON.stringify({ jsonrpc: '2.0', id: second.id, result: { outcome: { outcome: 'selected', optionId: 'deny' } } }));
  const refused = await denied;
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /did not allow/);

  // Allowed: the fork works on the message.
  const allowed = chat('claude', sessionId, ['fork', key, '--title', 'Leiden instead', 'use leiden']);
  const third = await receive(window, (message) => message.method === 'session/request_permission');
  window.send(JSON.stringify({ jsonrpc: '2.0', id: third.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
  const fork = await allowed;
  assert.equal(fork.code, 0, fork.stderr);
  assert.match(fork.stdout, /Forked as claude-\S+: Leiden instead, working on your message/);

  // Refused before anyone is asked.
  assert.match((await chat('claude', sessionId, ['new', 'no title'])).stderr, /--title TITLE/);
  assert.match((await chat('claude', sessionId, ['new', '--agent', 'gemini', '--title', 'x', 'y'])).stderr, /No agent gemini/);
  assert.match((await chat('claude', undefined, ['new', '--title', 'x', 'y'])).stderr, /No agent|Cannot tell which chat/);
  assert.match(await readFile(join(sessionsDirectory, newKey, 'title.json'), 'utf8'), /"Review"/);
});
