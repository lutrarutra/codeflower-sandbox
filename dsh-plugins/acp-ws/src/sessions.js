import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { addCost, addTokens } from './usage.js';

// Session directories live in the project state, so the VS Code extension can
// list, rename, and delete them without a running worker. Each file has one
// writer: the bridge owns meta.json, lease.json, and transcript.jsonl; the
// extension owns title.json.
export const LEASE_TTL_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const AUTO_TITLE_LENGTH = 80;

export class LeaseError extends Error {
  constructor(holder) {
    super('Session is open on another worker');
    this.holder = holder;
  }
}

export function sessionKey(harness, nativeSessionId) {
  const readable = /^[A-Za-z0-9._-]{1,96}$/.test(nativeSessionId);
  const suffix = readable
    ? nativeSessionId
    : createHash('sha256').update(nativeSessionId).digest('hex').slice(0, 32);
  return `${harness}-${suffix}`;
}

export async function writeJsonAtomically(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function promptTitle(prompt) {
  if (!Array.isArray(prompt)) {
    return undefined;
  }
  const text = prompt
    // Context the client adds for the agent, e.g. the user's shell commands, is not the user's words.
    .filter(
      (block) =>
        block?.type === 'text' &&
        typeof block.text === 'string' &&
        !block._meta?.['codeflower/shellContext'] &&
        !block._meta?.['codeflower/steerNote']
    )
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > AUTO_TITLE_LENGTH ? `${text.slice(0, AUTO_TITLE_LENGTH - 1)}…` : text;
}

export function leaseIsFresh(lease, now = Date.now()) {
  return Boolean(lease) && now - Date.parse(lease.heartbeatAt) < LEASE_TTL_MS;
}

export function createSessionStore({
  directory,
  instanceId,
  harness,
  authMode,
  now = () => new Date(),
  log = () => {}
}) {
  const open = new Map();
  let heartbeat;

  const paths = (nativeSessionId) => {
    const root = join(directory, sessionKey(harness, nativeSessionId));
    return {
      root,
      meta: join(root, 'meta.json'),
      lease: join(root, 'lease.json'),
      transcript: join(root, 'transcript.jsonl')
    };
  };

  // Serializes all writes for one session so transcript lines and metadata
  // updates land in order.
  const enqueue = (state, task) => {
    state.queue = state.queue.then(task).catch((error) => {
      log(`Could not record session ${state.nativeSessionId}: ${error.message}`);
    });
    return state.queue;
  };

  const writeLease = (state) =>
    writeJsonAtomically(state.paths.lease, {
      instanceId,
      heartbeatAt: now().toISOString()
    });

  const releaseLease = async (state) => {
    if (state.child) return;
    const lease = await readJson(state.paths.lease);
    if (lease?.instanceId === instanceId) {
      await unlink(state.paths.lease).catch(() => {});
    }
  };

  const startHeartbeat = () => {
    if (heartbeat) {
      return;
    }
    heartbeat = setInterval(() => {
      for (const state of open.values()) {
        // A subagent's chat is held by its parent's lease.
        if (!state.child) void enqueue(state, () => writeLease(state));
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
  };

  return {
    async foreignLease(nativeSessionId) {
      const lease = await readJson(paths(nativeSessionId).lease);
      if (lease && lease.instanceId !== instanceId && leaseIsFresh(lease, now().getTime())) {
        return lease;
      }
      return undefined;
    },

    async open(nativeSessionId, { cwd } = {}) {
      if (open.has(nativeSessionId)) {
        return;
      }
      const sessionPaths = paths(nativeSessionId);
      const holder = await this.foreignLease(nativeSessionId);
      if (holder) {
        throw new LeaseError(holder);
      }
      await mkdir(sessionPaths.root, { recursive: true, mode: 0o700 });
      const timestamp = now().toISOString();
      const existing = await readJson(sessionPaths.meta);
      const meta = existing ?? {
        version: 1,
        harness,
        authMode: authMode ?? null,
        nativeSessionId,
        cwd: cwd ?? null,
        createdAt: timestamp,
        autoTitle: null
      };
      // Opening a chat is not a change to it: only a new one gets its time here, later ones when recorded.
      meta.updatedAt ??= timestamp;
      const recorded = await readFile(sessionPaths.transcript, 'utf8').catch(() => '');
      const state = {
        nativeSessionId,
        paths: sessionPaths,
        meta,
        // The totals of earlier turns, which the worker's usage starts from.
        storedUsage: meta.usage ? structuredClone(meta.usage) : undefined,
        // Entries recorded so far, counted when recorded, not when written.
        count: recorded.split('\n').filter((line) => line.trim()).length,
        queue: Promise.resolve()
      };
      open.set(nativeSessionId, state);
      await enqueue(state, async () => {
        await writeJsonAtomically(sessionPaths.meta, meta);
        await writeLease(state);
      });
      startHeartbeat();
    },

    isOpen(nativeSessionId) {
      return open.has(nativeSessionId);
    },

    /**
     * Records a subagent's chat beside its parent's, while the parent's is
     * open here: under the parent's lease, with `parentKey` in its meta, which
     * keeps it out of the chat lists. False when the parent is not open (a
     * load replaying it, which is not recorded again).
     */
    async openChild(nativeSessionId, parentSessionId) {
      if (open.has(nativeSessionId)) return true;
      const parent = open.get(parentSessionId);
      if (!parent) return false;
      const sessionPaths = paths(nativeSessionId);
      await mkdir(sessionPaths.root, { recursive: true, mode: 0o700 });
      const timestamp = now().toISOString();
      const meta = (await readJson(sessionPaths.meta)) ?? {
        version: 1,
        harness,
        authMode: authMode ?? null,
        nativeSessionId,
        cwd: parent.meta.cwd ?? null,
        createdAt: timestamp,
        autoTitle: null
      };
      meta.parentKey = sessionKey(harness, parentSessionId);
      meta.updatedAt ??= timestamp;
      const recorded = await readFile(sessionPaths.transcript, 'utf8').catch(() => '');
      const state = {
        nativeSessionId,
        paths: sessionPaths,
        meta,
        child: true,
        count: recorded.split('\n').filter((line) => line.trim()).length,
        queue: Promise.resolve()
      };
      open.set(nativeSessionId, state);
      await enqueue(state, () => writeJsonAtomically(sessionPaths.meta, meta));
      return true;
    },

    /** Keeps a subagent's summary in its meta, for windows that open its parent later. */
    setSubagent(nativeSessionId, summary) {
      const state = open.get(nativeSessionId);
      if (!state?.child) return Promise.resolve();
      state.meta.subagent = summary;
      state.meta.autoTitle = summary.title || summary.description || state.meta.autoTitle;
      state.meta.updatedAt = now().toISOString();
      return enqueue(state, () => writeJsonAtomically(state.paths.meta, state.meta));
    },

    record(nativeSessionId, entry) {
      const state = open.get(nativeSessionId);
      if (!state) {
        return Promise.resolve();
      }
      const timestamp = now().toISOString();
      const line = `${JSON.stringify({ t: timestamp, ...entry })}\n`;
      state.count += 1;
      return enqueue(state, async () => {
        await appendFile(state.paths.transcript, line, { mode: 0o600 });
        // The first prompt names the session until the agent names it; a
        // title the user set (title.json) wins over both.
        const agentTitle =
          entry.kind === 'update' && entry.update?.sessionUpdate === 'session_info_update' && typeof entry.update.title === 'string'
            ? entry.update.title.trim().slice(0, 200)
            : undefined;
        const title = agentTitle || (entry.kind === 'prompt' && !state.meta.autoTitle ? promptTitle(entry.prompt) : undefined);
        if (title || entry.kind === 'prompt' || entry.kind === 'turn_end') {
          if (title) {
            state.meta.autoTitle = title;
          }
          if (entry.kind === 'turn_end' && (entry.usage || entry.cost)) {
            const cost = addCost(state.meta.usage?.cost, entry.cost);
            state.meta.usage = { tokens: addTokens(state.meta.usage?.tokens, entry.usage), ...(cost ? { cost } : {}) };
          }
          state.meta.updatedAt = timestamp;
          await writeJsonAtomically(state.paths.meta, state.meta);
        }
      });
    },

    /** The token counts and cost of the session's turns before it was opened here. */
    storedUsage(nativeSessionId) {
      return open.get(nativeSessionId)?.storedUsage;
    },

    /** How many entries the session's transcript has, including those still being written. */
    entryCount(nativeSessionId) {
      return open.get(nativeSessionId)?.count ?? 0;
    },

    /** Waits until everything recorded so far is written. */
    async flush() {
      await Promise.all([...open.values()].map((state) => state.queue));
    },

    /** Releases one session, e.g. to delete it. */
    async close(nativeSessionId) {
      const state = open.get(nativeSessionId);
      if (!state) return;
      open.delete(nativeSessionId);
      await enqueue(state, () => releaseLease(state));
    },

    async closeAll() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      const states = [...open.values()];
      open.clear();
      await Promise.all(states.map((state) => enqueue(state, () => releaseLease(state))));
    }
  };
}

// ---- Session management for the extension, served over the bridge ----

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function sessionDirectory(directory, key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key === '.' || key === '..') {
    throw new Error('Invalid session key');
  }
  return join(directory, key);
}

export async function listSessions(directory, now = Date.now()) {
  let keys;
  try {
    keys = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const key of keys) {
    if (!KEY_PATTERN.test(key) || key.startsWith('.')) continue;
    const root = join(directory, key);
    const meta = await readJson(join(root, 'meta.json')).catch(() => undefined);
    if (!meta || typeof meta.harness !== 'string' || typeof meta.nativeSessionId !== 'string') continue;
    // Subagents' chats belong to their parent's (listSubagents).
    if (typeof meta.parentKey === 'string') continue;
    const title = await readJson(join(root, 'title.json')).catch(() => undefined);
    const lease = await readJson(join(root, 'lease.json')).catch(() => undefined);
    sessions.push({
      key,
      harness: meta.harness,
      authMode: meta.authMode ?? null,
      nativeSessionId: meta.nativeSessionId,
      cwd: meta.cwd ?? null,
      title: (typeof title?.title === 'string' && title.title) || meta.autoTitle || 'Untitled session',
      createdAt: meta.createdAt ?? '',
      updatedAt: meta.updatedAt ?? meta.createdAt ?? '',
      usage: meta.usage ?? null,
      ...(leaseIsFresh(lease, now) ? { openOn: lease.instanceId } : {})
    });
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// The recorded subagents' chats, by their parent's key.
async function childKeys(directory) {
  let keys;
  try {
    keys = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const byParent = new Map();
  for (const key of keys) {
    if (!KEY_PATTERN.test(key) || key.startsWith('.')) continue;
    const meta = await readJson(join(directory, key, 'meta.json')).catch(() => undefined);
    if (typeof meta?.parentKey !== 'string') continue;
    if (!byParent.has(meta.parentKey)) byParent.set(meta.parentKey, []);
    byParent.get(meta.parentKey).push({ key, meta });
  }
  return byParent;
}

/** The subagents recorded for a chat: their keys, native ids and last summaries. */
export async function listSubagents(directory, parentKey) {
  sessionDirectory(directory, parentKey);
  const children = (await childKeys(directory)).get(parentKey) ?? [];
  return children
    .map(({ key, meta }) => ({ key, nativeSessionId: meta.nativeSessionId, parentKey, summary: meta.subagent ?? null, createdAt: meta.createdAt ?? '' }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The parent's key of a recorded subagent's chat, or undefined for a chat of its own. */
export async function parentKeyOf(directory, key) {
  const meta = await readJson(join(sessionDirectory(directory, key), 'meta.json')).catch(() => undefined);
  return typeof meta?.parentKey === 'string' ? meta.parentKey : undefined;
}

export async function readTranscript(directory, key) {
  let text;
  try {
    text = await readFile(join(sessionDirectory(directory, key), 'transcript.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn last line from a writer that is still appending.
    }
  }
  return entries;
}

// A page of a transcript: about TRANSCRIPT_PAGE_BYTES of entries by default,
// at most TRANSCRIPT_PAGE_LIMIT, well under the 16 MiB a client takes in one
// message, so long chats open quickly and load earlier turns as needed.
export const TRANSCRIPT_PAGE_BYTES = 1 << 20;
const TRANSCRIPT_PAGE_SMALLEST = 64 << 10;
const TRANSCRIPT_PAGE_LIMIT = 8 << 20;
const ENTRY_KIND = /^\{"t":"[^"]*","kind":"([a-z_]+)"/;
const COMMANDS_UPDATE = '"sessionUpdate":"available_commands_update"';

const parsedLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/**
 * The entries before `before` (all of them by default) that fit in `maxBytes`,
 * from the start of a turn when that fits in the limit, so a page does not
 * open in the middle of an answer. `start` is the index of its first entry;
 * `context` holds the agent's latest slash commands from before the page,
 * which the client needs and the page may not have.
 */
export async function readTranscriptPage(directory, key, { before, maxBytes } = {}) {
  let text;
  try {
    text = await readFile(join(sessionDirectory(directory, key), 'transcript.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], start: 0, total: 0 };
    throw error;
  }
  const lines = text.split('\n');
  if (!lines.at(-1)) lines.pop();
  // A torn last line from a writer that is still appending is not an entry yet.
  if (lines.length && parsedLine(lines.at(-1)) === undefined) lines.pop();
  const total = lines.length;
  const end = Number.isSafeInteger(before) ? Math.min(Math.max(before, 0), total) : total;
  const budget = Math.min(
    Math.max(Number.isSafeInteger(maxBytes) ? maxBytes : TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_SMALLEST),
    TRANSCRIPT_PAGE_LIMIT
  );
  const size = (index) => Buffer.byteLength(lines[index]) + 1;
  let start = end;
  let bytes = 0;
  while (start > 0 && (start === end || bytes + size(start - 1) <= budget)) bytes += size(--start);
  const isPrompt = (index) => ENTRY_KIND.exec(lines[index])?.[1] === 'prompt';
  let turn = start;
  while (turn > 0 && turn < end && !isPrompt(turn) && bytes + size(turn - 1) <= TRANSCRIPT_PAGE_LIMIT) bytes += size(--turn);
  if (turn < end && isPrompt(turn)) start = turn;

  const page = lines.slice(start, end);
  const entries = page.map(parsedLine).filter((entry) => entry !== undefined);
  const result = { entries, start, total };
  if (start > 0 && !page.some((line) => line.includes(COMMANDS_UPDATE))) {
    for (let index = start - 1; index >= 0; index--) {
      if (!lines[index].includes(COMMANDS_UPDATE)) continue;
      const entry = parsedLine(lines[index]);
      if (entry) result.context = [entry];
      break;
    }
  }
  return result;
}

export async function renameSession(directory, key, title) {
  const root = sessionDirectory(directory, key);
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) throw new Error('A session title cannot be empty');
  if (!(await readJson(join(root, 'meta.json')))) throw new Error('Session not found');
  await writeJsonAtomically(join(root, 'title.json'), { title: trimmed.slice(0, 200) });
}

/**
 * Deletes code flower's record of a session. The harness's own session files
 * are left alone; their formats are internal.
 */
export async function deleteSession(directory, key, now = Date.now()) {
  const root = sessionDirectory(directory, key);
  const lease = await readJson(join(root, 'lease.json')).catch(() => undefined);
  if (leaseIsFresh(lease, now)) {
    throw new Error('The session is open on a worker; close it there first');
  }
  await rm(root, { recursive: true, force: true });
  // Its subagents' chats, and theirs.
  const byParent = await childKeys(directory);
  const remove = async (parentKey) => {
    for (const child of byParent.get(parentKey) ?? []) {
      await rm(join(directory, child.key), { recursive: true, force: true });
      await remove(child.key);
    }
  };
  await remove(key);
}
