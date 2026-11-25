// The rules of a watch (codeflower-watch): how its durations and condition
// read, and what a run's outcome means. The bridge (watches.js) and the
// command (bin/codeflower-watch, which runs a watch itself where there is no
// bridge) both use them, so both decide alike.

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

export const FINAL = new Set(['met', 'timeout', 'stopped', 'failing', 'lost']);

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
 * error), `match:REGEX` (its output matches; a failed run is an error) or
 * `change` (its output differs from the first run's).
 */
export function parseUntil(text = 'exit') {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '' || value === 'exit') return { kind: 'exit' };
  if (value === 'change') return { kind: 'change' };
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
  throw new WatchError(`Unknown condition "${value}": use exit, match:REGEX or change`);
}

export const untilText = (until) => (until.kind === 'match' ? `match:${until.pattern}` : until.kind);

/**
 * A run's verdict: `met`, `waiting` (not yet) or `error`. `baseline` is the
 * first run's output, for `change`.
 */
export function verdictOf(until, { exitCode, output = '', timedOut = false }, baseline) {
  if (timedOut) return 'error';
  switch (until.kind) {
    case 'exit':
      return exitCode === 0 ? 'met' : exitCode === 1 ? 'waiting' : 'error';
    case 'match':
      if (exitCode !== 0) return 'error';
      return new RegExp(until.pattern, 'm').test(output) ? 'met' : 'waiting';
    case 'change':
      if (exitCode !== 0) return 'error';
      return baseline !== undefined && output !== baseline ? 'met' : 'waiting';
    default:
      return 'error';
  }
}

export const VERDICT_TEXT = { met: 'met', waiting: 'not yet', error: 'error' };

/**
 * A start request, checked: { command, every, until, timeout, name, wait } in
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
  const until = parseUntil(request.until);
  const name = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 80) : defaultName(command);
  return { command, every, until, timeout, name, wait: readWait(request.wait) };
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
