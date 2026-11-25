// Roots: the project's map of analysis ideas, one file per idea in the
// workspace's roots/ folder. Shared by `codeflower-roots` (the agents) and the
// bridge (the windows), so both read and write them the same way.
//
// A file is Markdown with a front matter written as JSON (valid YAML too):
//
//   ---
//   {"id": 3, "title": "…", "status": "active", "from": [1], …}
//   ---
//   The conclusion, in Markdown.
//
// Writes take roots/.lock and go through a temporary file and a rename, so
// several chats can change ideas at once.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = ['idea', 'active', 'blocked', 'done', 'dropped'];
const FILE = /^(\d+)-[^/]*\.md$/;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

export class RootsError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export function rootsDir(env = process.env) {
  if (env.CODEFLOWER_ROOTS_DIR) return env.CODEFLOWER_ROOTS_DIR;
  const workspace = env.CODEFLOWER_WORKSPACE || '/codeflower-state/workspace';
  return join(workspace, 'roots');
}

export function slug(title) {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'idea'
  );
}

export function fileName(id, title) {
  return `${String(id).padStart(3, '0')}-${slug(title)}.md`;
}

// The fields in the order they are written.
const FIELDS = ['id', 'title', 'status', 'from', 'needs', 'todos', 'files', 'chats', 'comments', 'created', 'updated'];

export function format(idea) {
  const front = {};
  for (const field of FIELDS) if (idea[field] !== undefined) front[field] = idea[field];
  const body = (idea.conclusion ?? '').trim();
  // A field a line, and a list's items a line each, so files read and diff well.
  const value = (item) =>
    Array.isArray(item) && item.length
      ? `[\n${item.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]`
      : JSON.stringify(item);
  const fields = Object.entries(front).map(([key, item]) => `  ${JSON.stringify(key)}: ${value(item)}`);
  return `---\n{\n${fields.join(',\n')}\n}\n---\n${body ? `${body}\n` : ''}`;
}

export function parse(text) {
  if (!text.startsWith('---\n')) throw new RootsError('does not start with a --- front matter');
  const end = text.indexOf('\n---\n', 3);
  const close = end === -1 && text.endsWith('\n---') ? text.length - 4 : end;
  if (close === -1) throw new RootsError('its front matter has no closing ---');
  let front;
  try {
    front = JSON.parse(text.slice(4, close));
  } catch (error) {
    throw new RootsError(`its front matter is not JSON: ${error.message}`);
  }
  const idea = normalize(front);
  idea.conclusion = text.slice(close + 5).trim();
  return idea;
}

// Fills in missing lists, and checks the types of what is there.
export function normalize(front) {
  if (!front || typeof front !== 'object' || Array.isArray(front)) throw new RootsError('its front matter is not an object');
  const idea = { ...front };
  if (!Number.isInteger(idea.id) || idea.id < 1) throw new RootsError('id must be a positive whole number');
  if (typeof idea.title !== 'string' || !idea.title.trim()) throw new RootsError('title must be a non-empty string');
  idea.status ??= 'active';
  if (!STATUSES.includes(idea.status)) throw new RootsError(`status must be one of ${STATUSES.join(', ')}`);
  for (const list of ['from', 'needs', 'todos', 'files', 'chats', 'comments']) {
    idea[list] ??= [];
    if (!Array.isArray(idea[list])) throw new RootsError(`${list} must be a list`);
  }
  if (!idea.from.every((id) => Number.isInteger(id))) throw new RootsError('from must list idea ids');
  for (const need of idea.needs) {
    const ok = need && typeof need === 'object' && (Number.isInteger(need.idea) || typeof need.text === 'string');
    if (!ok) throw new RootsError('each need is {"idea": ID}, {"text": "…", "met": false} or a watch\'s {"watch": "w-…", "text": "…", "met": false}');
    if (need.watch !== undefined && (typeof need.watch !== 'string' || !/^w-[0-9a-f]{8}$/.test(need.watch) || typeof need.text !== 'string')) {
      throw new RootsError('a watch\'s need is {"watch": "w-…", "text": "…", "met": false}');
    }
  }
  for (const todo of idea.todos) {
    if (!todo || typeof todo.text !== 'string') throw new RootsError('each todo is {"text": "…", "done": false}');
    todo.done = Boolean(todo.done);
  }
  if (!idea.files.every((file) => typeof file === 'string')) throw new RootsError('files must list paths');
  for (const comment of idea.comments) {
    if (!comment || typeof comment.text !== 'string') throw new RootsError('each comment is {"by": "user"|"agent", "text": "…", "at": "…"}');
  }
  return idea;
}

// Every idea, by id, and the files that could not be read.
export function readAll(dir) {
  const ideas = [];
  const errors = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of names.sort()) {
    if (!FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      const idea = parse(readFileSync(path, 'utf8'));
      if (String(idea.id) !== String(Number(FILE.exec(name)[1]))) throw new RootsError(`its id ${idea.id} does not match its file name`);
      idea.file = name;
      ideas.push(idea);
    } catch (error) {
      errors.push({ file: name, error: error.message });
    }
  }
  ideas.sort((a, b) => a.id - b.id);
  return { ideas, errors };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Runs fn with roots/.lock held. A lock older than 10 s is someone's crash.
// waitMs is how long to wait for another writer (0: fail at once with 'busy',
// for the bridge, which must not block its thread and retries itself).
export function withLock(dir, fn, waitMs = LOCK_WAIT_MS) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() - start >= waitMs) throw new RootsError(`${lock} is held by another writer`, 'busy');
      sleep(25 + Math.random() * 50);
    }
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function write(dir, idea) {
  const { file, ...rest } = idea;
  const name = file ?? fileName(idea.id, idea.title);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, format(rest));
  renameSync(temp, join(dir, name));
  return { ...rest, file: name };
}

// Checks an idea against the others: what it builds on and needs exists, and
// nothing builds on itself through others.
export function check(idea, ideas) {
  const byId = new Map(ideas.map((other) => [other.id, other]));
  byId.set(idea.id, idea);
  for (const id of idea.from) {
    if (id === idea.id) throw new RootsError(`idea ${idea.id} cannot build on itself`);
    if (!byId.has(id)) throw new RootsError(`there is no idea ${id}`, 'unknown');
  }
  for (const need of idea.needs) {
    if (need.idea === undefined) continue;
    if (need.idea === idea.id) throw new RootsError(`idea ${idea.id} cannot need itself`);
    if (!byId.has(need.idea)) throw new RootsError(`there is no idea ${need.idea}`, 'unknown');
  }
  const seen = new Set();
  const walk = (id, path) => {
    if (path.includes(id)) throw new RootsError(`ideas would build on each other in a circle: ${[...path, id].join(' → ')}`);
    if (seen.has(id)) return;
    seen.add(id);
    for (const parent of byId.get(id)?.from ?? []) walk(parent, [...path, id]);
  };
  walk(idea.id, []);
}

// Adds the chat that made a change to the idea's chats (the latest last); a
// subagent with its parent chat's session id (`parent`).
export function touchChat(idea, chat, at) {
  if (!chat?.agent && !chat?.sessionId) return;
  const same = (entry) => entry.agent === chat.agent && (entry.sessionId ?? null) === (chat.sessionId ?? null);
  const kept = idea.chats.filter((entry) => !same(entry));
  idea.chats = [
    ...kept,
    { ...(chat.agent ? { agent: chat.agent } : {}), ...(chat.sessionId ? { sessionId: chat.sessionId } : {}), ...(chat.parent ? { parent: chat.parent } : {}), at }
  ];
}

export function create(dir, fields, { chat, now = new Date() } = {}) {
  return withLock(dir, () => {
    const { ideas } = readAll(dir);
    const used = ideas.map((idea) => idea.id);
    // Files that do not parse still hold their number.
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const match = FILE.exec(name);
      if (match) used.push(Number(match[1]));
    }
    const at = now.toISOString();
    const idea = normalize({ ...fields, id: Math.max(0, ...used) + 1, created: at, updated: at });
    check(idea, ideas);
    touchChat(idea, chat, at);
    return write(dir, idea);
  });
}

// Changes one idea with mutate(idea, ideas), which edits it in place.
export function change(dir, id, mutate, { chat, now = new Date(), lockWaitMs } = {}) {
  return withLock(dir, () => {
    const { ideas, errors } = readAll(dir);
    const idea = ideas.find((other) => other.id === id);
    if (!idea) {
      const broken = errors.find((error) => Number(FILE.exec(error.file)?.[1]) === id);
      if (broken) throw new RootsError(`roots/${broken.file} cannot be read: ${broken.error}`);
      throw new RootsError(`there is no idea ${id}`, 'unknown');
    }
    mutate(idea, ideas);
    const at = now.toISOString();
    const checked = normalize({ ...idea, updated: at });
    checked.file = idea.file;
    checked.conclusion = idea.conclusion;
    check(checked, ideas.filter((other) => other.id !== id));
    touchChat(checked, chat, at);
    return write(dir, checked);
  }, lockWaitMs);
}

export function needMet(need, byId) {
  if (need.idea !== undefined) return byId.get(need.idea)?.status === 'done';
  return Boolean(need.met);
}

// ---- watches (codeflower-watch) as needs ----
//
// A watch an idea waits for is one of its needs: {"watch": "w-…", "text": its
// name, "met": false, "log": its output}. The bridge adds it when the agent
// starts the watch for the idea (blocking the idea if it was active), marks it
// met when the watch's condition holds (and the idea active again once nothing
// else blocks it), and otherwise records how the watch ended (`ended`).

/** Adds a watch to an idea's needs; an active idea becomes blocked. */
export function addWatchNeed(dir, id, watch, { chat, now, lockWaitMs } = {}) {
  return change(
    dir,
    id,
    (idea) => {
      // A watch re-armed waits again in the same place.
      const need = { watch: watch.id, text: watch.name, met: false, ...(watch.log ? { log: watch.log } : {}) };
      const index = idea.needs.findIndex((other) => other.watch === watch.id);
      if (index >= 0) idea.needs[index] = need;
      else idea.needs.push(need);
      if (idea.status === 'active') idea.status = 'blocked';
    },
    { chat, now, lockWaitMs }
  );
}

/**
 * A watch ended (its `state`): the ideas that need it, each changed. Met: the need is met, and a
 * blocked idea whose needs are all met is active again. Otherwise the need stays open, with how the
 * watch ended. Answers [{id, title, unblocked, state}] for the chat's notice.
 */
export function endWatchNeeds(dir, watchId, state, { now, lockWaitMs } = {}) {
  const { ideas } = readAll(dir);
  const results = [];
  for (const waiting of ideas.filter((idea) => idea.needs.some((need) => need.watch === watchId))) {
    let unblocked = false;
    const idea = change(
      dir,
      waiting.id,
      (idea, all) => {
        const byId = new Map(all.map((other) => [other.id, other]));
        for (const need of idea.needs) {
          if (need.watch !== watchId) continue;
          if (state === 'met') {
            need.met = true;
            delete need.ended;
          } else need.ended = state;
        }
        if (state === 'met' && idea.status === 'blocked' && idea.needs.every((need) => needMet(need, byId))) {
          idea.status = 'active';
          unblocked = true;
        }
      },
      { now, lockWaitMs }
    );
    results.push({ id: idea.id, title: idea.title, status: idea.status, unblocked });
  }
  return results;
}
