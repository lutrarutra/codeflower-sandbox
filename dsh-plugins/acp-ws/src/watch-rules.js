// The rules of a watch (codeflower-watch): how its durations and condition
// read, and what a run's outcome means. The bridge (watches.js) and the
// command (bin/codeflower-watch, which runs a watch itself where there is no
// bridge) both use them, so both decide alike.

import { readFileSync } from 'node:fs';

// A watch's command runs at most this often.
export const MIN_EVERY_MS = 10_000;
export const DEFAULT_EVERY_MS = 60_000;
// How long a watch runs before it gives up, by default and at most.
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60_000;
export const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
// One run that takes longer is stopped, and counts as an error.
export const RUN_TIMEOUT_MS = 5 * 60_000;
// Errors in a row (not "not yet") that end a watch as failing.
export const MAX_FAILURES = 3;
// Watches that run at once in one chat.
export const MAX_ACTIVE_PER_CHAT = 8;
// How long `--wait` holds the command by default (agents' shell tools time
// out after a few minutes), and at most.
export const DEFAULT_WAIT_MS = 85_000;
export const MAX_WAIT_MS = 60 * 60_000;
export const MAX_COMMAND_LENGTH = 16 * 1024;
// How often a watch with --pid looks whether its processes still run, and how many it follows.
export const PID_CHECK_MS = 10_000;
export const MAX_PIDS = 16;

export const FINAL = new Set(['met', 'failed', 'exited', 'timeout', 'stopped', 'failing', 'lost']);

export class WatchError extends Error {}

const UNITS = { s: 1000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/** 90, "90", "90s", "5m", "1h30m", "2d" → milliseconds (a bare number is seconds); undefined when it does not read. */
export function parseDuration(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text * 1000 : undefined;
  if (typeof text !== 'string') return undefined;
  const value = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(value)) return undefined;
  let total = 0;
  for (const [, number, , unit] of value.matchAll(/(\d+(\.\d+)?)([smhd])/g)) total += Number(number) * UNITS[unit];
  return total > 0 ? total : undefined;
}

/** 90000 → "1m30s", for people. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(ms ?? 0))}ms`;
  let rest = Math.round(ms / 1000);
  const parts = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.slice(0, 2).join('');
}

/**
 * The condition: `exit` (the command's exit status: 0 met, 1 not yet, else an
 * error), `match:REGEX` (its output matches; a failed run is an error),
 * `change` (its output differs from the first run's) or `exited` (none: only
 * the end of the processes it follows, --pid, ends it).
 */
export function parseUntil(text = 'exit') {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '' || value === 'exit') return { kind: 'exit' };
  if (value === 'change') return { kind: 'change' };
  if (value === 'exited') return { kind: 'exited' };
  if (value.startsWith('match:')) {
    const pattern = value.slice('match:'.length);
    if (!pattern) throw new WatchError('match: needs a pattern, e.g. --until "match:MERGED|CLOSED"');
    try {
      new RegExp(pattern, 'm');
    } catch (error) {
      throw new WatchError(`The pattern does not read: ${error.message}`);
    }
    return { kind: 'match', pattern };
  }
  throw new WatchError(`Unknown condition "${value}": use exit, match:REGEX, change or exited`);
}

export const untilText = (until) => (until.kind === 'match' ? `match:${until.pattern}` : until.kind);

/** `--fail`: `match:REGEX`, a run whose output matches it means what is watched failed. */
export function parseFail(text) {
  if (text === undefined || text === null || text === '') return undefined;
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value.startsWith('match:')) throw new WatchError(`--fail takes match:REGEX, e.g. --fail "match:Error in rule|Traceback", not "${value}"`);
  return parseUntil(value);
}

/**
 * A run's verdict: `met`, `failed` (its output matches `fail`, whatever its
 * exit status: what is watched failed), `waiting` (not yet) or `error` (the
 * command itself failed). `baseline` is the first run's output, for `change`.
 */
export function verdictOf(until, { exitCode, output = '', timedOut = false }, baseline, fail) {
  if (timedOut) return 'error';
  if (fail && new RegExp(fail.pattern, 'm').test(output)) return 'failed';
  switch (until.kind) {
    case 'exit':
      return exitCode === 0 ? 'met' : exitCode === 1 ? 'waiting' : 'error';
    case 'match':
      if (exitCode !== 0) return 'error';
      return new RegExp(until.pattern, 'm').test(output) ? 'met' : 'waiting';
    case 'change':
      if (exitCode !== 0) return 'error';
      return baseline !== undefined && output !== baseline ? 'met' : 'waiting';
    case 'exited':
      return exitCode === 0 ? 'waiting' : 'error';
    default:
      return 'error';
  }
}

/** `--pid`'s values (repeated, or with commas) → process ids. */
export function parsePids(value) {
  if (value === undefined || value === null || value === '') return [];
  const words = (Array.isArray(value) ? value : [value]).flatMap((each) => String(each).split(/[\s,]+/)).filter(Boolean);
  const pids = words.map((word) => {
    if (!/^\d+$/.test(word) || Number(word) < 2) throw new WatchError(`--pid takes a process id (from $! or pgrep), not "${word}"`);
    return Number(word);
  });
  if (pids.length > MAX_PIDS) throw new WatchError(`--pid follows at most ${MAX_PIDS} processes`);
  return [...new Set(pids)];
}

/** A process's state and start time from /proc (Linux), to tell it from a later one with its id; undefined elsewhere. */
export function processStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // After the name in parentheses: field 3 (state) on, field 22 is the start time.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], start: fields[19] };
  } catch {
    return undefined;
  }
}

/** Whether a process runs: it takes signal 0, is no zombie, and (with /proc) is the one that ran at `start`. */
export function processAlive(pid, start) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  const stat = processStat(pid);
  if (stat && (stat.state === 'Z' || stat.state === 'X')) return false;
  return !(start !== undefined && stat && stat.start !== start);
}

/** The processes a watch follows, checked to run now: [{pid, start?}], or a WatchError. */
export function followedProcesses(pids) {
  return pids.map((pid) => {
    if (!processAlive(pid)) throw new WatchError(`No process ${pid} runs (did it end already? pgrep -af PATTERN finds its id)`);
    const start = processStat(pid)?.start;
    return start === undefined ? { pid } : { pid, start };
  });
}

export const VERDICT_TEXT = { met: 'met', failed: 'failed', waiting: 'not yet', error: 'error' };

// What a command writes to stderr when it was called wrongly (a usage error, a
// command or file that is not there, a shell that cannot read it), also when
// it exits 0, as `bash -c grep …` does when quotes went missing.
const MISUSE = /^.*(\busage:|command not found|no such file or directory|syntax error|unexpected EOF|unterminated quoted|invalid option|unrecognized option|illegal option|missing operand).*$/im;

/** The stderr line that says a run's command was called wrongly, if any: a first run with one is an error. */
export function misuseOf(stderr = '') {
  const line = MISUSE.exec(stderr);
  return line ? line[0].trim().slice(0, 200) : undefined;
}

/** A word for sh, quoted when it needs it: 'it'\''s'. */
export function shellQuote(word) {
  return /^[A-Za-z0-9_\/.,:=@%+^-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The command line to run with sh -c from the words after `--`: one word is a
 * shell command as given (pipes, `;`, quotes and all); several are one
 * command and its arguments, each quoted so it stays one argument.
 */
export function commandOf(words) {
  return words.length === 1 ? words[0] : words.map(shellQuote).join(' ');
}

/**
 * A start request, checked: { command, every, until, fail, pids, timeout, name, wait } in
 * milliseconds, or a WatchError. Durations may be given as text ("5m").
 */
export function readStart(request, { minEveryMs = MIN_EVERY_MS } = {}) {
  const command = request?.command;
  if (typeof command !== 'string' || !command.trim()) throw new WatchError('Which command? codeflower-watch start [OPTIONS] -- COMMAND');
  if (command.length > MAX_COMMAND_LENGTH) throw new WatchError('The command is too long; put it in a script');
  const every = request.every === undefined ? DEFAULT_EVERY_MS : parseDuration(request.every);
  if (!every) throw new WatchError(`--every does not read: ${request.every} (e.g. 30s, 5m, 1h)`);
  if (every < minEveryMs) throw new WatchError(`--every is at least ${formatDuration(minEveryMs)}`);
  const timeout = request.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(request.timeout);
  if (!timeout) throw new WatchError(`--timeout does not read: ${request.timeout} (e.g. 2h, 3d)`);
  if (timeout > MAX_TIMEOUT_MS) throw new WatchError(`--timeout is at most ${formatDuration(MAX_TIMEOUT_MS)}`);
  const pids = parsePids(request.pid);
  // With --pid, the processes' end is the condition unless another is given.
  const until = request.until === undefined && pids.length ? { kind: 'exited' } : parseUntil(request.until);
  if (until.kind === 'exited' && !pids.length) throw new WatchError('--until exited needs --pid: which processes?');
  const fail = parseFail(request.fail);
  const name = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 80) : defaultName(command);
  return { command, every, until, fail, pids, timeout, name, wait: readWait(request.wait) };
}

/** `--wait`'s value: true for the default, a duration, or nothing. */
export function readWait(value) {
  if (value === undefined || value === false || value === null) return undefined;
  if (value === true) return DEFAULT_WAIT_MS;
  const ms = parseDuration(value);
  if (!ms) throw new WatchError(`--wait does not read: ${value} (e.g. 90s, 9m)`);
  return Math.min(ms, MAX_WAIT_MS);
}

/** A name from the command: its first words, without paths. */
export function defaultName(command) {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((word) => !word.startsWith('-'))
    .map((word) => word.replace(/^.*\//, ''))
    .slice(0, 3);
  return words.join(' ').slice(0, 40) || 'watch';
}
