import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { hookSettings, updatesFor } from '../src/agents/claude/mirror.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const fakeClaudeTui = fileURLToPath(new URL('../fixtures/fake-claude-tui.js', import.meta.url));
const hookScript = fileURLToPath(new URL('../../../bin/codeflower-hook', import.meta.url));
const ptyHelper = ['python3', fileURLToPath(new URL('../../../bin/codeflower-pty', import.meta.url))];
const token = 'k'.repeat(43);

function window(address) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp?agent=claude`, { headers: { authorization: `Bearer ${token}` } });
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
    messages,
    opened: once(socket, 'open'),
    send: (message) => socket.send(JSON.stringify(message)),
    receive(predicate, timeout = 8000) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => waiters.includes(waiter) && reject(new Error('nothing came in time')), timeout).unref();
      });
    },
    async call(method, params = {}) {
      const id = `w-${nextId++}`;
      self.send({ jsonrpc: '2.0', id, method, params });
      const answer = await self.receive((message) => message.id === id && message.method === undefined);
      if (answer.error) throw new Error(answer.error.message);
      return answer.result;
    },
    output: (terminalId) =>
      messages
        .filter((message) => message.method === '_codeflower/terminal/output' && message.params.terminalId === terminalId)
        .map((message) => message.params.data)
        .join(''),
    async printed(terminalId, pattern) {
      const deadline = Date.now() + 8000;
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

async function startHandoffBridge(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-handoff-')));
  const home = join(directory, 'claude');
  const workspace = join(directory, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace);
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: home };
  const { claude } = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const prepared = [];
  const agent = {
    ...claude,
    home,
    // Claude Code's command, with the fake terminal UI in its place.
    tuiCommand: async ({ sessionId, settings, mode, mcpConfig }) => [
      process.execPath,
      fakeClaudeTui,
      '--resume',
      sessionId,
      '--settings',
      JSON.stringify(settings),
      ...(mode ? ['--permission-mode', mode] : []),
      ...(mcpConfig ? ['--mcp-config', mcpConfig] : [])
    ],
    prepareTui: async (options) => prepared.push(options)
  };
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-handoff',
    sessionsDirectory: join(directory, 'sessions'),
    agents: { claude: agent },
    ptyHelper,
    environment,
    workspace,
    showSocket: join(directory, 'show.sock'),
    hookSocket: join(directory, 'hook.sock'),
    hookCommand: `${process.execPath} ${hookScript}`,
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { bridge, workspace, prepared };
}

async function open(t, bridge) {
  const self = window(bridge.address);
  t.after(() => self.close());
  await self.opened;
  return self;
}

test("reads Claude Code's transcript as the updates its adapter would send", () => {
  assert.deepEqual(
    updatesFor({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }
        ]
      }
    }),
    [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash: ls -la', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls -la' } }
    ]
  );
  assert.deepEqual(updatesFor({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }], is_error: true }] } }), [
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'out' } }] }
  ]);
  // The user's own messages come from the hooks; a subagent's lines stay out.
  assert.deepEqual(updatesFor({ type: 'user', message: { content: 'hello' } }), []);
  assert.deepEqual(updatesFor({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'x' }] } }), []);
  // Every hook runs the command, and decides nothing.
  const settings = hookSettings('codeflower-hook', { plansDirectory: 'plans' });
  assert.equal(settings.plansDirectory, 'plans');
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'codeflower-hook', timeout: 5 }] }]);
  assert.equal(settings.hooks.PermissionRequest[0].matcher, '*');
});

test("hands a chat over to Claude Code's terminal UI, shows its turns in the windows, types theirs in, and takes it back", async (t) => {
  const { bridge, workspace, prepared } = await startHandoffBridge(t);
  const chat = await open(t, bridge);
  await chat.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await chat.call('session/new', { cwd: workspace, mcpServers: [] });
  const key = sessionKey('claude', sessionId);
  await chat.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'before' }] });

  const attach = await open(t, bridge);
  const started = await attach.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: key, columns: 100, rows: 30 });
  await attach.printed(started.terminalId, new RegExp(`claude tui for ${sessionId}`));
  assert.deepEqual(prepared, [{ cwd: workspace }]);
  assert.equal((await chat.call('_codeflower/terminal/list')).terminals[0].mode, 'handoff');

  // Typed in the terminal: the window sees the prompt, the answer, the tool,
  // the wait for permission, and the turn's end.
  await attach.call('_codeflower/terminal/input', { terminalId: started.terminalId, data: 'hello tui\r' });
  await attach.printed(started.terminalId, /done hello tui/);
  const prompted = await chat.receive((message) => message.method === '_codeflower/prompted' && message.params.prompt[0].text === 'hello tui');
  assert.equal(prompted.params._meta['codeflower/from'], 'terminal');
  await chat.receive((message) => message.method === 'session/update' && message.params.update.content?.text === 'answer to hello tui');
  await chat.receive((message) => message.method === 'session/update' && message.params.update.sessionUpdate === 'tool_call_update' && message.params.update.status === 'completed');
  await chat.receive((message) => message.method === '_codeflower/activity' && message.params.chats.some((entry) => entry.key === key && entry.state === 'waiting'));
  await chat.receive((message) => message.method === '_codeflower/activity' && message.params.ended.some((turn) => turn.key === key && turn.stopReason === 'end_turn'));

  // From the window: typed into the terminal, answered when its turn ends.
  const answer = await chat.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'from the web' }] });
  assert.equal(answer.stopReason, 'end_turn');
  await attach.printed(started.terminalId, /done from the web/);
  await chat.receive((message) => message.method === 'session/update' && message.params.update.content?.text === 'answer to from the web');
  // Only text, and nothing else changes the chat meanwhile.
  await assert.rejects(chat.call('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }), /takes text only/);
  await assert.rejects(chat.call('session/set_mode', { sessionId, modeId: 'plan' }), /terminal UI/);
  // A window that opens the chat now attaches to what the bridge keeps.
  const late = await open(t, bridge);
  await late.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(typeof (await late.call('session/resume', { sessionId, cwd: workspace, mcpServers: [] }))._meta['codeflower/transcriptEntries'], 'number');

  // Quit: the adapter has the chat again.
  await attach.call('_codeflower/terminal/input', { terminalId: started.terminalId, data: 'quit\r' });
  await attach.receive((message) => message.method === '_codeflower/terminal/exit');
  const back = await chat.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'after' }] });
  assert.equal(back.stopReason, 'end_turn');
  await chat.receive((message) => message.method === 'session/update' && message.params.update.content?.text === `reply to after in ${sessionId}`);

  const { entries } = await chat.call('_codeflower/sessions/transcript', { key });
  const story = entries
    .map((entry) =>
      entry.kind === 'prompt'
        ? `prompt:${entry.prompt[0].text}`
        : entry.kind === 'update'
          ? entry.update.sessionUpdate === 'agent_message_chunk'
            ? `says:${entry.update.content.text}`
            : entry.update.sessionUpdate
          : entry.kind
    )
    .filter((line) => !['available_commands_update', 'config_option_update', 'usage_update', 'session_info_update'].includes(line));
  assert.deepEqual(story, [
    'prompt:before',
    `says:reply to before in ${sessionId}`,
    'turn_end',
    'prompt:hello tui',
    'says:answer to hello tui',
    'tool_call',
    'tool_call_update',
    'turn_end',
    'prompt:from the web',
    'says:answer to from the web',
    'tool_call',
    'tool_call_update',
    'turn_end',
    'prompt:after',
    `says:reply to after in ${sessionId}`,
    'turn_end'
  ]);
});

test('takes the chat back when its terminal UI moves to another session', async (t) => {
  const { bridge, workspace } = await startHandoffBridge(t);
  const chat = await open(t, bridge);
  await chat.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await chat.call('session/new', { cwd: workspace, mcpServers: [] });
  const attach = await open(t, bridge);
  const started = await attach.call('_codeflower/terminal/start', { kind: 'chat', sessionKey: sessionKey('claude', sessionId) });
  await attach.printed(started.terminalId, /claude tui for/);
  await attach.call('_codeflower/terminal/input', { terminalId: started.terminalId, data: 'other\r' });
  const left = await attach.receive((message) => message.method === '_codeflower/terminal/left');
  assert.equal(left.params.sessionKey, sessionKey('claude', sessionId));
  // The window goes on with the adapter, and the other session stays out of the chat.
  const answer = await chat.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'still mine' }] });
  assert.equal(answer.stopReason, 'end_turn');
  await attach.call('_codeflower/terminal/input', { terminalId: started.terminalId, data: 'elsewhere\r' });
  await attach.printed(started.terminalId, /done elsewhere/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(chat.messages.some((message) => JSON.stringify(message).includes('answer to elsewhere')), false);
  await readFile(join(workspace, '..', 'claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'), 'other-session.jsonl'));
});
