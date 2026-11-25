// The bridge's side of Roots (roots-store.js): watches the workspace's roots/
// folder and sends the map to windows when it changes, applies the user's
// changes and comments, and tells the chat working on an idea when the user
// comments on it.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { change, readAll, RootsError, STATUSES } from './roots-store.js';

const WATCH_MS = 2000;
// Comments within this time go to the chat in one message.
const NOTICE_DELAY_MS = 5000;
const MAX_COMMENT = 4000;

export class RootsRequestError extends Error {}

/** The prompt that tells a chat of the user's comments on an idea. */
export function commentNotice(idea, comments) {
  const quoted = comments.map((comment) => comment.text.replace(/^/gm, '> ')).join('\n\n');
  return (
    `The user commented on idea ${idea.id} (${idea.title}) in Roots, the project's map of ideas:\n\n${quoted}\n\n` +
    `Read it with \`codeflower-roots show ${idea.id}\`, act on it, and answer on the idea with ` +
    `\`codeflower-roots comment ${idea.id} "…"\` (what you did, or why not).`
  );
}

/**
 * - dir: the roots folder.
 * - changed({ideas, errors}): sends the map to the windows.
 * - tell(chat, text, title, summary): a notice for the chat's next prompt.
 * - keyOf(agent, sessionId): a chat's key (sessions.js), for the windows.
 */
export function createRoots({ dir, changed = () => {}, tell = () => false, keyOf = () => undefined, log = () => {}, watchMs = WATCH_MS, noticeDelayMs = NOTICE_DELAY_MS, lockWaitMs = 15_000 }) {
  let snapshot = { ideas: [], errors: [] };
  let signature;
  let timer;
  let closed = false;
  let refreshing;
  const notices = new Map();

  // Adds each chat's key, which the windows know chats by.
  const withKeys = (idea) => ({
    ...idea,
    chats: idea.chats.map((chat) => {
      const key = chat.agent && chat.sessionId ? keyOf(chat.agent, chat.sessionId) : undefined;
      const parentKey = chat.agent && chat.parent ? keyOf(chat.agent, chat.parent) : undefined;
      return { ...chat, ...(key ? { key } : {}), ...(parentKey ? { parentKey } : {}) };
    })
  });

  // The folder's names, sizes and times: reads the files again only when they changed.
  const fingerprint = async () => {
    let names;
    try {
      names = (await readdir(dir)).filter((name) => /^\d+-.*\.md$/.test(name)).sort();
    } catch {
      return '';
    }
    const parts = [];
    for (const name of names) {
      try {
        const info = await stat(join(dir, name));
        parts.push(`${name}:${info.size}:${info.mtimeMs}`);
      } catch {}
    }
    return parts.join('|');
  };

  const refresh = () => {
    refreshing ??= (async () => {
      try {
        const now = await fingerprint();
        if (now === signature) return;
        signature = now;
        const read = readAll(dir);
        snapshot = { ideas: read.ideas.map(withKeys), errors: read.errors };
        if (!closed) changed(snapshot);
      } catch (error) {
        log(`Could not read roots: ${error.message}`);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, watchMs);
    timer.unref?.();
  };
  void refresh().then(schedule);

  const ideaId = (params) => {
    const id = Number(params?.id);
    if (!Number.isInteger(id) || id < 1) throw new RootsRequestError('Name the idea (id)');
    return id;
  };

  // The store's refusals are the request's fault.
  const apply = async (id, mutate) => {
    try {
      // Waits for another writer here, not in the store, which would block
      // the bridge's thread.
      const start = Date.now();
      let idea;
      for (;;) {
        try {
          idea = change(dir, id, mutate, { lockWaitMs: 0 });
          break;
        } catch (error) {
          if (!(error instanceof RootsError) || error.code !== 'busy' || Date.now() - start > lockWaitMs) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
        }
      }
      // A refresh already running took its fingerprint before the write.
      await refreshing;
      await refresh();
      return withKeys(idea);
    } catch (error) {
      if (error instanceof RootsError) throw new RootsRequestError(error.message);
      throw error;
    }
  };

  // The chat to tell: the latest of the idea's chats that a worker knows.
  const noticeFor = (idea, comment) => {
    const chat = [...idea.chats].reverse().find((entry) => entry.agent && entry.sessionId);
    if (!chat) return undefined;
    const key = `${chat.agent}\u0000${chat.sessionId}\u0000${idea.id}`;
    let entry = notices.get(key);
    if (!entry) {
      entry = { chat: { agent: chat.agent, sessionId: chat.sessionId }, idea, comments: [] };
      entry.timer = setTimeout(() => {
        notices.delete(key);
        if (closed) return;
        const count = entry.comments.length;
        const summary = `${count === 1 ? 'A comment' : `${count} comments`} on #${entry.idea.id} ${entry.idea.title}`;
        if (!tell(entry.chat, commentNotice(entry.idea, entry.comments), 'Comment on an idea', summary)) {
          log(`Could not tell ${entry.chat.agent} chat ${entry.chat.sessionId} of a comment on idea ${entry.idea.id}`);
        }
      }, noticeDelayMs);
      entry.timer.unref?.();
      notices.set(key, entry);
    }
    entry.comments.push(comment);
    return keyOf(chat.agent, chat.sessionId);
  };

  return {
    snapshot: () => snapshot,
    refresh,

    /**
     * The user's change to an idea: {title?, status?, from?, todo?: {index, done},
     * need?: {index, met}}. Items by their index in the lists, from 0.
     */
    async update(params) {
      const id = ideaId(params);
      const patch = params?.patch;
      if (!patch || typeof patch !== 'object') throw new RootsRequestError('Say what to change (patch)');
      return apply(id, (idea) => {
        if (patch.title !== undefined) {
          if (typeof patch.title !== 'string' || !patch.title.trim()) throw new RootsRequestError('The title cannot be empty');
          idea.title = patch.title.trim();
        }
        if (patch.status !== undefined) {
          if (!STATUSES.includes(patch.status)) throw new RootsRequestError(`The status is one of ${STATUSES.join(', ')}`);
          idea.status = patch.status;
        }
        if (patch.from !== undefined) {
          if (!Array.isArray(patch.from) || !patch.from.every(Number.isInteger)) throw new RootsRequestError('from lists idea ids');
          idea.from = patch.from;
        }
        const item = (list, what, value) => {
          const index = value?.index;
          if (!Number.isInteger(index) || !idea[list][index]) throw new RootsRequestError(`There is no such ${what}`);
          return idea[list][index];
        };
        if (patch.todo !== undefined) item('todos', 'todo', patch.todo).done = patch.todo.done === true;
        if (patch.need !== undefined) {
          const need = item('needs', 'need', patch.need);
          if (need.idea !== undefined) throw new RootsRequestError(`That need is idea ${need.idea}: it is met when that idea is done`);
          need.met = patch.need.met === true;
        }
      });
    },

    /** The user's comment on an idea; the chat working on it is told. Answers the chat's key, if one is told. */
    async comment(params) {
      const id = ideaId(params);
      const text = typeof params?.text === 'string' ? params.text.trim() : '';
      if (!text) throw new RootsRequestError('The comment is empty');
      if (text.length > MAX_COMMENT) throw new RootsRequestError(`A comment is at most ${MAX_COMMENT} characters`);
      const comment = { by: 'user', text, at: new Date().toISOString() };
      const idea = await apply(id, (idea) => {
        idea.comments.push(comment);
      });
      const told = noticeFor(idea, comment);
      return { idea, ...(told ? { told } : {}) };
    },

    close() {
      closed = true;
      clearTimeout(timer);
      for (const entry of notices.values()) clearTimeout(entry.timer);
      notices.clear();
    }
  };
}
