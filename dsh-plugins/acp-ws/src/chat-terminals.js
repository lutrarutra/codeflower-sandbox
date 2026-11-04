// The agents' own terminal UIs on the worker's chats (`codeflower attach`),
// and the user's shells (the page's Terminal). A terminal belongs to the
// worker, not to a window: it keeps running
// while nobody looks at it, and windows attach to it and detach again. Each
// gets what it printed since it last redrew (a ring buffer) and the output
// from then on.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// What a window that attaches gets of the output so far.
export const TERMINAL_BUFFER_BYTES = 256 * 1024;
export const MIN_COLUMNS = 20;
export const MAX_COLUMNS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;

const KILL_AFTER_MS = 3000;

const running = (child) => child.exitCode === null && child.signalCode === null;

// The program gets SIGHUP when its pseudo-terminal closes with the helper.
function end(child) {
  if (!running(child)) return Promise.resolve();
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => running(child) && child.kill('SIGKILL'), KILL_AFTER_MS);
  timer.unref();
  return closed.finally(() => clearTimeout(timer));
}

export function terminalSize(params, fallback = { columns: 100, rows: 30 }) {
  const clamp = (value, min, max, otherwise) => (Number.isInteger(value) ? Math.min(Math.max(value, min), max) : otherwise);
  return {
    columns: clamp(params?.columns, MIN_COLUMNS, MAX_COLUMNS, fallback.columns),
    rows: clamp(params?.rows, MIN_ROWS, MAX_ROWS, fallback.rows)
  };
}

/**
 * ptyHelper: the command that runs a program in a pseudo-terminal
 * (codeflower-pty), which takes resizes on its file descriptor 3.
 * onChange: the list of terminals changed (one started, ended, or a window
 * attached or left).
 */
export function createChatTerminals({ ptyHelper, log = () => {}, onChange = () => {} }) {
  const terminals = new Map();

  const describe = (terminal) => ({
    terminalId: terminal.id,
    kind: terminal.kind,
    ...(terminal.kind === 'chat'
      ? {
          sessionKey: terminal.key,
          sessionId: terminal.sessionId,
          // shared: the chat goes on in the windows too; handoff: the terminal has it.
          mode: terminal.mode
        }
      : {}),
    viewers: terminal.viewers.size,
    startedAt: terminal.startedAt
  });

  const notify = (client, method, params) => client.send({ jsonrpc: '2.0', method, params });

  const remember = (terminal, data) => {
    terminal.buffer.push(data);
    terminal.buffered += data.length;
    while (terminal.buffered > TERMINAL_BUFFER_BYTES && terminal.buffer.length > 1) {
      terminal.buffered -= terminal.buffer.shift().length;
    }
  };

  const setSize = (terminal, { columns, rows }) => {
    terminal.columns = columns;
    terminal.rows = rows;
    if (terminal.control?.writable) terminal.control.write(`${JSON.stringify({ resize: [columns, rows] })}\n`);
  };

  return {
    /**
     * Starts `command` for a chat, or a shell (`kind`). `key` is the chat's
     * session key, so a chat has one terminal at most; a shell has its own.
     */
    start({ kind = 'chat', key, sessionId, command, env, cwd, size, mode = 'shared' }) {
      if (!Array.isArray(ptyHelper) || ptyHelper.length === 0) throw new Error('This worker cannot open terminals');
      if (terminals.has(key)) throw new Error(kind === 'chat' ? 'The chat already has a terminal' : 'The terminal is already running');
      const child = spawn(ptyHelper[0], [...ptyHelper.slice(1), ...command], {
        env: { ...env, COLUMNS: String(size.columns), LINES: String(size.rows) },
        cwd,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe']
      });
      const terminal = {
        id: randomUUID(),
        kind,
        key,
        sessionId,
        mode,
        child,
        control: child.stdio[3],
        viewers: new Map(),
        buffer: [],
        buffered: 0,
        columns: size.columns,
        rows: size.rows,
        startedAt: new Date().toISOString()
      };
      terminals.set(key, terminal);
      const output = (data) => {
        remember(terminal, data);
        for (const client of terminal.viewers.keys()) notify(client, '_codeflower/terminal/output', { terminalId: terminal.id, data });
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', output);
      child.stderr.on('data', output);
      child.stdin.on('error', () => {});
      terminal.control.on('error', () => {});
      child.once('error', (error) => output(`\r\nCould not start the terminal: ${error.message}\r\n`));
      child.once('close', (code, signal) => {
        terminals.delete(key);
        const exitCode = code ?? (signal ? 128 : 1);
        log(`The terminal of ${key} ended (${exitCode})`);
        for (const client of terminal.viewers.keys()) notify(client, '_codeflower/terminal/exit', { terminalId: terminal.id, exitCode });
        terminal.viewers.clear();
        terminal.onExit?.(exitCode);
        onChange();
      });
      onChange();
      return terminal;
    },

    byId(terminalId) {
      for (const terminal of terminals.values()) if (terminal.id === terminalId) return terminal;
      return undefined;
    },

    byKey(key) {
      return terminals.get(key);
    },

    /**
     * A window watches the terminal: it gets the output so far, and a resize
     * makes the program draw itself again at the window's size. A window that
     * only watches (`watch`) never sets the size.
     */
    attach(terminal, client, { size, watch = false }) {
      terminal.viewers.set(client, { watch });
      const replay = terminal.buffer.join('');
      if (replay) notify(client, '_codeflower/terminal/output', { terminalId: terminal.id, data: replay, replayed: true });
      if (!watch) {
        // The same size again would not make it redraw: one row less first.
        // A shell's replay is enough, and a shell only redraws its prompt.
        if (terminal.kind === 'chat' && size.columns === terminal.columns && size.rows === terminal.rows) {
          setSize(terminal, { columns: size.columns, rows: Math.max(MIN_ROWS, size.rows - 1) });
        }
        setSize(terminal, size);
      }
      onChange();
    },

    detach(terminal, client) {
      if (terminal.viewers.delete(client)) onChange();
    },

    // Tells the windows that watch one terminal.
    notify(terminal, method, params) {
      for (const client of terminal.viewers.keys()) notify(client, method, { terminalId: terminal.id, ...params });
    },

    // Tells every window that watches a chat's terminal (the rail in `codeflower attach`).
    notifyViewers(method, params) {
      for (const terminal of terminals.values()) {
        if (terminal.kind !== 'chat') continue;
        for (const client of terminal.viewers.keys()) notify(client, method, { terminalId: terminal.id, ...params });
      }
    },

    // A window went: it stops watching every terminal, which keep running.
    detachClient(client) {
      let changed = false;
      for (const terminal of terminals.values()) changed = terminal.viewers.delete(client) || changed;
      if (changed) onChange();
    },

    // The window that types sets the size.
    resize(terminal, client, size) {
      if (terminal.viewers.get(client)?.watch) return;
      setSize(terminal, size);
    },

    input(terminal, client, data) {
      const viewer = terminal.viewers.get(client);
      if (!viewer) throw new Error('Attach to the terminal first');
      if (viewer.watch) return;
      terminal.child.stdin.write(data);
    },

    // Typed on the user's behalf, e.g. a prompt sent from another window.
    write(terminal, data) {
      terminal.child.stdin.write(data);
    },

    close(terminal) {
      return end(terminal.child);
    },

    list() {
      return [...terminals.values()].map(describe);
    },

    count(kind) {
      return [...terminals.values()].filter((terminal) => terminal.kind === kind).length;
    },

    describe,

    async closeAll() {
      await Promise.all([...terminals.values()].map((terminal) => end(terminal.child)));
    }
  };
}
