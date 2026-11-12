import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ENDED_KEPT, createCommands, runsCommand, standardCommandEvents, startCommandOutputServer, tailFile } from '../src/commands.js';

const wrapper = fileURLToPath(new URL('../../../bin/codeflower-cmd', import.meta.url));

// A window: what the registry sends it.
const viewer = () => {
  const messages = [];
  return { messages, send: (message) => messages.push(message) };
};
const feed = (commands, sessionId, updates, read = standardCommandEvents) => {
  for (const update of updates) for (const event of read(update)) commands.apply(sessionId, event);
};

// What codex-acp 2.3.0 sends of a command (its terminal _meta).
const codexCommand = (id, chunks, exitCode = 0) => [
  {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'npm test',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: ['/bin/bash', '-lc', 'npm test'] },
    content: [{ type: 'terminal', terminalId: id }],
    _meta: { terminal_info: { terminal_id: id, cwd: '/workspace' } }
  },
  ...chunks.map((data) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, _meta: { terminal_output_delta: { terminal_id: id, data } } })),
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    status: exitCode ? 'failed' : 'completed',
    _meta: { terminal_exit: { terminal_id: id, exit_code: exitCode, signal: null } }
  }
];

test("follows a Codex command's output and exit, and replays it to a window that attaches", () => {
  const changed = [];
  const commands = createCommands({ onChange: (sessionId) => changed.push(sessionId) });
  const [start, first, second, exit] = codexCommand('c1', ['one\n', 'two\n'], 3);
  feed(commands, 's', [start, first]);
  const [running] = commands.list('s');
  assert.equal(running.command, 'npm test');
  assert.equal(running.cwd, '/workspace');
  assert.equal(running.streams, true);
  assert.equal(running.endedAt, undefined);

  const window = viewer();
  commands.attach(commands.byId(running.commandId), window);
  feed(commands, 's', [second, exit]);
  assert.deepEqual(
    window.messages.map(({ method, params }) => [method, params.data ?? params.exitCode, params.replayed ?? false]),
    [
      ['_codeflower/terminal/output', 'one\n', true],
      ['_codeflower/terminal/output', 'two\n', false],
      ['_codeflower/terminal/exit', 3, false]
    ]
  );
  const [ended] = commands.list('s');
  assert.equal(ended.exitCode, 3);
  assert.ok(ended.endedAt);
  assert.ok(changed.includes('s'));
});

test('counts any agent’s execute tool calls, without output when the agent streams none', () => {
  const commands = createCommands();
  feed(commands, 's', [
    { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls -la' } },
    { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Read x', kind: 'read', status: 'in_progress' },
    { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'sleep 9', kind: 'execute', status: 'in_progress' }
  ]);
  assert.deepEqual(
    commands.list('s').map(({ command, streams }) => [command, streams]),
    [
      ['ls -la', false],
      ['sleep 9', false]
    ]
  );
  feed(commands, 's', [{ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' }]);
  assert.deepEqual(
    commands.list('s').map(({ command, endedAt }) => [command, Boolean(endedAt)]),
    [
      ['sleep 9', false],
      ['ls -la', true]
    ]
  );
  // Another chat's are its own.
  assert.deepEqual(commands.list('other'), []);
});

test('a command that goes to the background runs on until its AIR task ends, its output from the file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'commands-'));
  try {
    const file = join(folder, 'task.output');
    await writeFile(file, 'started\n');
    const commands = createCommands({ tail: (path, onData) => tailFile(path, onData, { pollMs: 20 }) });
    feed(commands, 's', [
      { sessionUpdate: 'tool_call', toolCallId: 'bash', title: 'npm run dev', kind: 'execute', status: 'pending', rawInput: { command: 'npm run dev', run_in_background: true } },
      // Claude Code: the call ends when the command goes to the background, before or after the task appears.
      { sessionUpdate: 'tool_call_update', toolCallId: 'bash', status: 'completed' },
      // As claude-agent-acp 0.98 sends it: the file comes in a progress update.
      { sessionUpdate: 'async_task_spawned', asyncTaskId: 't1', taskType: 'shell', name: 'Shell', description: 'npm run dev', toolCallId: 'bash' },
      { sessionUpdate: 'async_task_progress', asyncTaskId: 't1', outputFilePath: file },
      // Not a command.
      { sessionUpdate: 'async_task_spawned', asyncTaskId: 't2', taskType: 'turn', name: 'Turn' }
    ]);
    const [command] = commands.list('s');
    assert.equal(commands.list('s').length, 1);
    assert.equal(command.background, true);
    assert.equal(command.endedAt, undefined);
    const window = viewer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    commands.attach(commands.byId(command.commandId), window);
    await appendFile(file, 'ready\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    feed(commands, 's', [{ sessionUpdate: 'async_task_state_update', asyncTaskId: 't1', state: 'completed' }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const methods = window.messages.map(({ method, params }) => [method.split('/').at(-1), params.data ?? params.exitCode]);
    assert.deepEqual(methods, [
      ['output', 'started\n'],
      ['output', 'ready\n'],
      ['exit', null]
    ]);
    assert.ok(commands.list('s')[0].endedAt);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("reads ACP v2's terminal updates", () => {
  const commands = createCommands();
  const base64 = (text) => Buffer.from(text).toString('base64');
  feed(commands, 's', [
    { sessionUpdate: 'terminal_update', terminalId: 't', command: 'make', cwd: '/w' },
    { sessionUpdate: 'terminal_output_chunk', terminalId: 't', data: base64('built\n') },
    { sessionUpdate: 'terminal_update', terminalId: 't', exitStatus: { exitCode: 0, signal: null } }
  ]);
  const [command] = commands.list('s');
  assert.equal(command.command, 'make');
  assert.equal(command.exitCode, 0);
  assert.equal(commands.byId(command.commandId).buffer.text(), 'built\n');
});

test("an agent's own reading (its index.js commands.events) takes the place of the standard one", () => {
  const commands = createCommands();
  // e.g. an agent that names its commands in a form of its own.
  const read = (update, standard) =>
    update.sessionUpdate === 'pi_command' ? [{ type: update.done ? 'end' : 'start', id: update.id, command: update.line }] : standard(update);
  feed(commands, 's', [{ sessionUpdate: 'pi_command', id: 'p', line: 'cargo build' }], (update) => read(update, standardCommandEvents));
  assert.equal(commands.list('s')[0].command, 'cargo build');
  feed(commands, 's', [{ sessionUpdate: 'pi_command', id: 'p', done: true }], (update) => read(update, standardCommandEvents));
  assert.ok(commands.list('s')[0].endedAt);
});

test('keeps the last few ended commands of a chat, and forgets them all when cleared', () => {
  const commands = createCommands();
  for (let i = 0; i < ENDED_KEPT + 3; i++) {
    feed(commands, 's', [
      { sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: `echo ${i}`, kind: 'execute', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: `c${i}`, status: 'completed' }
    ]);
  }
  assert.equal(commands.list('s').length, ENDED_KEPT);
  assert.equal(commands.list('s').at(-1).command, `echo ${ENDED_KEPT + 2}`);
  const window = viewer();
  feed(commands, 's', [{ sessionUpdate: 'tool_call', toolCallId: 'live', title: 'sleep', kind: 'execute', status: 'in_progress' }]);
  commands.attach(commands.byId(commands.list('s')[0].commandId), window);
  commands.clear();
  assert.deepEqual(commands.list('s'), []);
  assert.equal(window.messages.at(-1).method, '_codeflower/terminal/exit');
});

test("codeflower-cmd copies a command's output to the bridge, which gives it to the command it runs", async () => {
  const folder = await mkdtemp(join(tmpdir(), 'commands-'));
  const socket = join(folder, 'commands.sock');
  const commands = createCommands();
  const command = `printf 'a\\n'; sleep 0.2; printf 'b\\n' >&2; exit 4`;
  feed(commands, 's', [
    { sessionUpdate: 'tool_call', toolCallId: 'bash', title: 'Print', kind: 'execute', status: 'in_progress', rawInput: { command } },
    { sessionUpdate: 'tool_call', toolCallId: 'other', title: 'Other', kind: 'execute', status: 'in_progress', rawInput: { command: 'make' } }
  ]);
  const runs = [];
  const server = await startCommandOutputServer(socket, (run) => {
    runs.push(run);
    return commands.claim(run.command);
  });
  try {
    // A hook's run is none of the commands: it runs, and nothing gets its output.
    await promisify(execFile)(process.execPath, [wrapper, 'echo hook'], { env: { ...process.env, CODEFLOWER_COMMANDS_SOCKET: socket, CODEFLOWER_COMMANDS_AGENT: 'claude' } });
    // As Claude Code runs a command, inside its own setup.
    const line = `: snapshot; eval '${command.replaceAll("'", "'\\''")}' < /dev/null`;
    const result = await promisify(execFile)(process.execPath, [wrapper, line], { env: { ...process.env, CODEFLOWER_COMMANDS_SOCKET: socket, CODEFLOWER_COMMANDS_AGENT: 'claude' } }).catch((error) => error);
    // The agent gets what it would without the wrapper.
    assert.equal(result.code, 4);
    assert.equal(result.stdout, 'a\n');
    assert.equal(result.stderr, 'b\n');
    assert.ok(runs.every((run) => run.agent === 'claude'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [print, make] = commands.list('s');
    assert.equal(print.streams, true);
    assert.equal(make.streams, false);
    assert.equal(commands.byId(print.commandId).buffer.text(), 'a\nb\n');
  } finally {
    await server.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('codeflower-cmd runs the command alone without the bridge', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [wrapper, 'echo "$0"', 'ignored'], { env: { ...process.env, CODEFLOWER_COMMANDS_SOCKET: '/nonexistent/x.sock', CODEFLOWER_COMMANDS_AGENT: 'claude' } }).catch((error) => error);
  // Several arguments: a program and its arguments.
  assert.equal(stdout, '');
  const alone = await promisify(execFile)(process.execPath, [wrapper, 'printf "%s" "$CODEFLOWER_COMMANDS_SOCKET"'], { env: { ...process.env, CODEFLOWER_COMMANDS_SOCKET: '/nonexistent/x.sock', CODEFLOWER_COMMANDS_AGENT: 'claude' } });
  // Its variables are not the command's.
  assert.equal(alone.stdout, '');
  assert.equal(runsCommand(`eval 'ls -la'`, 'ls -la'), true);
  assert.equal(runsCommand(`eval 'ls -la'`, ''), false);
});

test('a command waits while the user is asked for permission to run it, and runs from the answer', () => {
  let clock = 0;
  const commands = createCommands({ now: () => new Date(clock) });
  feed(commands, 's', [{ sessionUpdate: 'tool_call', toolCallId: 'bash', title: 'rm -rf build', kind: 'execute', status: 'pending' }]);
  commands.waiting('s', 'bash', 'request-1');
  assert.equal(commands.list('s')[0].waiting, true);
  clock = 5000;
  commands.answered('request-1');
  const [command] = commands.list('s');
  assert.equal(command.waiting, undefined);
  assert.equal(command.startedAt, new Date(5000).toISOString());
});
