// The commands the agents run, by chat: which run, and their output where the
// agent lets the bridge see it, for windows to show ("2 commands running") and
// to watch read-only (`_codeflower/terminal/attach` with a command's id).
//
// The registry knows no agent. It takes events (`start`, `output`, `end`,
// `background`) that standardCommandEvents reads from what any ACP agent
// sends, or that an agent's own `commands.events` (its index.js) makes of its
// updates. Output comes in those events, or from a file the bridge follows
// (an AIR task's `outputFilePath`, e.g. Claude Code's background commands).
import { randomUUID } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { createRingBuffer } from './ring-buffer.js';

// What a window that attaches gets of the output so far.
export const COMMAND_BUFFER_BYTES = 256 * 1024;
// Ended commands kept per chat, so a window can still read how they ended.
export const ENDED_KEPT = 5;
// The AIR task types that are commands (claude-agent-acp's names).
export const COMMAND_TASK_TYPES = new Set(['shell', 'monitor']);
const TASK_ENDED = new Set(['completed', 'failed', 'stopped']);
const TAIL_POLL_MS = 500;
const TAIL_READ_BYTES = 64 * 1024;

const nonBlank = (value) => (typeof value === 'string' && value.trim() ? value : undefined);
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const finished = (status) => status === 'completed' || status === 'failed';

function base64Text(data) {
  if (typeof data !== 'string') return '';
  return Buffer.from(data, 'base64').toString('utf8');
}

/**
 * The command events in one ACP session update, from what agents send of
 * their commands without being asked:
 *  - tool calls of kind `execute` (any agent): one command each, ending with the call;
 *  - the `_meta` terminal convention Zed began (Codex's adapter):
 *    `terminal_info`, `terminal_output_delta` / `terminal_output` (`{terminal_id, data}`, text)
 *    and `terminal_exit` (`{exit_code}`), on the tool call;
 *  - ACP v2's `terminal_update` / `terminal_output_chunk` (base64 data);
 *  - AIR async tasks of a command type (`async_task_*`, Claude Code's background
 *    commands): the command goes on after its tool call, its output in the
 *    `outputFilePath` that one of them names (Claude Code's: `async_task_progress`).
 */
export function standardCommandEvents(update) {
  const events = [];
  if (!record(update)) return events;
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const id = nonBlank(update.toolCallId);
      if (!id) break;
      const meta = record(update._meta) ?? {};
      const info = record(meta.terminal_info);
      const input = record(update.rawInput);
      const command = nonBlank(input?.command) ?? nonBlank(input?.cmd) ?? nonBlank(update.title);
      const cwd = nonBlank(info?.cwd) ?? nonBlank(input?.cwd);
      const isCommand = update.kind === 'execute' || info !== undefined;
      if (isCommand && !finished(update.status)) {
        events.push({ type: 'start', id, ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) });
      } else if (update.sessionUpdate === 'tool_call_update' && (command || cwd)) {
        // A later title or input of a command it already knows.
        events.push({ type: 'info', id, ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) });
      }
      const chunk = record(meta.terminal_output_delta) ?? record(meta.terminal_output);
      if (typeof chunk?.data === 'string' && chunk.data) events.push({ type: 'output', id, data: chunk.data });
      const exit = record(meta.terminal_exit);
      if (exit || finished(update.status)) {
        events.push({ type: 'end', id, ...(typeof exit?.exit_code === 'number' ? { exitCode: exit.exit_code } : {}) });
      }
      break;
    }
    case 'terminal_update': {
      const id = nonBlank(update.terminalId);
      if (!id) break;
      const command = nonBlank(update.command);
      if (command || update.cwd) events.push({ type: 'start', id, ...(command ? { command } : {}), ...(nonBlank(update.cwd) ? { cwd: update.cwd } : {}) });
      const data = base64Text(record(update.output)?.data);
      if (data) events.push({ type: 'output', id, data });
      const status = record(update.exitStatus);
      if (status) events.push({ type: 'end', id, ...(typeof status.exitCode === 'number' ? { exitCode: status.exitCode } : {}) });
      break;
    }
    case 'terminal_output_chunk': {
      const id = nonBlank(update.terminalId);
      const data = base64Text(update.data);
      if (id && data) events.push({ type: 'output', id, data });
      break;
    }
    case 'async_task_spawned':
    case 'async_task_progress':
    case 'async_task_state_update': {
      const taskId = nonBlank(update.asyncTaskId);
      if (!taskId) break;
      if (update.sessionUpdate === 'async_task_spawned') {
        if (!COMMAND_TASK_TYPES.has(update.taskType)) break;
        events.push({
          type: 'background',
          taskId,
          ...(nonBlank(update.toolCallId) ? { id: update.toolCallId } : {}),
          command: nonBlank(update.description) ?? nonBlank(update.name) ?? 'Background command',
          ...(nonBlank(update.outputFilePath) ? { outputFilePath: update.outputFilePath } : {})
        });
      } else if (nonBlank(update.outputFilePath)) {
        events.push({ type: 'background', taskId, outputFilePath: update.outputFilePath });
      }
      if (TASK_ENDED.has(update.state)) events.push({ type: 'end', taskId });
      break;
    }
  }
  return events;
}

/**
 * Whether a command line run by the agent's shell (what its shell prefix got,
 * e.g. Claude Code's, with its own setup around it) runs `command`: the
 * command as it is, or quoted for a shell or for JSON.
 */
export function runsCommand(line, command) {
  if (typeof line !== 'string' || typeof command !== 'string' || !command.trim()) return false;
  const forms = [
    command,
    command.replaceAll("'", "'\\''"),
    command.replace(/(["\\$`])/g, '\\$1'),
    JSON.stringify(command).slice(1, -1)
  ];
  return forms.some((form) => line.includes(form));
}

/**
 * Follows a file as it grows: `onData` gets what was there and what is added.
 * Returns a function that reads the rest once more and stops.
 */
export function tailFile(path, onData, { pollMs = TAIL_POLL_MS, startBytes = COMMAND_BUFFER_BYTES } = {}) {
  let offset;
  let stopped = false;
  let reading = Promise.resolve();
  const read = () => {
    reading = reading.then(async () => {
      let handle;
      try {
        const { size } = await stat(path);
        // A file that started over (truncated) is read again from its start.
        if (offset === undefined || size < offset) offset = Math.max(0, size - startBytes);
        if (size === offset) return;
        handle = await open(path, 'r');
        while (offset < size) {
          const buffer = Buffer.alloc(Math.min(TAIL_READ_BYTES, size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          onData(buffer.subarray(0, bytesRead).toString('utf8'));
        }
      } catch {
        // Not there yet, or gone: the next poll looks again.
      } finally {
        await handle?.close();
      }
    });
    return reading;
  };
  let watcher;
  try {
    watcher = watch(path, { persistent: false }, () => void read());
    watcher.on('error', () => {});
  } catch {}
  const timer = setInterval(() => void read(), pollMs);
  timer.unref();
  void read();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    watcher?.close();
    await read();
  };
}

/**
 * onChange(sessionId): the chat's commands changed (one started, ended, or
 * a window began or stopped watching one). The registry is one agent's.
 */
export function createCommands({ onChange = () => {}, tail = tailFile, now = () => new Date() } = {}) {
  // By the registry's own id, which windows attach with.
  const commands = new Map();
  // By chat and the agent's id of the command (its tool call), and by AIR task.
  const byAgentId = new Map();
  const byTask = new Map();
  const agentKey = (sessionId, id) => `${sessionId}\u0000${id}`;

  const notify = (client, method, params) => client.send({ jsonrpc: '2.0', method, params });

  const describe = (command) => ({
    commandId: command.id,
    ...(command.toolCallId ? { toolCallId: command.toolCallId } : {}),
    command: command.command,
    ...(command.cwd ? { cwd: command.cwd } : {}),
    background: command.background,
    streams: command.streams,
    ...(command.waitingFor ? { waiting: true } : {}),
    startedAt: command.startedAt,
    ...(command.endedAt ? { endedAt: command.endedAt } : {}),
    ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    viewers: command.viewers.size
  });

  const create = (sessionId, { id, command }) => {
    const entry = {
      id: randomUUID(),
      sessionId,
      toolCallId: id,
      taskId: undefined,
      command: command ?? 'Command',
      cwd: undefined,
      background: false,
      streams: false,
      startedAt: now().toISOString(),
      endedAt: undefined,
      exitCode: undefined,
      buffer: createRingBuffer(COMMAND_BUFFER_BYTES),
      viewers: new Set(),
      stopTail: undefined
    };
    commands.set(entry.id, entry);
    if (id) byAgentId.set(agentKey(sessionId, id), entry);
    return entry;
  };

  const output = (command, data) => {
    command.buffer.push(data);
    for (const client of command.viewers) notify(client, '_codeflower/terminal/output', { terminalId: command.id, data });
  };

  // A chat keeps its last few ended commands.
  const prune = (sessionId) => {
    const ended = [...commands.values()].filter((command) => command.sessionId === sessionId && command.endedAt);
    for (const command of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) forget(command);
  };

  const forget = (command) => {
    commands.delete(command.id);
    if (command.toolCallId && byAgentId.get(agentKey(command.sessionId, command.toolCallId)) === command) {
      byAgentId.delete(agentKey(command.sessionId, command.toolCallId));
    }
    if (command.taskId) byTask.delete(command.taskId);
    void command.stopTail?.();
  };

  const end = (command, exitCode) => {
    if (command.endedAt) return;
    command.endedAt = now().toISOString();
    if (exitCode !== undefined) command.exitCode = exitCode;
    const stop = command.stopTail;
    command.stopTail = undefined;
    const done = () => {
      for (const client of command.viewers) {
        notify(client, '_codeflower/terminal/exit', { terminalId: command.id, exitCode: command.exitCode ?? null });
      }
      command.viewers.clear();
      prune(command.sessionId);
      onChange(command.sessionId);
    };
    // What the file got last comes before the end.
    if (stop) void stop().finally(done);
    else done();
  };

  const follow = (command, path) => {
    if (command.stopTail || command.endedAt) return;
    command.streams = true;
    command.stopTail = tail(path, (data) => output(command, data));
  };

  return {
    /** Applies one event of the chat's (standardCommandEvents' form). */
    apply(sessionId, event) {
      if (!record(event) || typeof sessionId !== 'string') return;
      const known = event.id ? byAgentId.get(agentKey(sessionId, event.id)) : undefined;
      switch (event.type) {
        case 'start': {
          if (known && !known.endedAt) {
            if (event.command) known.command = event.command;
            if (event.cwd) known.cwd = event.cwd;
            onChange(sessionId);
            return;
          }
          if (known) return; // A late update of one that ended.
          const command = create(sessionId, event);
          if (event.cwd) command.cwd = event.cwd;
          onChange(sessionId);
          return;
        }
        case 'info':
          if (!known) return;
          if (event.command) known.command = event.command;
          if (event.cwd) known.cwd = event.cwd;
          onChange(sessionId);
          return;
        case 'output': {
          if (!known || known.endedAt || typeof event.data !== 'string' || !event.data) return;
          const first = !known.streams;
          known.streams = true;
          output(known, event.data);
          if (first) onChange(sessionId);
          return;
        }
        case 'background': {
          let command = (event.taskId && byTask.get(event.taskId)) ?? known;
          if (!command) command = create(sessionId, { id: event.id, command: event.command });
          if (event.taskId && !command.taskId) {
            command.taskId = event.taskId;
            byTask.set(event.taskId, command);
          }
          // Its tool call ended when it went to the background: it runs on.
          if (!command.background && command.endedAt && command.exitCode === undefined) command.endedAt = undefined;
          command.background = true;
          if (event.outputFilePath) follow(command, event.outputFilePath);
          onChange(sessionId);
          return;
        }
        case 'end': {
          const command = (event.taskId && byTask.get(event.taskId)) ?? known;
          if (!command) return;
          // A background command's tool call ends when it starts; the task ends it.
          if (command.background && !event.taskId) return;
          end(command, typeof event.exitCode === 'number' ? event.exitCode : undefined);
          return;
        }
      }
    },

    /** The chat's commands, running ones first in the order they started. */
    list(sessionId) {
      const own = [...commands.values()].filter((command) => command.sessionId === sessionId);
      return [...own.filter((command) => !command.endedAt), ...own.filter((command) => command.endedAt)].map(describe);
    },

    /**
     * The running command a shell prefix's run is (codeflower-cmd), which gets
     * its output from then on: one that streams nothing yet, the longest that
     * the line runs (a hook's line runs none), the oldest of equals.
     */
    claim(line) {
      let best;
      for (const command of commands.values()) {
        if (command.endedAt || command.background || command.streams || command.claimed) continue;
        if (!runsCommand(line, command.command)) continue;
        if (!best || command.command.length > best.command.length) best = command;
      }
      if (!best) return undefined;
      best.claimed = true;
      best.streams = true;
      onChange(best.sessionId);
      return {
        output: (data) => {
          if (!best.endedAt && data) output(best, data);
        }
      };
    },

    sessions: () => [...new Set([...commands.values()].map((command) => command.sessionId))],

    byId: (commandId) => commands.get(commandId),

    describe,

    /**
     * A permission request (`requestKey`) asks to run one of the chat's
     * commands, by its tool call: it waits for the user, so it does not run
     * yet. Agents (Claude Code) report the call before they ask.
     */
    waiting(sessionId, toolCallId, requestKey) {
      const command = byAgentId.get(agentKey(sessionId, toolCallId));
      if (!command || command.endedAt) return;
      command.waitingFor = requestKey;
      onChange(sessionId);
    },

    /** The permission request was answered: its command runs, or ends declined. */
    answered(requestKey) {
      for (const command of commands.values()) {
        if (command.waitingFor !== requestKey) continue;
        command.waitingFor = undefined;
        // It runs from now.
        if (!command.endedAt) command.startedAt = now().toISOString();
        onChange(command.sessionId);
      }
    },

    /** A window watches the command: it gets the output so far, then the rest. */
    attach(command, client) {
      command.viewers.add(client);
      const replay = command.buffer.text();
      if (replay) notify(client, '_codeflower/terminal/output', { terminalId: command.id, data: replay, replayed: true });
      if (command.endedAt) {
        notify(client, '_codeflower/terminal/exit', { terminalId: command.id, exitCode: command.exitCode ?? null });
        command.viewers.delete(client);
      } else onChange(command.sessionId);
    },

    detach(command, client) {
      if (command.viewers.delete(client)) onChange(command.sessionId);
    },

    detachClient(client) {
      for (const command of commands.values()) if (command.viewers.delete(client)) onChange(command.sessionId);
    },

    /** Forgets the chat's commands, or all (the agent ended): what still runs ended with it. */
    clear(sessionId) {
      const sessions = new Set();
      for (const command of [...commands.values()]) {
        if (sessionId !== undefined && command.sessionId !== sessionId) continue;
        for (const client of command.viewers) notify(client, '_codeflower/terminal/exit', { terminalId: command.id, exitCode: null });
        sessions.add(command.sessionId);
        forget(command);
      }
      for (const session of sessions) onChange(session);
    }
  };
}

// A run's first line: who runs what.
const MAX_HEADER = 256 * 1024;

/**
 * Where codeflower-cmd (an agent's shell prefix) sends a copy of a command's
 * output: a line of JSON (`{agent, command, cwd, pid}`), then the output.
 * `onRun(header)` gives the sink of a command it is, or nothing: its output is
 * then dropped, and the command runs on all the same.
 */
export async function startCommandOutputServer(socketPath, onRun) {
  await unlink(socketPath).catch(() => {});
  const server = createServer((socket) => {
    socket.on('error', () => {});
    const decoder = new StringDecoder('utf8');
    let header = '';
    let sink;
    let waiting = false;
    const early = [];
    socket.on('data', (chunk) => {
      if (sink) return sink.output(decoder.write(chunk));
      if (waiting) return early.push(chunk);
      const text = chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) {
        header += text;
        if (header.length > MAX_HEADER) socket.destroy();
        return;
      }
      header += text.slice(0, newline);
      early.push(chunk.subarray(Buffer.byteLength(text.slice(0, newline + 1))));
      waiting = true;
      let parsed;
      try {
        parsed = JSON.parse(header);
      } catch {
        return socket.destroy();
      }
      Promise.resolve(onRun(parsed)).then(
        (found) => {
          if (!found) return socket.destroy();
          sink = found;
          for (const piece of early.splice(0)) sink.output(decoder.write(piece));
        },
        () => socket.destroy()
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch(() => {});
    }
  };
}
