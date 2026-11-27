// The page's search (Ctrl+K): files by name, fuzzily; what files and chats say.
//
// File names: `rg --files` lists the workspace and the mounts (honouring
// .gitignore, hidden files left out), kept for a few seconds so each key the
// user types does not list them again; the bridge ranks them and sends the
// best, which the page ranks again with its own copy of `fuzzyScore`.
//
// File contents: ripgrep, a fixed string, in the workspace and the mounts but
// the inputs, whose data can be large; a newer search from the same window
// stops the one before.
//
// Chats: a transcript records the agent's reply in many small chunks, one per
// line, so ripgrep on the file would miss words that cross two. Instead each
// transcript's prompts and replies are read into memory once, then only what
// was appended since, and searched there.
import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { InvalidRequest } from './agents.js';

const LIST_TTL_MS = 10_000;
const MAX_PATHS = 200_000;
const MAX_QUERY = 200;
const CONTENT_TIMEOUT_MS = 8_000;
const MAX_FILE_BYTES = '2M';
const MAX_LINE = 240;
const SNIPPET = 60;
const SHELL_CONTEXT = 'codeflower/shellContext';
const STEER_NOTE = 'codeflower/steerNote';
const ORCHESTRATOR_NOTE = 'codeflower/orchestratorNote';
const FROM = 'codeflower/from';

// ---- fuzzy matching (the page's lib/fuzzy.ts is the same) ----

const MATCH = 16;
const BOUNDARY = 8;
const SLASH = 10;
const CONSECUTIVE = 6;
const FIRST = 2;
const GAP = 1;
const MAX_TEXT = 1024;
// Below this much a letter, the letters are strewn about the text: not a match worth showing.
const WEAK = 20;

const isUpper = (c) => c >= 65 && c <= 90;
const isLower = (c) => c >= 97 && c <= 122;
const isDigit = (c) => c >= 48 && c <= 57;

function bonusAt(text, index) {
  if (index === 0) return SLASH;
  const before = text.charCodeAt(index - 1);
  const here = text.charCodeAt(index);
  if (before === 47) return SLASH; // after '/'
  if (before === 95 || before === 45 || before === 46 || before === 32) return BOUNDARY; // _ - . space
  if (isLower(before) && isUpper(here)) return BOUNDARY; // camelCase
  if (!isDigit(before) && isDigit(here)) return BOUNDARY / 2;
  return 0;
}

/**
 * How well `query` matches `text` as a subsequence, or null: matches at word
 * starts and in runs score higher, gaps cost. Case does not matter unless the
 * query has a capital. With `positions`, also where the query's letters are.
 */
export function fuzzyScore(query, text, { positions = false } = {}) {
  const needle = query.replace(/\s+/g, '');
  if (!needle) return { score: 0, positions: [] };
  const sensitive = needle !== needle.toLowerCase();
  const haystack = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const q = sensitive ? needle : needle.toLowerCase();
  const t = sensitive ? haystack : haystack.toLowerCase();
  const m = q.length;
  const n = t.length;
  // Quick check: a subsequence at all, and where the first and last letters can be.
  let first = -1;
  for (let i = 0, j = 0; j < n; j++) {
    if (t[j] === q[i]) {
      if (i === 0) first = j;
      if (++i === m) break;
    }
    if (j === n - 1) return null;
  }
  if (m > n || first < 0) return null;

  // score[i][j]: the best with q[i] at t[j]; run[i][j]: q[i] follows q[i-1] at t[j-1].
  const NONE = -1e9;
  const score = Array.from({ length: m }, () => new Float64Array(n).fill(NONE));
  const from = positions ? Array.from({ length: m }, () => new Int32Array(n).fill(-1)) : undefined;
  const run = Array.from({ length: m }, () => new Uint8Array(n));
  for (let i = 0; i < m; i++) {
    let best = NONE;
    let bestAt = -1;
    for (let j = first + i; j < n; j++) {
      if (i > 0 && j > 0) {
        // The best place for q[i-1] before j, less a point for each letter between.
        if (best !== NONE) best -= GAP;
        if (score[i - 1][j - 1] > best) {
          best = score[i - 1][j - 1];
          bestAt = j - 1;
        }
      }
      if (t[j] !== q[i]) continue;
      const bonus = bonusAt(haystack, j);
      if (i === 0) {
        score[0][j] = MATCH + bonus * FIRST - Math.min(j, 8) * 0.5;
        continue;
      }
      const after = j > 0 ? score[i - 1][j - 1] : NONE;
      const consecutive = after === NONE ? NONE : after + MATCH + Math.max(bonus, CONSECUTIVE);
      const gapped = best === NONE ? NONE : best + MATCH + bonus;
      if (consecutive === NONE && gapped === NONE) continue;
      if (consecutive >= gapped) {
        score[i][j] = consecutive;
        run[i][j] = 1;
        if (from) from[i][j] = j - 1;
      } else {
        score[i][j] = gapped;
        if (from) from[i][j] = bestAt;
      }
    }
  }
  let end = -1;
  let total = NONE;
  for (let j = 0; j < n; j++)
    if (score[m - 1][j] > total) {
      total = score[m - 1][j];
      end = j;
    }
  if (end < 0 || total < m * WEAK) return null;
  const result = { score: total, positions: [] };
  if (from) {
    const at = new Array(m);
    for (let i = m - 1, j = end; i >= 0; i--) {
      at[i] = j;
      j = from[i][j];
    }
    result.positions = at;
  }
  return result;
}

/** A path's score: as a whole, or its name alone, which counts for more. */
export function pathScore(query, path) {
  const whole = fuzzyScore(query, path);
  if (!whole) return null;
  // A file at the top of its folder is all name.
  const slash = path.lastIndexOf('/');
  const name = fuzzyScore(query, path.slice(slash + 1));
  // Shorter paths first among equals.
  return Math.max(whole.score, name ? name.score + MATCH * 2 : -Infinity) - path.length / 100;
}

// ---- ripgrep ----

/** Runs ripgrep; `onLine` gets each line of its output and returns false to stop it. */
function ripgrep(rg, args, { onLine, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(rg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stopped = false;
    let buffered = '';
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
    };
    const timer = timeoutMs ? setTimeout(stop, timeoutMs) : undefined;
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      if (stopped) return;
      buffered += data;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (onLine(line) === false) {
          stop();
          return;
        }
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ stopped });
    });
  });
}

// ---- chats ----

function promptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter(
      (block) =>
        block?.type === 'text' &&
        typeof block.text === 'string' &&
        !block._meta?.[SHELL_CONTEXT] &&
        !block._meta?.[STEER_NOTE] &&
        !block._meta?.[ORCHESTRATOR_NOTE]
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * What a chat said, read from its transcript as it grows: the user's prompts
 * and the agent's replies, each a part of its own (`role`, `text`, `entry`,
 * the index of the line it starts on).
 */
class ChatText {
  constructor() {
    this.parts = [];
    this.offset = 0;
    this.lines = 0;
    this.open = null; // the reply being appended to
  }

  add(entry, index) {
    if (entry?.kind === 'prompt') {
      this.open = null;
      const text = promptText(entry.prompt);
      // An orchestrator's message, or its executor's question (orchestrators.js): the other chat's.
      const from = entry.prompt?.some?.((block) => block?._meta?.[FROM]);
      if (text.trim()) this.parts.push({ role: from ? 'peer' : 'user', text, entry: index });
      return;
    }
    if (entry?.kind !== 'update') {
      if (entry?.kind === 'turn_end') this.open = null;
      return;
    }
    const update = entry.update;
    const kind = update?.sessionUpdate;
    if (kind !== 'agent_message_chunk' && kind !== 'user_message_chunk') {
      // Tool calls and thoughts end a reply's run of text.
      if (kind === 'tool_call' || kind === 'agent_thought_chunk') this.open = null;
      return;
    }
    const text = update.content?.type === 'text' ? update.content.text : '';
    if (typeof text !== 'string' || !text) return;
    const role = kind === 'agent_message_chunk' ? 'agent' : 'user';
    const id = update.messageId;
    if (this.open && this.open.role === role && (id === undefined || this.open.id === id)) this.open.text += text;
    else {
      this.open = { role, text, entry: index, id };
      this.parts.push(this.open);
    }
  }

  /** Reads what the transcript gained since the last read; all of it again if it was rewritten. */
  async refresh(file) {
    let info;
    try {
      info = await stat(file);
    } catch {
      return false;
    }
    // Shorter than read: written anew.
    if (info.size < this.offset) Object.assign(this, new ChatText());
    if (info.size === this.offset) return true;
    const handle = await open(file, 'r');
    try {
      const length = info.size - this.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      // Only whole lines: a writer may be appending the last.
      const end = buffer.lastIndexOf(10);
      if (end < 0) return true;
      const text = buffer.subarray(0, end + 1).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          // Not an entry: still counted, as readTranscriptPage counts lines.
        }
        if (entry) this.add(entry, this.lines);
        this.lines++;
      }
      this.offset += end + 1;
    } finally {
      await handle.close();
    }
    return true;
  }
}

/** A short piece of `text` around [start, end), on one line. */
function snippet(text, start, end) {
  const from = Math.max(0, start - SNIPPET);
  const to = Math.min(text.length, end + SNIPPET);
  const before = (from > 0 ? '…' : '') + text.slice(from, start).replace(/\s+/g, ' ').trimStart();
  const match = text.slice(start, end).replace(/\s+/g, ' ');
  const after = text.slice(end, to).replace(/\s+/g, ' ').trimEnd() + (to < text.length ? '…' : '');
  return { text: before + match + after, start: before.length, length: match.length };
}

/** A query as the user typed it, checked. */
function queryOf(params) {
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  if (query.length > MAX_QUERY) throw new InvalidRequest('The search is too long');
  return query;
}

const limitOf = (params, fallback, most) => (Number.isInteger(params?.limit) && params.limit > 0 ? Math.min(params.limit, most) : fallback);

/**
 * The search a bridge answers. `folders()` gives where files are: `{ path,
 * label, contents }`, `contents` false for folders whose files are not read
 * (the inputs). `sessions()` lists the chats as _codeflower/sessions/list does.
 */
export function createSearch({ folders, sessionsDirectory, sessions, rg = 'rg', log = () => {} }) {
  let listing; // { at, promise }
  let available = true;
  const chats = new Map(); // key → ChatText

  async function listPaths() {
    const now = Date.now();
    if (listing && now - listing.at < LIST_TTL_MS) return listing.promise;
    const promise = (async () => {
      const roots = (await folders()).filter((folder) => folder?.path);
      const paths = [];
      let truncated = false;
      for (const root of roots) {
        if (paths.length >= MAX_PATHS) break;
        try {
          await ripgrep(rg, ['--files', '--no-messages', '--no-require-git', '--', root.path], {
            onLine: (line) => {
              if (!line) return true;
              paths.push({ path: line, root });
              if (paths.length >= MAX_PATHS) {
                truncated = true;
                return false;
              }
              return true;
            }
          });
        } catch (error) {
          available = false;
          log(`Search cannot list files: ${error.message}`);
          throw Object.assign(new Error('Searching files needs ripgrep (rg) in the sandbox'), { unavailable: true });
        }
      }
      return { paths, truncated };
    })();
    listing = { at: now, promise };
    promise.catch(() => {
      if (listing?.promise === promise) listing = undefined;
    });
    return promise;
  }

  /** Files whose path matches the query, the best first. */
  async function paths(params = {}) {
    const query = queryOf(params);
    const limit = limitOf(params, 50, 200);
    const { paths: all, truncated } = await listPaths();
    if (!query) return { files: [], truncated, available };
    const scored = [];
    for (const entry of all) {
      const rest = relative(entry.root.path, entry.path) || entry.path;
      const score = pathScore(query, rest);
      if (score !== null) scored.push({ score, entry, rest });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      files: scored.slice(0, limit).map(({ entry, rest }) => ({ path: entry.path, relative: rest, folder: entry.root.label, root: entry.root.path })),
      truncated,
      available
    };
  }

  /** Lines in files that have the query, by file. `signal` stops the search. */
  async function contents(params = {}, { signal } = {}) {
    const query = queryOf(params);
    const limit = limitOf(params, 100, 500);
    if (query.length < 2) return { files: [], truncated: false };
    const roots = (await folders()).filter((folder) => folder?.path && folder.contents !== false);
    const byPath = new Map();
    let matches = 0;
    let truncated = false;
    const args = [
      '--json',
      '--fixed-strings',
      '--smart-case',
      '--no-messages',
      '--no-require-git',
      '--max-count', '5',
      '--max-filesize', MAX_FILE_BYTES,
      '--', query,
      ...roots.map((root) => root.path)
    ];
    try {
      const { stopped } = await ripgrep(rg, args, {
        signal,
        timeoutMs: CONTENT_TIMEOUT_MS,
        onLine: (line) => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return true;
          }
          if (event.type !== 'match') return true;
          const data = event.data;
          const path = data.path?.text;
          const text = data.lines?.text;
          if (typeof path !== 'string' || typeof text !== 'string') return true;
          const root = roots.find((candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`));
          let file = byPath.get(path);
          if (!file) {
            file = { path, relative: root ? relative(root.path, path) : path, folder: root?.label ?? '', root: root?.path ?? '', lines: [] };
            byPath.set(path, file);
          }
          const sub = data.submatches?.[0];
          const raw = text.replace(/\r?\n$/, '');
          // ripgrep counts bytes; a long line shows around its match.
          const bytes = Buffer.from(raw);
          const start = bytes.subarray(0, sub?.start ?? 0).toString().length;
          const end = bytes.subarray(0, sub?.end ?? 0).toString().length;
          const piece = raw.length > MAX_LINE ? snippet(raw, start, end) : { text: raw, start, length: end - start };
          file.lines.push({ line: data.line_number, ...piece });
          if (++matches >= limit) {
            truncated = true;
            return false;
          }
          return true;
        }
      });
      if (stopped && !signal?.aborted) truncated = true;
    } catch (error) {
      log(`Search cannot read files: ${error.message}`);
      throw Object.assign(new Error('Searching files needs ripgrep (rg) in the sandbox'), { unavailable: true });
    }
    return { files: [...byPath.values()], truncated };
  }

  /** Chats whose prompts or replies have the query, the latest first, with a few places each. */
  async function inChats(params = {}) {
    const query = queryOf(params);
    const limit = limitOf(params, 30, 100);
    const perChat = 3;
    if (query.length < 2 || !sessionsDirectory) return { chats: [], truncated: false };
    const listed = await sessions();
    const keys = new Set(listed.map((session) => session.key));
    // Forget chats that were deleted.
    for (const key of chats.keys()) if (!keys.has(key)) chats.delete(key);
    const sensitive = query !== query.toLowerCase();
    const needle = sensitive ? query : query.toLowerCase();
    const found = [];
    const ordered = [...listed].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const session of ordered) {
      let chat = chats.get(session.key);
      if (!chat) chats.set(session.key, (chat = new ChatText()));
      if (!(await chat.refresh(join(sessionsDirectory, session.key, 'transcript.jsonl')).catch(() => false))) continue;
      const places = [];
      let count = 0;
      for (const part of chat.parts) {
        const haystack = sensitive ? part.text : part.text.toLowerCase();
        let at = haystack.indexOf(needle);
        while (at >= 0) {
          count++;
          if (places.length < perChat) places.push({ role: part.role, entry: part.entry, ...snippet(part.text, at, at + query.length) });
          at = haystack.indexOf(needle, at + needle.length);
        }
      }
      if (count) found.push({ key: session.key, title: session.title, harness: session.harness, updatedAt: session.updatedAt, count, places });
      if (found.length > limit) break;
    }
    return { chats: found.slice(0, limit), truncated: found.length > limit };
  }

  return { paths, contents, chats: inChats, forget: (key) => chats.delete(key) };
}

/** The folders a sandbox searches: its workspace, then the mounts; the inputs only by name. */
export function searchFolders(workspace, mounts = []) {
  const label = (target) => {
    const group = /^\/data\/(input|output|code|skills)\//.exec(target)?.[1];
    const name = target.split('/').filter(Boolean).at(-1) ?? target;
    return group ? `${group === 'input' ? 'Inputs' : group === 'output' ? 'Outputs' : group === 'code' ? 'Code' : 'Skills'}/${name}` : name;
  };
  return [
    ...(workspace ? [{ path: workspace, label: 'Workspace', contents: true }] : []),
    ...mounts
      .filter((mount) => typeof mount?.target === 'string')
      .map((mount) => ({ path: mount.target, label: label(mount.target), contents: !mount.target.startsWith('/data/input/') }))
  ];
}
