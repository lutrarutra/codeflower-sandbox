// Orchestrator chats (orchestrators.js): a Claude chat started on another chat
// for good, its session without Claude Code's tools and with the bridge's MCP
// server only; it asks its executor through that server, the executor asks back
// with codeflower-orchestrator, and the user sees what went to it.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { promptIndex, recordsText, userPrompt } from '../src/chats.js';
import { auditTranscript } from '../src/audit.js';
import {
  DEFAULT_ACCESS,
  FROM_META,
  ORCHESTRATOR_NOTE_META,
  cleanAccess,
  createTurnCollector,
  replyText,
  reportText,
  toolInput
} from '../src/orchestrators.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const askCommand = fileURLToPath(new URL('../../../bin/codeflower-orchestrator', import.meta.url));
const mcpCommand = fileURLToPath(new URL('../../../bin/codeflower-orchestrator-mcp', import.meta.url));
const token = 'o'.repeat(43);

test('access: every field, valid, defaults for those not given', () => {
  assert.deepEqual(cleanAccess(undefined), DEFAULT_ACCESS);
  assert.deepEqual(cleanAccess({ figures: 'always' }), { ...DEFAULT_ACCESS, figures: 'always' });
  assert.deepEqual(cleanAccess({ web: false }, { ...DEFAULT_ACCESS, report: 'never' }), { ...DEFAULT_ACCESS, web: false, report: 'never' });
  assert.throws(() => cleanAccess({ figures: 'sometimes' }), /never, ask or always/);
  assert.throws(() => cleanAccess({ web: 'yes' }), /true or false/);
  assert.throws(() => cleanAccess({ data: true }), /Unknown access/);
});

test("a turn's reply is its last message, with the tools it called and their input", () => {
  const turn = createTurnCollector();
  turn.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading the ' } });
  turn.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'table.' } });
  turn.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Rscript fit.R', kind: 'execute' });
  turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { command: 'Rscript fit.R' } });
  // An edit's text may be the data: only its path goes.
  turn.update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit fit.R', kind: 'edit', rawInput: { path: 'fit.R', new: 'PAT-123,Jane Doe' } });
  turn.update({ sessionUpdate: 'tool_call', toolCallId: 't3', title: 'python', kind: 'execute', rawInput: { code: 'x'.repeat(3000) } });
  turn.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HR 1.4 (95% CI 1.1-1.8).' } });
  const { reply, commands } = turn.result();
  assert.equal(reply, 'HR 1.4 (95% CI 1.1-1.8).');
  // The command is its title: not repeated.
  assert.deepEqual(commands[0], { title: 'Rscript fit.R', kind: 'execute' });
  assert.equal(commands[1].input, 'path: fit.R');
  assert.match(commands[2].input, /… \(cut\)$/);
  assert.ok(commands[2].input.length < 2100);
  const text = replyText({ reply, commands, stopReason: 'max_tokens' });
  assert.match(text, /ended early \(max_tokens\)/);
  assert.match(text, /1\. Rscript fit\.R\n2\. Edit fit\.R\n {3}path: fit\.R/);
  assert.doesNotMatch(text, /Jane Doe/);
  assert.equal(toolInput({ file_path: '/w/a.csv', content: 'id,name' }), 'file_path: /w/a.csv');
  assert.equal(toolInput({ content: 'id,name' }), undefined);
  assert.equal(toolInput({ cmd: ['ls', '-l'] }), 'ls -l');
});

test("a report's text: HTML without scripts, styles and tags", () => {
  const html = '<html><style>p{}</style><script>var rows=[1,2]</script><h1>Survival</h1><p>HR &amp; CI</p><br>end</html>';
  assert.equal(reportText('r.html', html), 'Survival\nHR & CI\n\nend');
  assert.equal(reportText('r.md', '# A <b>'), '# A <b>');
});

test("another chat's message is neither the user's nor numbered as one", () => {
  const entries = [
    { kind: 'prompt', prompt: [{ type: 'text', text: 'first' }] },
    {
      kind: 'prompt',
      prompt: [
        { type: 'text', text: 'note', _meta: { [ORCHESTRATOR_NOTE_META]: true } },
        { type: 'text', text: 'Fit the model', _meta: { [FROM_META]: { kind: 'orchestrator', key: 'claude-1', title: 'Review' } } }
      ]
    },
    { kind: 'sent', to: 'claude-1', text: 'done' },
    { kind: 'prompt', prompt: [{ type: 'text', text: 'second' }] }
  ];
  assert.equal(userPrompt(entries[1]), false);
  assert.equal(promptIndex(entries, 2), 3);
  const records = auditTranscript(entries);
  assert.deepEqual(records[1], { t: undefined, role: 'peer', from: 'orchestrator', title: 'Review', text: 'Fit the model' });
  const text = recordsText(records.map((record, index) => ({ i: index + 1, ...record })));
  assert.match(text, /\[2\] Orchestrator \(Review\):\nFit the model/);
  assert.match(text, /\[3\] Sent to the orchestrator:\ndone/);
  assert.doesNotMatch(text, /note/);
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

// The orchestrator's MCP server, as Claude Code starts it, spoken to over stdio.
function mcpClient(t, link, socket) {
  const child = spawn(process.execPath, [mcpCommand, link], { env: { ...process.env, CODEFLOWER_ORCHESTRATOR_SOCKET: socket }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      const own = ++id;
      waiting.set(own, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: own, method, params })}\n`);
    });
  const tool = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result;
  return { request, tool };
}

async function start(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cf-orch-')));
  const workspace = join(directory, 'state', 'workspace');
  const sessionsDirectory = join(directory, 'state', 'sessions');
  await mkdir(workspace, { recursive: true });
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent, codex: fakeAgent }, environment });
  const orchestratorSocket = join(directory, 'o.sock');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-orchestrators',
    sessionsDirectory,
    workspace,
    agents: { claude: agents.claude, codex: agents.codex },
    environment,
    showSocket: join(directory, 'show.sock'),
    browserSocket: join(directory, 'browser.sock'),
    chatsSocket: join(directory, 'chats.sock'),
    watchSocket: join(directory, 'watch.sock'),
    orchestratorSocket,
    orchestratorMcp: [process.execPath, mcpCommand],
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
  // codeflower-orchestrator in the executor's chat (Codex exports its thread id).
  const executorAsks = (sessionId, args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [askCommand, ...args],
        { env: { ...process.env, CODEFLOWER_ORCHESTRATOR_SOCKET: orchestratorSocket, CODEFLOWER_AGENT_NAME: 'codex', CODEX_THREAD_ID: sessionId, CLAUDE_CODE_SESSION_ID: '' } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
    });
  const say = async (socket, sessionId, text) => (await call(socket, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] })).result;

  // An executor chat (Codex), and its orchestrator (Claude).
  const worker = await open();
  const codex = await open('codex');
  await call(codex, 'initialize', { protocolVersion: 1 });
  const executorId = (await call(codex, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;
  await say(codex, executorId, 'hello');
  const executor = sessionKey('codex', executorId);
  const created = (await call(worker, '_codeflower/orchestrators/create', { executor })).result;
  const meta = JSON.parse(await readFile(join(sessionsDirectory, created.key, 'meta.json'), 'utf8'));
  const transcript = async (key) => (await call(worker, '_codeflower/sessions/transcript', { key })).result.entries;
  return { bridge, directory, workspace, sessionsDirectory, orchestratorSocket, worker, codex, open, say, executorAsks, executor, executorId, created, meta, transcript };
}

test("an orchestrator's session: its folder, the bridge's MCP server only, no tools but the web's, its prompt", async (t) => {
  const { worker, open, say, executor, created, meta, sessionsDirectory } = await start(t);
  assert.match(created.title, /^Orchestrator of hello/);
  assert.equal(meta.role, 'orchestrator');
  assert.equal(meta.executor, executor);
  assert.deepEqual(meta.access, DEFAULT_ACCESS);
  const listed = (await call(worker, '_codeflower/sessions/list')).result.sessions.find((session) => session.key === created.key);
  assert.equal(listed.role, 'orchestrator');
  assert.equal(listed.executor, executor);

  const claude = await open('claude');
  await call(claude, 'initialize', { protocolVersion: 1 });
  const sessionId = created.key.slice('claude-'.length);
  await call(claude, 'session/resume', { sessionId, cwd: '/elsewhere', mcpServers: [] });
  const started = JSON.parse((await say(claude, sessionId, 'what start')) && (await lastText(claude)));
  assert.equal(started.cwd, join(sessionsDirectory, '..', 'orchestrators', meta.link));
  assert.deepEqual(started.mcpServers.map((server) => server.name), ['executor']);
  assert.equal(started.mcpServers[0].args.at(-1), meta.link);
  const sent = JSON.parse((await say(claude, sessionId, 'what meta')) && (await lastText(claude)));
  assert.deepEqual(sent.claudeCode.options.tools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(sent.claudeCode.options.settingSources, ['user']);
  assert.ok(sent.claudeCode.options.allowedTools.includes('mcp__executor'));
  assert.match(sent.systemPrompt.append, /You are an orchestrator/);

  // Neither forked, nor given a shell or the terminal UI.
  assert.match((await call(worker, '_codeflower/sessions/fork', { key: created.key })).error.message, /cannot be forked/);
  assert.match((await call(claude, '_codeflower/shell/run', { sessionId, runId: 'r1', command: 'ls' })).error.message, /orchestrator/);
  assert.match((await call(worker, '_codeflower/terminal/start', { kind: 'chat', sessionKey: created.key })).error.message, /terminal UI/);
  // Nor an orchestrator of its own.
  assert.match((await call(worker, '_codeflower/orchestrators/create', { executor: created.key })).error.message, /cannot have an orchestrator/);

  // A window resumes it in a new Claude Code, without the web now: the same limits, from its record.
  await call(worker, '_codeflower/orchestrators/setAccess', { key: created.key, access: { web: false } });
  assert.deepEqual((await call(claude, '_codeflower/agent/restart')).result, {});
  await once(claude, 'close');
  const again = await open('claude');
  await call(again, 'initialize', { protocolVersion: 1 });
  await call(again, 'session/resume', { sessionId, cwd: '/elsewhere', mcpServers: [] });
  const resumed = JSON.parse((await say(again, sessionId, 'what meta')) && (await lastText(again)));
  assert.deepEqual(resumed.claudeCode.options.tools, []);
  assert.deepEqual(resumed.claudeCode.options.allowedTools, ['mcp__executor']);
  assert.match(resumed.systemPrompt.append, /You are an orchestrator/);
  assert.deepEqual(JSON.parse((await say(again, sessionId, 'what start')) && (await lastText(again))).mcpServers.map((server) => server.name), ['executor']);
});

// The text of the latest agent message a window got.
async function lastText(socket) {
  const chunks = socket.inbox.filter((message) => message.params?.update?.sessionUpdate === 'agent_message_chunk');
  socket.inbox = socket.inbox.filter((message) => !chunks.includes(message));
  return chunks.at(-1)?.params.update.content.text;
}

test('the orchestrator asks its executor and gets its reply and commands; the executor chat shows both', async (t) => {
  const { meta, orchestratorSocket, executor, transcript, worker } = await start(t);
  const mcp = mcpClient(t, meta.link, orchestratorSocket);
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'codeflower-executor');
  const names = (await mcp.request('tools/list')).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['ask', 'answer', 'wait', 'list_directory', 'list_files', 'view_figure', 'read_report']);

  const result = await mcp.tool('ask', { message: 'run failing command' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /The executor's reply:\nit failed/);
  assert.match(result.content[0].text, /1\. bash\n {3}false/);
  // Nothing left to wait for.
  assert.match((await mcp.tool('wait')).content[0].text, /not working on anything of yours/);

  const entries = await transcript(executor);
  const asked = entries.find((entry) => entry.kind === 'prompt' && entry.prompt.some((block) => block._meta?.[FROM_META]));
  assert.equal(asked.prompt[0]._meta[ORCHESTRATOR_NOTE_META], true);
  assert.deepEqual(asked.prompt[1]._meta[FROM_META].kind, 'orchestrator');
  const noted = entries.find((entry) => entry.kind === 'sent');
  assert.equal(noted.what, 'reply');
  assert.match(noted.text, /it failed/);
  const list = (await call(worker, '_codeflower/orchestrators/list')).result.orchestrators;
  assert.equal(list[0].sent, 1);
  assert.equal(list[0].state, 'idle');
});

test('the executor asks back: during the orchestrator\'s message, and in a turn of its own when it is idle', async (t) => {
  const { meta, orchestratorSocket, executorId, executorAsks, codex } = await start(t);
  const mcp = mcpClient(t, meta.link, orchestratorSocket);
  await mcp.request('initialize', {});

  // The executor's turn stays open while its command runs.
  const asking = mcp.tool('ask', { message: 'run in chat: codeflower-orchestrator ask' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const question = executorAsks(executorId, ['ask', 'Which test fits?']);
  const asked = await asking;
  assert.match(asked.content[0].text, /The executor asks you.*\nWhich test fits\?/s);
  // Its next message waits for the answer.
  assert.match((await mcp.tool('ask', { message: 'something else' })).content[0].text, /waiting for your answer/);
  const answering = mcp.tool('answer', { text: 'A log-rank test.' });
  const printed = await question;
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), 'A log-rank test.');
  // The turn ends (stopped): the answer call gets the reply.
  codex.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: executorId } }));
  assert.match((await answering).content[0].text, /ended early \(cancelled\)/);

  // No exchange now: the orchestrator answers in a turn of its own (the fake replies with what it got).
  const idle = await executorAsks(executorId, ['ask', 'Is a Cox model fine here?']);
  assert.equal(idle.code, 0, idle.stderr);
  assert.match(idle.stdout, /reply to Is a Cox model fine here\? in /);
  const who = await executorAsks(executorId, ['whoami']);
  assert.match(who.stdout, /directed by:\n {2}claude-/);
});

test('the user may be asked before a reply goes, and ends the link', async (t) => {
  const { meta, orchestratorSocket, worker, codex, created } = await start(t);
  const mcp = mcpClient(t, meta.link, orchestratorSocket);
  await mcp.request('initialize', {});
  const changed = (await call(worker, '_codeflower/orchestrators/setAccess', { key: created.key, access: { approve: true } })).result;
  assert.equal(changed.access.approve, true);
  const asking = mcp.tool('ask', { message: 'make a plot' });
  const request = await receive(codex, (message) => message.method === 'session/request_permission');
  assert.match(request.params.toolCall.title, /Send this reply to the orchestrator/);
  codex.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'selected', optionId: 'deny' } } }));
  assert.match((await asking).content[0].text, /withheld/);

  await call(worker, '_codeflower/orchestrators/disconnect', { key: created.key });
  // Cut off from everything, not only from asking.
  for (const [name, input] of [['ask', { message: 'go on' }], ['wait', {}], ['list_directory', {}], ['list_files', {}]]) {
    const refused = await mcp.tool(name, input);
    assert.equal(refused.isError, true, name);
    assert.match(refused.content[0].text, /disconnected/, name);
  }
  const listed = (await call(worker, '_codeflower/sessions/list')).result.sessions.find((session) => session.key === created.key);
  assert.equal(listed.disconnected, true);
});

test('the orchestrator lists the executor\'s folders, and sees the figures and reports the user allows', async (t) => {
  const { meta, orchestratorSocket, worker, workspace, created, codex, executorId, executor } = await start(t);
  const mcp = mcpClient(t, meta.link, orchestratorSocket);
  await mcp.request('initialize', {});
  await mkdir(join(workspace, 'results'));
  const figure = join(workspace, 'results', 'km.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } }).png().toFile(figure);
  const report = join(workspace, 'results', 'report.html');
  await writeFile(report, '<h1>Survival</h1><script>var rows = 1</script><p>Done</p>');

  assert.match((await mcp.tool('list_directory')).content[0].text, new RegExp(`- ${workspace}  \\(Workspace\\)`));
  const listing = (await mcp.tool('list_directory', { path: join(workspace, 'results') })).content[0].text;
  assert.match(listing, /km\.png {2}\d+ B/);
  assert.match(listing, /report\.html/);
  assert.equal((await mcp.tool('list_directory', { path: '/etc' })).isError, true);

  // Shown in the executor's chat, not shared yet: the orchestrator does not see it.
  await call(codex, '_codeflower/sessions/record', { sessionId: executorId, entry: { kind: 'show', files: [figure, report] } });
  assert.match((await mcp.tool('list_files')).content[0].text, /Figures the user shared: none yet/);
  assert.equal((await mcp.tool('view_figure', { path: figure })).isError, true);
  await call(worker, '_codeflower/orchestrators/share', { executor, path: figure });
  assert.match((await mcp.tool('list_files')).content[0].text, new RegExp(`- ${figure}`));
  const image = await mcp.tool('view_figure', { path: figure });
  assert.equal(image.content[0].type, 'image');
  assert.equal(image.content[0].mimeType, 'image/webp');

  // Reports always: every one the chat showed.
  await call(worker, '_codeflower/orchestrators/setAccess', { key: created.key, access: { report: 'always', files: false } });
  assert.equal((await mcp.tool('read_report', { path: report })).content[0].text, 'Survival\nDone');
  assert.match((await mcp.tool('list_directory')).content[0].text, /does not let you list/);
});

test("the executor's question while the orchestrator's message waits behind the user's turn goes to that waiting call", async (t) => {
  const { meta, orchestratorSocket, executorId, executorAsks, codex } = await start(t);
  const mcp = mcpClient(t, meta.link, orchestratorSocket);
  await mcp.request('initialize', {});
  // The user's own turn runs; the orchestrator's message waits behind it.
  codex.send(JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'session/prompt', params: { sessionId: executorId, prompt: [{ type: 'text', text: 'long task' }] } }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const asking = mcp.tool('ask', { message: 'run failing command' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // The user's turn asks the orchestrator: no turn of the orchestrator's own, which would wait on the call above.
  const question = executorAsks(executorId, ['ask', 'Which column is the event?']);
  assert.match((await asking).content[0].text, /The executor asks you.*Which column is the event\?/s);
  const answering = mcp.tool('answer', { text: 'The event column.' });
  assert.equal((await question).stdout.trim(), 'The event column.');
  // The user's turn ends; the orchestrator's message runs and its reply comes back.
  codex.send(JSON.stringify({ jsonrpc: '2.0', id: 9002, method: 'fake/finish', params: { sessionId: executorId } }));
  assert.match((await answering).content[0].text, /The executor's reply:\nit failed/);
});

test("the executor's questions are limited per turn of its own", async (t) => {
  const { executorId, executorAsks, codex } = await start(t);
  // Turns the user started, one after another: each may ask again.
  for (let round = 0; round < 2; round++) {
    codex.send(JSON.stringify({ jsonrpc: '2.0', id: 9100 + round, method: 'session/prompt', params: { sessionId: executorId, prompt: [{ type: 'text', text: 'long task' }] } }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (let index = 0; index < 5; index++) assert.equal((await executorAsks(executorId, ['ask', `Question ${index}?`])).code, 0);
    const over = await executorAsks(executorId, ['ask', 'One more?']);
    assert.equal(over.code, 2);
    assert.match(over.stderr, /5 questions this turn/);
    codex.send(JSON.stringify({ jsonrpc: '2.0', id: 9200 + round, method: 'fake/finish', params: { sessionId: executorId } }));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});
