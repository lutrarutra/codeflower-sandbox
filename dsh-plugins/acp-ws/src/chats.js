// Chats that come from other chats, and chats that agents read (docs/architecture.md, "Chats").
//
// A fork copies a chat up to one of the user's messages (or all of it). The
// agent forks it natively where it can (`session/fork`): all of it, or before
// a message at the session cursor the agent announced there (`cursor_update`;
// Claude's adapter announces them only over ACP v2, which the bridge does not
// speak yet). Elsewhere the fork is a new chat that gets the earlier one's history,
// condensed, with its first message (FORK_CONTEXT_META, which windows hide).
// Either way the fork's record starts with the other's entries, so windows
// show its history.
//
// Agents reach this with codeflower-chat on the chats socket: list and read any
// chat of the project (read-only, condensed and redacted as audits are), and
// fork or start chats, which the user allows in the calling chat each time.
import { randomUUID } from 'node:crypto';
import { auditTranscript } from './audit.js';
import { InvalidRequest } from './agents/support.js';
import { listSessions, listSubagents, readSessionMeta, readTranscript } from './sessions.js';

export const FORK_CONTEXT_META = 'codeflower/forkContext';
const NOTICE_META = 'codeflower/notice';
const ACTION_META = 'codeflower/action';
// An orchestrator's message, or its executor's question (orchestrators.js), and the note before it.
const FROM_META = 'codeflower/from';
const ORCHESTRATOR_NOTE_META = 'codeflower/orchestratorNote';

// What `read` returns at most, and the seed of a fork without a native one.
const READ_RECORDS = 50;
const MAX_READ_CHARS = 200_000;
const MAX_SEED_CHARS = 60_000;
// Under the socket's 64 KiB a request may have (files.js).
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TITLE_CHARS = 200;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A prompt the user typed: not a notice or an action of the bridge's, nor another chat's message. */
export function userPrompt(entry) {
  if (entry?.kind !== 'prompt' || !Array.isArray(entry.prompt)) return false;
  return !entry.prompt.some((block) => block?._meta?.[NOTICE_META] || block?._meta?.[ACTION_META] || block?._meta?.[FROM_META]);
}

/** The transcript index of the user's message `number` (from 1), or undefined. */
export function promptIndex(entries, number) {
  let seen = 0;
  for (let index = 0; index < entries.length; index++) {
    if (userPrompt(entries[index]) && ++seen === number) return index;
  }
  return undefined;
}

/**
 * The cursor a native fork before the prompt at `index` takes: the agent's
 * `cursor_update` with `fork` after that prompt and before the next one, which
 * Claude's adapter sends for each message it stores.
 */
export function forkCursor(entries, index) {
  for (let at = index + 1; at < entries.length; at++) {
    const entry = entries[at];
    if (entry?.kind === 'prompt') return undefined;
    const update = entry?.kind === 'update' ? entry.update : undefined;
    if (
      update?.sessionUpdate === 'cursor_update' &&
      typeof update.cursorId === 'string' &&
      update.capabilities?.fork &&
      (update.anchor?.type ?? 'user_message') === 'user_message' &&
      (update.anchor?.position ?? 'before') === 'before'
    ) {
      return update.cursorId;
    }
  }
  return undefined;
}

/** The text of a prompt, without what the bridge added for the agent only. */
export function promptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((block) => !block?._meta?.[FORK_CONTEXT_META] && !block?._meta?.[ORCHESTRATOR_NOTE_META])
    .map((block) => (block?.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** Numbers the user's records (`n`, as `fork --before` takes them) and every record (`i`). */
function numbered(records) {
  let users = 0;
  return records.map((record, index) => ({ i: index + 1, ...(record.role === 'user' ? { n: ++users } : {}), ...record }));
}

/** A chat's records as text: one block each, for the agent to read. */
export function recordsText(records) {
  return records
    .map((record) => {
      switch (record.role) {
        case 'user':
          return `[${record.i}] User (message ${record.n}):\n${record.text}`;
        case 'peer':
          return `[${record.i}] ${record.from === 'executor' ? 'Executor' : 'Orchestrator'}${record.title ? ` (${record.title})` : ''}:\n${record.text}`;
        case 'sent':
          return `[${record.i}] Sent to the orchestrator${record.withheld ? ': withheld by the user' : `:\n${record.text}`}`;
        case 'agent':
          return `[${record.i}] Agent:\n${record.text}`;
        case 'tool':
          return `[${record.i}] Tool: ${record.title}${record.status ? ` (${record.status})` : ''}`;
        case 'user-shell':
          return `[${record.i}] User ran: ${record.text}`;
        case 'show':
          return `[${record.i}] Shown: ${(record.files ?? []).join(', ')}`;
        case 'turn-end':
          return record.stopReason && record.stopReason !== 'end_turn' ? `[${record.i}] Turn ended: ${record.stopReason}` : '';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What a fork without a native one tells the agent with its first message: the
 * earlier chat's history, condensed, its latest records when it is long.
 */
export function forkSeed(entries, { key, title }) {
  const records = numbered(auditTranscript(entries));
  let kept = records;
  let text = recordsText(kept);
  while (text.length > MAX_SEED_CHARS && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    text = recordsText(kept);
  }
  const left = records.length - kept.length;
  return [
    `This chat continues the chat "${title}" (${key}), forked from it. You have not seen it: here is its history so far, condensed (the tools' input and output left out).`,
    left ? `The first ${plural(left, 'record')} are left out; read them with: codeflower-chat read ${key} --from 1` : '',
    '<earlier-chat>',
    text.slice(-MAX_SEED_CHARS),
    '</earlier-chat>',
    "Go on from there with the user's message below."
  ]
    .filter(Boolean)
    .join('\n');
}

/** The permission request that asks the user to allow an agent's new chat. */
export function chatRequest({ action, agentLabel, title, message, from }) {
  const id = randomUUID().slice(0, 8);
  const details = [
    action === 'fork' ? `Fork of: ${from.title} (${from.key})${from.before ? `, before message ${from.before}` : ''}` : '',
    `Agent: ${agentLabel}`,
    `Title: ${title}`,
    message ? `First message:\n${message.length > 2000 ? `${message.slice(0, 2000)}…` : message}` : 'No first message: the chat waits for one.'
  ]
    .filter(Boolean)
    .join('\n');
  return {
    toolCall: {
      toolCallId: `codeflower-chat-${id}`,
      title: action === 'fork' ? `Fork the chat ${from.title} as ‘${title}’` : `Start the chat ‘${title}’ with ${agentLabel}`,
      kind: 'other',
      status: 'pending',
      rawInput: { action, agent: agentLabel, title, ...(message ? { message } : {}), ...(from ? { from: from.key } : {}) },
      content: [{ type: 'content', content: { type: 'text', text: details } }]
    },
    options: [
      { optionId: 'allow', name: action === 'fork' ? 'Fork' : 'Start', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
  };
}

const cleanTitle = (title) => {
  if (title === undefined || title === null) return undefined;
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw new InvalidRequest('A title is one line of text');
  return title.trim().slice(0, MAX_TITLE_CHARS);
};

const cleanMessage = (message) => {
  if (message === undefined || message === null || message === '') return undefined;
  if (typeof message !== 'string' || !message.trim()) throw new InvalidRequest('The message is text');
  if (message.length > MAX_MESSAGE_CHARS) throw new InvalidRequest(`The message is longer than ${MAX_MESSAGE_CHARS} characters`);
  return message;
};

const positive = (value, label) => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new InvalidRequest(`${label} is a number from 1`);
  return value;
};

/**
 * The worker's chats, for windows and agents.
 * - directory: the sessions folder (sessions.js).
 * - runtimes: the agents' runtimes by name; each `startChat`s (server.js).
 * - askUser(chat, { toolCall, options }) → the answer, undefined when it cannot ask.
 * - flush(agent): waits until the agent's chats' records are written.
 * - changed(): the chat lists changed, for the windows.
 */
export function createChats({ directory, runtimes, askUser, flush = async () => {}, changed = () => {}, log = () => {} }) {
  const agentOf = (key) => [...runtimes.keys()].find((name) => typeof key === 'string' && key.startsWith(`${name}-`));

  const describe = async (key) => {
    const name = agentOf(key);
    const meta = name ? await readSessionMeta(directory, key) : undefined;
    if (!meta) throw new InvalidRequest(`No chat ${key}: list them with codeflower-chat list`);
    const listed = (await listSessions(directory)).find((session) => session.key === key);
    const title = listed?.title ?? meta.autoTitle ?? (meta.subagent?.title || 'Untitled session');
    return { key, agent: name, meta, title };
  };

  const entriesOf = async (key) => {
    const name = agentOf(key);
    if (name) await flush(name);
    return readTranscript(directory, key);
  };

  /** Every chat of the project, newest first, with its subagents' keys. */
  const list = async ({ agent } = {}) => {
    const sessions = await listSessions(directory);
    const chats = [];
    for (const session of sessions) {
      const name = agentOf(session.key) ?? session.harness;
      if (agent && name !== agent) continue;
      const subagents = await listSubagents(directory, session.key).catch(() => []);
      chats.push({
        key: session.key,
        agent: name,
        title: session.title,
        updatedAt: session.updatedAt,
        ...(session.origin ? { origin: session.origin } : {}),
        ...(subagents.length ? { subagents: subagents.map((child) => child.key) } : {})
      });
    }
    return chats;
  };

  /** A chat's records, condensed: the last READ_RECORDS by default, or from record `from`. */
  const read = async ({ key, from, last } = {}) => {
    if (typeof key !== 'string' || !key) throw new InvalidRequest('Which chat? Give its key (codeflower-chat list)');
    const chat = await describe(key);
    const records = numbered(auditTranscript(await entriesOf(key)));
    const start = from !== undefined ? positive(from, 'from') - 1 : Math.max(records.length - (positive(last, 'last') ?? READ_RECORDS), 0);
    let page = records.slice(start);
    let size = 0;
    let end = 0;
    for (; end < page.length; end++) {
      size += JSON.stringify(page[end]).length;
      if (size > MAX_READ_CHARS && end > 0) break;
    }
    page = page.slice(0, end);
    return {
      key,
      agent: chat.agent,
      title: chat.title,
      ...(chat.meta.origin ? { origin: chat.meta.origin } : {}),
      ...(chat.meta.parentKey ? { parent: chat.meta.parentKey } : {}),
      total: records.length,
      from: start + 1,
      records: page,
      text: recordsText(page)
    };
  };

  // Asks the user in the calling chat (a subagent's parent): undefined when allowed, else why not.
  const allowed = async (caller, question) => {
    if (!caller) throw new InvalidRequest("Cannot tell which chat this command runs in, so the user cannot be asked: run codeflower-chat in a chat's turn");
    const chat = { agent: caller.agent, sessionId: caller.parent ?? caller.sessionId };
    const answer = await askUser(chat, question);
    if (answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow') return undefined;
    return answer ? 'The user did not allow it.' : 'The user could not be asked (the agent is not running).';
  };

  /**
   * Forks the chat `key`: before the user's message `before` (from 1), or
   * all of it. `by`: the calling chat for an agent's fork (asked first),
   * undefined for a window's.
   */
  const fork = async ({ key, before, beforeEntry, title, message, caller } = {}) => {
    const source = await describe(key);
    const runtime = runtimes.get(source.agent);
    if (!runtime) throw new InvalidRequest(`No agent ${source.agent} on this worker`);
    if (source.meta.parentKey) throw new InvalidRequest("A subagent's chat cannot be forked: fork its parent's");
    // Its fork would be a chat of the hosted model without an orchestrator's limits.
    if (source.meta.role === 'orchestrator') throw new InvalidRequest("An orchestrator's chat cannot be forked");
    const entries = await entriesOf(key);
    let index;
    if (beforeEntry !== undefined) {
      if (!Number.isInteger(beforeEntry) || !userPrompt(entries[beforeEntry])) throw new InvalidRequest('Fork before one of your messages');
      index = beforeEntry;
    } else if (before !== undefined) {
      index = promptIndex(entries, positive(before, 'before'));
      if (index === undefined) throw new InvalidRequest(`The chat has no message ${before} of the user's: see codeflower-chat read ${key}`);
    }
    const number = index === undefined ? undefined : entries.slice(0, index + 1).filter(userPrompt).length;
    const name = cleanTitle(title) ?? `Fork of ${source.title}`.slice(0, MAX_TITLE_CHARS);
    const first = cleanMessage(message);
    if (caller) {
      const refused = await allowed(
        caller,
        chatRequest({ action: 'fork', agentLabel: runtime.agent.label ?? source.agent, title: name, message: first, from: { key, title: source.title, before: number } })
      );
      if (refused) return { ok: false, error: refused };
    }
    const prefix = index === undefined ? entries : entries.slice(0, index);
    const kind = await runtime.forkKind();
    const cursorId = index === undefined ? undefined : forkCursor(entries, index);
    // Before a message only at a cursor the agent announced; all of it, always.
    const native = kind === 'native' && (index === undefined || cursorId !== undefined);
    const started = await runtime.startChat({
      fork: native ? { sessionId: source.meta.nativeSessionId, ...(cursorId ? { cursorId } : {}) } : undefined,
      cwd: source.meta.cwd ?? undefined,
      settings: source.meta.settings,
      // Before the first message there is nothing to bring.
      seed: native || !auditTranscript(prefix).length ? undefined : forkSeed(prefix, { key, title: source.title }),
      entries: prefix,
      origin: { kind: 'fork', from: key, ...(number ? { before: number } : {}), ...(caller ? { by: caller.key } : {}), native },
      title: name,
      prompt: first
    });
    log(`${caller ? `Chat ${caller.key}` : 'A window'} forked ${key}${number ? ` before message ${number}` : ''} as ${started.key} (${native ? 'native' : 'seeded'})`);
    changed();
    return {
      ok: true,
      key: started.key,
      agent: source.agent,
      title: name,
      native,
      // The message the fork went before, for the window to offer again.
      ...(index !== undefined ? { draft: promptText(entries[index].prompt) } : {})
    };
  };

  /** A new chat of `agent` (the caller's by default), named, with its first message: the user allows it first. */
  const create = async ({ agent, title, message, caller } = {}) => {
    const name = agent || caller?.agent;
    const runtime = name ? runtimes.get(name) : undefined;
    if (!runtime) throw new InvalidRequest(`No agent ${name ?? ''} on this worker; there are: ${[...runtimes.keys()].join(', ')}`);
    const chatTitle = cleanTitle(title);
    if (!chatTitle) throw new InvalidRequest('Name the chat: --title');
    const first = cleanMessage(message);
    if (!first) throw new InvalidRequest('A new chat needs its first message');
    const refused = await allowed(caller, chatRequest({ action: 'new', agentLabel: runtime.agent.label ?? name, title: chatTitle, message: first }));
    if (refused) return { ok: false, error: refused };
    const callerMeta = caller ? await readSessionMeta(directory, caller.key).catch(() => undefined) : undefined;
    const started = await runtime.startChat({
      // The caller's settings carry over to a chat of its own agent.
      settings: name === caller.agent ? callerMeta?.settings : undefined,
      origin: { kind: 'agent', from: caller.key },
      title: chatTitle,
      prompt: first
    });
    log(`Chat ${caller.key} started ${started.key} (${name})`);
    changed();
    return { ok: true, key: started.key, agent: name, title: chatTitle };
  };

  /**
   * codeflower-chat's requests (`action`), from the chat `caller` (callingChat):
   * { agent, sessionId, key, parent? }, where `key` is the chat's (a subagent's parent's).
   */
  const handle = async (caller, request) => {
    switch (request?.action) {
      case 'list':
        return { chats: await list({ agent: request.chatAgent }) };
      case 'read':
        return read(request);
      case 'fork': {
        const key = request.key || caller?.key;
        if (!key) throw new InvalidRequest("Cannot tell which chat this command runs in: give the key of the chat to fork");
        return fork({ key, before: request.before, title: request.title, message: request.message, caller });
      }
      case 'new':
        return create({ agent: request.chatAgent, title: request.title, message: request.message, caller });
      case 'whoami':
        return caller ? { key: caller.key, agent: caller.agent, ...(caller.parent ? { subagent: caller.sessionId } : {}) } : {};
      default:
        throw new InvalidRequest('Unknown action: list, read, fork, new or whoami');
    }
  };

  return { list, read, fork, create, handle };
}
