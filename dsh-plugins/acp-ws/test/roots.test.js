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
import { commentNotice, createRoots } from '../src/roots.js';
import { create, readAll } from '../src/roots-store.js';
import { startBridge } from '../src/server.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const rootsCommand = fileURLToPath(new URL('../../../bin/codeflower-roots', import.meta.url));
const token = 'r'.repeat(43);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codeflower-roots-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'roots');
}

test('tells the chat of the user\'s comments, quoted, with how to answer', () => {
  const text = commentNotice({ id: 5, title: 'Harmony' }, [{ text: 'Try scVI\ntoo' }, { text: 'And LISI' }]);
  assert.match(text, /^The user commented on idea 5 \(Harmony\) in Roots/);
  assert.match(text, /> Try scVI\n> too\n\n> And LISI/);
  assert.match(text, /codeflower-roots comment 5/);
});

test('sends the map when the files change, with the chats\' keys', async (t) => {
  const dir = await folder(t);
  const sent = [];
  const roots = createRoots({ dir, changed: (snapshot) => sent.push(snapshot), keyOf: (agent, id) => `${agent}:${id}`, watchMs: 30 });
  t.after(() => roots.close());
  await until(() => sent.length === 1);
  assert.deepEqual(sent[0], { ideas: [], errors: [] });
  create(dir, { title: 'QC' }, { chat: { agent: 'claude', sessionId: 's1' } });
  await until(() => sent.length === 2);
  assert.equal(sent[1].ideas[0].title, 'QC');
  assert.equal(sent[1].ideas[0].chats[0].key, 'claude:s1');
  // Nothing changed: nothing sent.
  await sleep(120);
  assert.equal(sent.length, 2);
});

test('applies the user\'s changes, and refuses what would break the map', async (t) => {
  const dir = await folder(t);
  const roots = createRoots({ dir, watchMs: 10_000 });
  t.after(() => roots.close());
  create(dir, { title: 'QC', todos: [{ text: 'a', done: false }], needs: [{ text: 'sheet', met: false }] });
  create(dir, { title: 'Cluster', from: [1], needs: [{ idea: 1 }] });
  const idea = await roots.update({ id: 1, patch: { status: 'done', todo: { index: 0, done: true }, need: { index: 0, met: true }, title: ' QC v2 ' } });
  assert.equal(idea.status, 'done');
  assert.equal(idea.title, 'QC v2');
  assert.equal(idea.todos[0].done, true);
  assert.equal(idea.needs[0].met, true);
  assert.equal(roots.snapshot().ideas[0].title, 'QC v2');
  await assert.rejects(roots.update({ id: 1, patch: { from: [2] } }), /circle/);
  await assert.rejects(roots.update({ id: 2, patch: { need: { index: 0, met: true } } }), /met when that idea is done/);
  await assert.rejects(roots.update({ id: 1, patch: { status: 'maybe' } }), /status is one of/);
  await assert.rejects(roots.update({ id: 1, patch: { todo: { index: 4 } } }), /no such todo/);
  await assert.rejects(roots.update({ id: 9, patch: {} }), /no idea 9/);
  await assert.rejects(roots.update({ id: 'x', patch: {} }), /Name the idea/);
  await assert.rejects(roots.comment({ id: 1, text: '  ' }), /empty/);
});

test('tells the idea\'s latest chat of comments, several in one message', async (t) => {
  const dir = await folder(t);
  const told = [];
  const roots = createRoots({ dir, watchMs: 10_000, noticeDelayMs: 50, keyOf: (agent, id) => `${agent}:${id}`, tell: (...args) => told.push(args) > 0 });
  t.after(() => roots.close());
  create(dir, { title: 'Harmony' }, { chat: { agent: 'claude', sessionId: 'old' } });
  create(dir, { title: 'Alone' });
  // A later chat of another agent took the idea on.
  readAll(dir);
  await roots.update({ id: 1, patch: { status: 'active' } });
  const { change } = await import('../src/roots-store.js');
  change(dir, 1, () => {}, { chat: { agent: 'codex', sessionId: 'new' } });

  const first = await roots.comment({ id: 1, text: 'Try scVI' });
  assert.equal(first.told, 'codex:new');
  assert.equal(first.idea.comments[0].by, 'user');
  await roots.comment({ id: 1, text: 'And LISI' });
  const alone = await roots.comment({ id: 2, text: 'Nobody hears this' });
  assert.equal(alone.told, undefined);
  await until(() => told.length === 1);
  const [chat, text, title, summary] = told[0];
  assert.deepEqual(chat, { agent: 'codex', sessionId: 'new' });
  assert.match(text, /> Try scVI\n\n> And LISI/);
  assert.equal(title, 'Comment on an idea');
  assert.equal(summary, '2 comments on #1 Harmony');
  // The comments stay on the idea for the agent to read.
  assert.deepEqual(readAll(dir).ideas[0].comments.map((comment) => comment.text), ['Try scVI', 'And LISI']);
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

async function open(address, agent) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp${agent ? `?agent=${agent}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
  await once(socket, 'open');
  return track(socket);
}

test('windows get the map the agents keep, change it, and comment to the chat', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-roots-')));
  const state = join(directory, 'state');
  const sessionsDirectory = join(state, 'sessions');
  const workspace = join(state, 'workspace');
  await mkdir(workspace, { recursive: true });
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  delete environment.CODEFLOWER_ROOTS_DIR;
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-roots',
    sessionsDirectory,
    workspace,
    agents: { claude: agents.claude },
    environment,
    rootsTiming: { watchMs: 50, noticeDelayMs: 50 },
    showSocket: join(directory, 'show.sock'),
    browserSocket: join(directory, 'browser.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });

  const window = await open(bridge.address);
  assert.equal((await call(window, '_codeflower/status')).result.roots, true);
  const empty = (await call(window, '_codeflower/roots/list')).result;
  assert.deepEqual(empty.ideas, []);
  assert.equal(empty.workspace, workspace);

  // The agent starts an idea in its chat.
  const chat = await open(bridge.address, 'claude');
  await call(chat, 'initialize', { protocolVersion: 1 });
  const sessionId = (await call(chat, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;
  const made = await new Promise((resolve) =>
    execFile(process.execPath, [rootsCommand, 'new', 'Explore and QC', '--todo', 'Violins'], {
      cwd: workspace,
      env: { ...process.env, CODEFLOWER_WORKSPACE: workspace, CODEFLOWER_AGENT_NAME: 'claude', CLAUDE_CODE_SESSION_ID: sessionId }
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
  );
  assert.equal(made.code, 0, made.stderr);
  const changed = await receive(window, (message) => message.method === '_codeflower/roots/changed' && message.params.ideas.length === 1);
  const [idea] = changed.params.ideas;
  assert.equal(idea.title, 'Explore and QC');
  assert.match(idea.chats[0].key, new RegExp(sessionId));

  // The user checks the todo, and comments: the chat is told.
  const updated = (await call(window, '_codeflower/roots/update', { id: 1, patch: { todo: { index: 0, done: true } } })).result.idea;
  assert.equal(updated.todos[0].done, true);
  const commented = (await call(window, '_codeflower/roots/comment', { id: 1, text: 'Use 15% mito' })).result;
  assert.equal(commented.told, idea.chats[0].key);
  const file = await readFile(join(workspace, 'roots', '001-explore-and-qc.md'), 'utf8');
  assert.match(file, /"by":"user","text":"Use 15% mito"/);
  const refused = await call(window, '_codeflower/roots/update', { id: 7, patch: {} });
  assert.match(refused.error.message, /no idea 7/);

  // The agent shows the map: the window that has its chat open opens it, on the idea.
  const roots = (args) =>
    new Promise((resolve) =>
      execFile(process.execPath, [rootsCommand, ...args], {
        cwd: workspace,
        env: {
          ...process.env,
          CODEFLOWER_WORKSPACE: workspace,
          CODEFLOWER_SHOW_SOCKET: join(directory, 'show.sock'),
          CODEFLOWER_AGENT_NAME: 'claude',
          CLAUDE_CODE_SESSION_ID: sessionId
        }
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
    );
  const opened = await roots(['open', '1']);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /open next to the chat, on idea 1/);
  const shown = await receive(chat, (message) => message.method === '_codeflower/roots/open');
  assert.deepEqual(shown.params, { idea: 1, key: idea.chats[0].key });
  assert.match((await roots(['open', '9'])).stderr, /there is no idea 9/);
});

test('records the chat or subagent a command runs in, also when the agent exports no session id', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-roots-')));
  const workspace = join(directory, 'state', 'workspace');
  await mkdir(workspace, { recursive: true });
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  delete environment.CODEFLOWER_ROOTS_DIR;
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const showSocket = join(directory, 'show.sock');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-roots-chat',
    sessionsDirectory: join(directory, 'state', 'sessions'),
    workspace,
    agents: { claude: agents.claude },
    environment,
    rootsTiming: { watchMs: 50 },
    showSocket,
    browserSocket: join(directory, 'browser.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  const roots = (args, env) =>
    new Promise((resolve) =>
      execFile(process.execPath, [rootsCommand, ...args], {
        cwd: workspace,
        env: { ...process.env, CODEFLOWER_WORKSPACE: workspace, CODEFLOWER_SHOW_SOCKET: showSocket, CODEFLOWER_AGENT_NAME: 'claude', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', ...env }
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
    );
  const recorded = async (id) => JSON.parse((await roots(['show', String(id), '--json'])).stdout).chats;

  const chat = await open(bridge.address, 'claude');
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: { subagents: {} } });
  const first = (await call(chat, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;
  const second = (await call(chat, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;

  // An agent that exports no session id (OpenCode, DeepSeek Harness): its running command tells.
  chat.send(JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'session/prompt', params: { sessionId: first, prompt: [{ type: 'text', text: 'run in chat: codeflower-roots new "Paper idea"' }] } }));
  await sleep(300);
  const made = await roots(['new', 'Paper idea']);
  assert.equal(made.code, 0, made.stderr);
  assert.deepEqual((await recorded(1)).map(({ agent, sessionId, parent }) => ({ agent, sessionId, parent })), [{ agent: 'claude', sessionId: first, parent: undefined }]);

  // A subagent, which exports its parent's id: recorded as itself, with its parent.
  chat.send(JSON.stringify({ jsonrpc: '2.0', id: 9002, method: 'session/prompt', params: { sessionId: second, prompt: [{ type: 'text', text: 'run in subagent: codeflower-roots new "Helper idea" --from 1' }] } }));
  await sleep(300);
  const helped = await roots(['new', 'Helper idea', '--from', '1'], { CLAUDE_CODE_SESSION_ID: second });
  assert.equal(helped.code, 0, helped.stderr);
  const [helper] = await recorded(2);
  assert.match(helper.sessionId, /^child-/);
  assert.equal(helper.parent, second);

  // The windows get both chats' keys, the subagent's with its parent's.
  const window = await open(bridge.address);
  const { ideas } = (await call(window, '_codeflower/roots/list')).result;
  assert.match(ideas[1].chats[0].key, /child-/);
  assert.match(ideas[1].chats[0].parentKey, new RegExp(second));
});
