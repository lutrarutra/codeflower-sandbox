// Orchestrator chats (docs/architecture.md, "Orchestrators").
//
// An orchestrator is a chat of a hosted model (Claude) that may not see the
// project's data: it directs one other chat, its executor, an ordinary chat of
// a model on the cluster, and checks its work. It is linked to its executor
// when it starts, for good. Its session starts without Claude Code's tools but
// the web's (as the user allows) and with one MCP server of the bridge's,
// `executor` (codeflower-orchestrator-mcp): ask the executor, answer its
// questions, and see the figures and reports the user allows.
//
// The executor asks back with codeflower-orchestrator (the
// codeflower-executor skill). Both reach the bridge on the orchestrator socket.
//
// Nothing here enforces that the data stays put: the orchestrator is told what
// it may do, and the executor what it may send; the user sees everything that
// went to the orchestrator in the executor's chat ("Sent to orchestrator").
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidRequest } from './agents/support.js';
import { inside, listDirectory, resolveFile } from './files.js';
import { listSessions, readJson, readSessionMeta, readTranscript, sessionKey, writeJsonAtomically } from './sessions.js';

export const FROM_META = 'codeflower/from';
export const ORCHESTRATOR_NOTE_META = 'codeflower/orchestratorNote';

// `files`: it may list the folders the executor works in (names, not contents).
export const DEFAULT_ACCESS = Object.freeze({ web: true, files: true, figures: 'ask', report: 'ask', approve: false });
const LEVELS = ['never', 'ask', 'always'];
// Questions the executor may ask in one of its turns, so two models cannot go on for ever.
export const MAX_QUESTIONS = 5;
// Under the socket's 64 KiB a request may have (files.js).
const MAX_MESSAGE_CHARS = 20_000;
const MAX_REPLY_CHARS = 60_000;
const MAX_INPUT_CHARS = 2_000;
const MAX_REPORT_CHARS = 100_000;
const FIGURE_HEIGHT = 1600;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|tiff?|bmp)$/i;
const REPORT = /\.(html?|md|txt)$/i;

const promptFile = fileURLToPath(new URL('./orchestrator-prompt.md', import.meta.url));
/** What the orchestrator is told of its situation, after Claude Code's own prompt. */
export const ORCHESTRATOR_PROMPT = readFileSync(promptFile, 'utf8');

/** What the executor reads before each of the orchestrator's messages, which windows hide. */
export const EXECUTOR_NOTE =
  'The next message comes from an orchestrator: a hosted model that may not see the data of this project, ' +
  'which the user connected to this chat to direct and check your work (the codeflower-executor skill). ' +
  'Do what it asks. Your final message of this turn goes back to it, with the commands you ran (their input, not their output). ' +
  'Send it code, schemas, column names, aggregates and errors only: never rows, records, identifiers or anything that could ' +
  'identify a person. To ask it something during your turn, run `codeflower-orchestrator ask "…"`.';

/** What the orchestrator reads before a question of its executor's, which windows hide. */
const QUESTION_NOTE =
  'Your executor asks you this during its turn, which waits for your answer: your final message of this turn ' +
  'goes back to it. Answer it; do not call the ask tool now.';

/** Access as stored: every field, each valid; `base` for those not given. */
export function cleanAccess(access, base = DEFAULT_ACCESS) {
  if (access === undefined || access === null) return { ...base };
  if (typeof access !== 'object' || Array.isArray(access)) throw new InvalidRequest('Access is an object');
  const result = { ...base };
  for (const [name, value] of Object.entries(access)) {
    if (name === 'web' || name === 'files' || name === 'approve') {
      if (typeof value !== 'boolean') throw new InvalidRequest(`${name} is true or false`);
      result[name] = value;
    } else if (name === 'figures' || name === 'report') {
      if (!LEVELS.includes(value)) throw new InvalidRequest(`${name} is never, ask or always`);
      result[name] = value;
    } else {
      throw new InvalidRequest(`Unknown access: ${name}`);
    }
  }
  return result;
}

// The fields of a tool's input that name what it worked on, not what it wrote.
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path', 'paths', 'pattern', 'url'];

/**
 * A tool's input as the orchestrator sees it: a command or code it ran, cut
 * short; else only the paths it worked on. Never a file's content or the text
 * an edit wrote, which may be the data.
 */
export function toolInput(rawInput) {
  if (rawInput === undefined || rawInput === null) return undefined;
  const command = typeof rawInput === 'string' ? rawInput : (rawInput.command ?? rawInput.cmd ?? rawInput.code);
  if (typeof command === 'string' || Array.isArray(command)) {
    const text = Array.isArray(command) ? command.join(' ') : command;
    return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}… (cut)` : text;
  }
  if (typeof rawInput !== 'object') return undefined;
  const named = PATH_FIELDS.filter((field) => typeof rawInput[field] === 'string' || Array.isArray(rawInput[field])).map((field) =>
    `${field}: ${[rawInput[field]].flat().join(', ')}`.slice(0, 500)
  );
  return named.length ? named.join('; ') : undefined;
}

/**
 * Follows one turn's updates (server.js relayUpdate): the agent's messages,
 * each tool call starting the next, and its tool calls' titles and input.
 */
export function createTurnCollector() {
  const messages = [''];
  const tools = new Map();
  return {
    update(update) {
      switch (update?.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content?.type === 'text' && typeof update.content.text === 'string') messages[messages.length - 1] += update.content.text;
          break;
        case 'tool_call': {
          if (messages.at(-1)) messages.push('');
          const id = update.toolCallId ?? `tool-${tools.size}`;
          tools.set(id, { title: update.title ?? 'tool', kind: update.kind, rawInput: update.rawInput });
          break;
        }
        case 'tool_call_update': {
          const tool = tools.get(update.toolCallId);
          if (!tool) break;
          if (typeof update.title === 'string' && update.title) tool.title = update.title;
          if (update.kind) tool.kind = update.kind;
          if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
          break;
        }
      }
    },
    /** The last message with text, and the tools with their input. */
    result() {
      const reply = [...messages].reverse().find((text) => text.trim()) ?? '';
      const commands = [...tools.values()].map((tool) => {
        const input = toolInput(tool.rawInput);
        return { title: tool.title, ...(tool.kind ? { kind: tool.kind } : {}), ...(input !== undefined && input !== tool.title ? { input } : {}) };
      });
      return { reply, commands };
    }
  };
}

/** The executor's reply as the orchestrator's tool result reads it. */
export function replyText({ reply, commands = [], stopReason, error, withheld }) {
  if (withheld) return 'The user withheld the executor\'s reply.';
  if (error) return `The executor's turn failed: ${error}`;
  const parts = [];
  if (stopReason && stopReason !== 'end_turn') parts.push(`The executor's turn ended early (${stopReason}): its reply may be cut short.`);
  parts.push(`The executor's reply:\n${reply.trim() ? reply.trim() : '(no text)'}`);
  if (commands.length) {
    parts.push(
      `What it ran this turn (the input, not the output):\n${commands
        .map((command, index) => `${index + 1}. ${command.title}${command.input ? `\n   ${command.input.replace(/\n/g, '\n   ')}` : ''}`)
        .join('\n')}`
    );
  }
  const text = parts.join('\n\n');
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… (cut)` : text;
}

/** A report's text: HTML without its scripts, styles and tags. */
export function reportText(path, content) {
  if (!/\.html?$/i.test(path)) return content;
  return content
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|section|article|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cleanMessage = (message, what = 'The message') => {
  if (typeof message !== 'string' || !message.trim()) throw new InvalidRequest(`${what} is text`);
  if (message.length > MAX_MESSAGE_CHARS) throw new InvalidRequest(`${what} is longer than ${MAX_MESSAGE_CHARS} characters`);
  return message;
};

const permission = (id, title, text, allow, deny = 'Deny') => ({
  toolCall: {
    toolCallId: `codeflower-orchestrator-${id}`,
    title,
    kind: 'other',
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text } }]
  },
  options: [
    { optionId: 'allow', name: allow, kind: 'allow_once' },
    { optionId: 'deny', name: deny, kind: 'reject_once' }
  ]
});
const allowedAnswer = (answer) => answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow';

/**
 * The project's orchestrators.
 * - directory: the sessions folder (sessions.js); privateDirectory: the project state.
 * - runtimes: the agents' runtimes by name (server.js createRuntime).
 * - socket: the orchestrator socket, which codeflower-orchestrator-mcp reaches.
 * - mcpCommand: how to start codeflower-orchestrator-mcp ([command, ...args]).
 * - thumbnails: the bridge's (thumbnails.js), for figures; fileOptions: what may be read (files.js).
 * - changed(list): the orchestrators changed, for the windows; sessionsChanged(): the chat lists did.
 */
export function createOrchestrators({
  directory,
  privateDirectory,
  runtimes,
  socket,
  mcpCommand = ['/opt/codeflower/bin/codeflower-orchestrator-mcp'],
  thumbnails,
  fileOptions,
  // The folders the executor works in: [{ path, label }] (search.js searchFolders).
  folders = async () => [],
  changed = () => {},
  sessionsChanged = () => {},
  log = () => {}
}) {
  // Each orchestrator by its chat's key; `link` names it to its MCP server.
  const byKey = new Map();
  const byLink = new Map();

  const agentOf = (key) => [...runtimes.keys()].find((name) => typeof key === 'string' && key.startsWith(`${name}-`));
  const sessionIdOf = (key) => {
    const agent = agentOf(key);
    return agent ? key.slice(agent.length + 1) : undefined;
  };

  const add = (record) => {
    const link = {
      key: record.key,
      agent: agentOf(record.key),
      link: record.link,
      executor: record.executor,
      access: cleanAccess(record.access),
      disconnected: Boolean(record.disconnected),
      // An exchange with the executor: its turn for this orchestrator runs.
      busy: false,
      // Its turn started (it may wait behind another first).
      started: false,
      // Events for the orchestrator's waiting tool call: { type: reply | question, ... }.
      events: [],
      waiting: undefined,
      // The executor's question that waits for `answer`, and how many this turn asked.
      question: undefined,
      questions: 0,
      // The orchestrator answers a question in a turn of its own (it was idle).
      answering: false,
      sent: 0
    };
    byKey.set(link.key, link);
    if (link.link) byLink.set(link.link, link);
    return link;
  };

  /** Reads the orchestrators the project has; once, before the bridge takes requests. */
  const load = async () => {
    for (const session of await listSessions(directory).catch(() => [])) {
      if (session.role !== 'orchestrator') continue;
      const meta = await readSessionMeta(directory, session.key);
      if (meta) add({ key: session.key, link: meta.link, executor: meta.executor, access: meta.access, disconnected: meta.disconnected });
    }
  };

  const titles = async () => new Map((await listSessions(directory).catch(() => [])).map((session) => [session.key, session.title]));

  /** What the windows see of each orchestrator. */
  const list = async () => {
    const named = await titles();
    return [...byKey.values()].map((link) => ({
      key: link.key,
      agent: link.agent,
      title: named.get(link.key) ?? 'Orchestrator',
      executor: link.executor,
      executorTitle: named.get(link.executor) ?? link.executor,
      access: link.access,
      state: link.question || link.answering || link.asking ? 'waiting' : link.busy ? 'asking' : 'idle',
      sent: link.sent,
      ...(link.disconnected ? { disconnected: true } : {})
    }));
  };
  const announce = () => void list().then(changed, (error) => log(`Could not list the orchestrators: ${error.message}`));

  // ---- the orchestrator's session (server.js withSessionMeta) ----

  /** The orchestrator a session of `agent` is, if any: what its starts take. */
  const session = (agent, sessionId) => {
    const link = byKey.get(sessionKey(agent, sessionId));
    return link ? { key: link.key, link: link.link, access: link.access, cwd: orchestratorFolder(link.link) } : undefined;
  };

  /** The one MCP server an orchestrator's session has: the bridge's own. */
  const mcpServer = (linkId) => ({
    name: 'executor',
    command: mcpCommand[0],
    args: [...mcpCommand.slice(1), linkId],
    env: [{ name: 'CODEFLOWER_ORCHESTRATOR_SOCKET', value: socket }]
  });

  const orchestratorFolder = (linkId) => join(privateDirectory, 'orchestrators', linkId);

  // ---- windows ----

  /** Starts an orchestrator of `agent` on the chat `executor`, for good. */
  const create = async ({ executor, agent = 'claude', title, access } = {}) => {
    if (typeof executor !== 'string' || !executor) throw new InvalidRequest('Which chat should the orchestrator direct? Give its key');
    const runtime = runtimes.get(agent);
    if (!runtime) throw new InvalidRequest(`No agent ${agent} in this sandbox`);
    if (!runtime.agent.orchestrator) throw new InvalidRequest(`${runtime.agent.label ?? agent} cannot be an orchestrator`);
    const executorAgent = agentOf(executor);
    const meta = executorAgent ? await readSessionMeta(directory, executor) : undefined;
    if (!meta) throw new InvalidRequest(`No chat ${executor}`);
    if (meta.parentKey) throw new InvalidRequest("A subagent's chat cannot have an orchestrator: use its parent's");
    if (meta.role === 'orchestrator') throw new InvalidRequest('An orchestrator cannot have an orchestrator of its own');
    const named = await titles();
    const chatTitle =
      typeof title === 'string' && title.trim() && !/[\r\n]/.test(title)
        ? title.trim().slice(0, 200)
        : `Orchestrator of ${named.get(executor) ?? executor}`.slice(0, 200);
    const linkId = randomUUID();
    const cwd = orchestratorFolder(linkId);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const chosen = cleanAccess(access);
    const fields = { role: 'orchestrator', executor, link: linkId, access: chosen };
    const started = await runtime.startChat({ cwd, title: chatTitle, fields, orchestrator: { key: undefined, link: linkId, access: chosen, cwd } });
    add({ key: started.key, link: linkId, executor, access: chosen });
    log(`Started the orchestrator ${started.key} of ${executor}`);
    sessionsChanged();
    announce();
    return { key: started.key, agent, title: chatTitle, executor };
  };

  const requireLink = (key) => {
    const link = byKey.get(key);
    if (!link) throw new InvalidRequest(`No orchestrator ${key}`);
    return link;
  };

  const setFields = async (link, fields) => {
    const runtime = runtimes.get(link.agent);
    if (!runtime) throw new InvalidRequest(`No agent ${link.agent} in this sandbox`);
    await runtime.setMetaFields(sessionIdOf(link.key), fields);
  };

  /** Changes what an orchestrator may do; the web, at its session's next start. */
  const setAccess = async ({ key, access } = {}) => {
    const link = requireLink(key);
    const next = cleanAccess(access, link.access);
    const web = next.web !== link.access.web;
    link.access = next;
    await setFields(link, { access: next });
    announce();
    return { access: next, ...(web ? { restartNeeded: true } : {}) };
  };

  /** Ends the link: the orchestrator's chat stays, read-only. */
  const disconnect = async ({ key } = {}) => {
    const link = requireLink(key);
    link.disconnected = true;
    await setFields(link, { disconnected: true });
    if (link.question) {
      link.question.resolve({ error: 'The user disconnected the orchestrator.' });
      link.question = undefined;
    }
    push(link, { type: 'reply', error: 'The user disconnected you from the executor.' });
    sessionsChanged();
    announce();
    return {};
  };

  // ---- figures and reports the user shares ----

  const sharedFile = (link) => join(directory, link.key, 'shared.json');
  const shared = async (link) => {
    const value = await readJson(sharedFile(link)).catch(() => undefined);
    return Array.isArray(value?.files) ? value.files.filter((file) => typeof file?.path === 'string') : [];
  };

  /** The user shares a figure or report of the executor's with the orchestrators set to ask (or one of them). */
  const share = async ({ executor, key, path } = {}) => {
    if (typeof path !== 'string' || !path) throw new InvalidRequest('Which file? Give its path');
    const kind = IMAGE.test(path) ? 'figure' : REPORT.test(path) ? 'report' : undefined;
    if (!kind) throw new InvalidRequest('Only figures (images) and reports (HTML, Markdown, text) can be shared');
    const links = key ? [requireLink(key)] : [...byKey.values()].filter((link) => link.executor === executor && !link.disconnected);
    if (!links.length) throw new InvalidRequest('This chat has no orchestrator');
    for (const link of links) {
      const files = await shared(link);
      if (!files.some((file) => file.path === path)) {
        files.push({ path, kind, at: new Date().toISOString() });
        await writeJsonAtomically(sharedFile(link), { files });
      }
    }
    announce();
    return { shared: links.map((link) => link.key) };
  };

  // What the orchestrator may see of the executor's files: those its chat
  // showed (codeflower-show) when allowed always, and those the user shared.
  const visible = async (link, kind) => {
    const level = kind === 'figure' ? link.access.figures : link.access.report;
    if (level === 'never') return { level, files: [] };
    const pattern = kind === 'figure' ? IMAGE : REPORT;
    const files = new Set((await shared(link)).filter((file) => file.kind === kind).map((file) => file.path));
    if (level === 'always') {
      const executorAgent = agentOf(link.executor);
      if (executorAgent) await runtimes.get(executorAgent)?.flush();
      for (const entry of await readTranscript(directory, link.executor).catch(() => [])) {
        if (entry?.kind !== 'show') continue;
        for (const file of entry.files ?? []) if (typeof file === 'string' && pattern.test(file)) files.add(file);
      }
    }
    return { level, files: [...files].filter((file) => pattern.test(file)) };
  };

  // ---- the exchange with the executor ----

  const push = (link, event) => {
    if (link.waiting) {
      const { resolve } = link.waiting;
      link.waiting = undefined;
      resolve(event);
    } else {
      link.events.push(event);
    }
  };

  /** The next event of the exchange, for the orchestrator's waiting tool call. */
  const nextEvent = (link, signal) => {
    if (link.events.length) return Promise.resolve(link.events.shift());
    if (!link.busy) return Promise.resolve({ type: 'idle' });
    return new Promise((resolve) => {
      const waiting = { resolve };
      link.waiting = waiting;
      // The orchestrator's turn stopped: the next event waits for its next call.
      signal?.addEventListener('abort', () => {
        if (link.waiting === waiting) link.waiting = undefined;
      });
    });
  };

  const executorRuntime = (link) => {
    const agent = agentOf(link.executor);
    const runtime = agent ? runtimes.get(agent) : undefined;
    if (!runtime) throw new InvalidRequest(`The executor's agent is not in this sandbox (${link.executor})`);
    return { runtime, sessionId: sessionIdOf(link.executor) };
  };

  // What goes to the orchestrator, after the user allowed it if they asked to
  // be asked; noted in the executor's chat either way ("Sent to orchestrator").
  const release = async (link, kind, text, details = {}) => {
    const { runtime, sessionId } = executorRuntime(link);
    if (link.access.approve) {
      const id = randomUUID().slice(0, 8);
      const answer = await runtime.askUser(
        sessionId,
        permission(id, kind === 'question' ? 'Send this question to the orchestrator?' : 'Send this reply to the orchestrator?', text, 'Send', 'Withhold')
      );
      if (!allowedAnswer(answer)) {
        runtime.noteSent(sessionId, { to: link.key, what: kind, text: '', withheld: true });
        return false;
      }
    }
    link.sent += 1;
    runtime.noteSent(sessionId, { to: link.key, what: kind, text, ...details });
    return true;
  };

  const usable = (link) => {
    if (link.disconnected) throw new InvalidRequest('You are disconnected from the executor: the user ended the link.');
  };

  /** The orchestrator's `ask`: a turn of the executor's; answers with its next event. */
  const ask = async (link, message, signal) => {
    usable(link);
    const text = cleanMessage(message);
    if (link.question || link.answering || link.asking) throw new InvalidRequest('The executor is waiting for your answer to its question: answer it first.');
    if (link.busy) throw new InvalidRequest('The executor is still working on your last message: call wait for its reply.');
    const { runtime, sessionId } = executorRuntime(link);
    // Claimed before anything waits: parallel calls see it.
    link.busy = true;
    link.started = false;
    link.events = [];
    announce();
    const settle = (event) => {
      link.busy = false;
      link.started = false;
      if (link.question) {
        link.question.resolve({ error: 'Your turn ended before the orchestrator answered.' });
        link.question = undefined;
      }
      // Disconnected meanwhile: the reply goes nowhere.
      if (!link.disconnected) push(link, event);
      announce();
    };
    void (async () => {
      let event;
      try {
        const title = (await titles()).get(link.key) ?? 'Orchestrator';
        const prompt = [
          { type: 'text', text: EXECUTOR_NOTE, _meta: { [ORCHESTRATOR_NOTE_META]: true } },
          { type: 'text', text, _meta: { [FROM_META]: { kind: 'orchestrator', key: link.key, title, agent: link.agent } } }
        ];
        const result = await runtime.ask(sessionId, prompt, { onStart: () => (link.started = true) });
        if (link.disconnected) event = { type: 'reply', error: 'The user disconnected you from the executor.' };
        else {
          event = { type: 'reply', ...result };
          const sent = await release(link, 'reply', replyText(event), { stopReason: result.stopReason });
          if (!sent) event = { type: 'reply', withheld: true };
        }
      } catch (error) {
        event = { type: 'reply', error: error.message };
        log(`The orchestrator ${link.key}'s message to its executor failed: ${error.message}`);
      } finally {
        settle(event ?? { type: 'reply', error: 'The executor did not answer.' });
      }
    })();
    return nextEvent(link, signal);
  };

  /** The orchestrator's `answer` to the executor's question; then its next event. */
  const answer = async (link, text, signal) => {
    usable(link);
    if (!link.question) throw new InvalidRequest('The executor asked nothing that waits for an answer.');
    const reply = cleanMessage(text, 'The answer');
    link.question.settled = true;
    link.question.resolve({ answer: reply });
    link.question = undefined;
    announce();
    return nextEvent(link, signal);
  };

  /** The orchestrator's `wait`: the executor's next event, or idle. */
  const wait = (link, signal) => nextEvent(link, signal);

  // The executor's codeflower-orchestrator ask, from the chat `caller`
  // (callingChat): to the orchestrator whose message it works on, else to
  // the one it names (`to`) or its only one, in a turn of that one's own.
  const executorAsks = async (caller, request, signal) => {
    if (!caller) throw new InvalidRequest('Cannot tell which chat this command runs in: run codeflower-orchestrator in a chat\'s turn');
    let text = cleanMessage(request.message, 'The question');
    if (request.file !== undefined) {
      if (typeof request.file?.name !== 'string' || typeof request.file?.text !== 'string') throw new InvalidRequest('A file is its name and text');
      text = `${text}\n\n${request.file.name}:\n\`\`\`\n${request.file.text}\n\`\`\``;
      if (text.length > MAX_MESSAGE_CHARS) throw new InvalidRequest(`The question with its file is longer than ${MAX_MESSAGE_CHARS} characters`);
    }
    const mine = [...byKey.values()].filter((link) => link.executor === caller.key && !link.disconnected);
    if (!mine.length) throw new InvalidRequest('This chat has no orchestrator.');
    const named = typeof request.to === 'string' && request.to ? mine.find((link) => link.key === request.to) : undefined;
    if (request.to && !named) throw new InvalidRequest(`No orchestrator ${request.to} of this chat: see codeflower-orchestrator whoami`);
    // The one whose message the executor works on, or has waiting: its orchestrator waits in a
    // tool call, which takes the question. A turn of the orchestrator's own would queue behind
    // that call, which waits for this turn: neither would end.
    const current = mine.find((link) => link.busy && link.started) ?? mine.find((link) => link.busy);
    const link = named ?? current ?? (mine.length === 1 ? mine[0] : undefined);
    if (!link) throw new InvalidRequest(`This chat has ${mine.length} orchestrators: name one with --to (codeflower-orchestrator whoami)`);
    if (link.question || link.answering || link.asking) throw new InvalidRequest('Your last question still waits for its answer.');
    // The limit is per turn of the executor's.
    const { runtime: executorSide, sessionId: executorId } = executorRuntime(link);
    const turn = executorSide.turnCount?.(executorId);
    if (turn !== link.questionTurn) {
      link.questionTurn = turn;
      link.questions = 0;
    }
    if (link.questions >= MAX_QUESTIONS) {
      throw new InvalidRequest(`You asked ${MAX_QUESTIONS} questions this turn: finish the turn, or ask the user.`);
    }
    link.questions += 1;
    // Claimed before anything waits: a second question meanwhile is refused.
    link.asking = true;
    announce();
    try {
      if (!(await release(link, 'question', text))) return { ok: false, error: 'The user withheld the question.' };
      if (signal?.aborted) return { ok: false, error: 'The command went away.' };
      if (link.busy) {
        // It waits in ask, answer or wait: its tool call returns the question.
        const answered = new Promise((resolve) => (link.question = { resolve }));
        const event = { type: 'question', text };
        push(link, event);
        announce();
        // The command went away (e.g. its shell timed out): the question no longer waits.
        signal?.addEventListener('abort', () => {
          link.events = link.events.filter((queued) => queued !== event);
          if (link.question?.resolve && !link.question.settled) {
            link.question.resolve({ error: 'The command went away.' });
            link.question = undefined;
            announce();
          }
        });
        const result = await answered;
        return result.error ? { ok: false, error: result.error } : { ok: true, answer: result.answer };
      }
      // Not in an exchange: a turn of its own, whose last message answers.
      const runtime = runtimes.get(link.agent);
      if (!runtime) throw new InvalidRequest(`The orchestrator's agent is not in this sandbox (${link.agent})`);
      const title = (await titles()).get(caller.key) ?? 'Executor';
      link.answering = true;
      announce();
      // The command went away: later questions need not wait for this answer, which goes nowhere.
      signal?.addEventListener('abort', () => {
        link.answering = false;
        announce();
      });
      try {
        const result = await runtime.ask(sessionIdOf(link.key), [
          { type: 'text', text: QUESTION_NOTE, _meta: { [ORCHESTRATOR_NOTE_META]: true } },
          { type: 'text', text, _meta: { [FROM_META]: { kind: 'executor', key: caller.key, title, agent: caller.agent } } }
        ]);
        return { ok: true, answer: result.reply.trim() || '(The orchestrator gave no answer.)' };
      } finally {
        link.answering = false;
        announce();
      }
    } finally {
      link.asking = false;
      announce();
    }
  };

  const whoami = (caller) => {
    if (!caller) return { orchestrators: [] };
    return {
      key: caller.key,
      orchestrators: [...byKey.values()]
        .filter((link) => link.executor === caller.key)
        .map((link) => ({ key: link.key, agent: link.agent, ...(link.disconnected ? { disconnected: true } : {}) }))
    };
  };

  // ---- the orchestrator's tools (codeflower-orchestrator-mcp) ----

  const eventResult = (event) => {
    switch (event.type) {
      case 'question':
        return { text: `The executor asks you, and waits for your answer (call answer):\n${event.text}` };
      case 'idle':
        return { text: 'The executor is not working on anything of yours. Send it a message with ask.' };
      default:
        return { text: replyText(event), ...(event.error ? { isError: true } : {}) };
    }
  };

  const tool = async (request, signal) => {
    const link = byLink.get(request?.link);
    if (!link) throw new InvalidRequest('This MCP server belongs to no orchestrator of this project.');
    const input = request.input && typeof request.input === 'object' ? request.input : {};
    // Cut off from all of it, not only from asking.
    usable(link);
    switch (request.tool) {
      case 'ask':
        return eventResult(await ask(link, input.message, signal));
      case 'answer':
        return eventResult(await answer(link, input.text, signal));
      case 'wait':
        return eventResult(await wait(link, signal));
      // Names, types and sizes in the executor's folders; never what the files hold.
      case 'list_directory': {
        if (!link.access.files) throw new InvalidRequest('The user does not let you list the files.');
        const roots = await folders();
        if (input.path === undefined || input.path === null || input.path === '') {
          return { text: `The folders the executor works in:\n${roots.map((root) => `- ${root.path}  (${root.label})`).join('\n')}` };
        }
        if (typeof input.path !== 'string' || !roots.some((root) => inside(input.path, root.path))) {
          throw new InvalidRequest('Only the folders the executor works in can be listed: call list_directory without a path for them.');
        }
        const listing = await listDirectory(input.path, fileOptions);
        const size = (bytes) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);
        const lines = listing.entries.map((entry) => (entry.type === 'directory' ? `${entry.name}/` : `${entry.name}  ${size(entry.size)}`));
        return { text: `${listing.path}:\n${lines.join('\n') || '(empty)'}${listing.truncated ? '\n… (more entries left out)' : ''}` };
      }
      case 'list_files': {
        const figures = await visible(link, 'figure');
        const reports = await visible(link, 'report');
        const lines = [
          figures.level === 'never' ? 'Figures: the user does not let you see them.' : `Figures${figures.level === 'ask' ? ' the user shared' : ''}: ${figures.files.length ? `\n${figures.files.map((file) => `- ${file}`).join('\n')}` : 'none yet'}`,
          reports.level === 'never' ? 'Reports: the user does not let you read them.' : `Reports${reports.level === 'ask' ? ' the user shared' : ''}: ${reports.files.length ? `\n${reports.files.map((file) => `- ${file}`).join('\n')}` : 'none yet'}`
        ];
        return { text: lines.join('\n\n') };
      }
      case 'view_figure': {
        const { files, level } = await visible(link, 'figure');
        if (level === 'never') throw new InvalidRequest('The user does not let you see figures.');
        if (!files.includes(input.path)) throw new InvalidRequest('This figure is not one you may see: list_files lists those you may.');
        const image = await thumbnails.thumbnail(input.path, FIGURE_HEIGHT);
        return { image: { data: image.data, mimeType: image.mimeType }, text: input.path };
      }
      case 'read_report': {
        const { files, level } = await visible(link, 'report');
        if (level === 'never') throw new InvalidRequest('The user does not let you read reports.');
        if (!files.includes(input.path)) throw new InvalidRequest('This report is not one you may read: list_files lists those you may.');
        const file = await resolveFile(input.path, fileOptions);
        const text = reportText(file.path, await readFile(file.path, 'utf8'));
        return { text: text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}… (cut)` : text };
      }
      default:
        throw new InvalidRequest(`Unknown tool: ${request.tool}`);
    }
  };

  /**
   * The orchestrator socket's requests: the MCP server's tool calls
   * (`{ op: 'tool', link, tool, input }`) and codeflower-orchestrator's
   * (`{ action: ask | whoami, ... }`, from the chat `callingChat(request)` finds).
   */
  const handle = async (request, { signal, callingChat }) => {
    if (request?.op === 'tool') return tool(request, signal);
    const caller = callingChat(request);
    switch (request?.action) {
      case 'ask':
        return executorAsks(caller, request, signal);
      case 'whoami':
        return whoami(caller);
      default:
        throw new InvalidRequest('Unknown action: ask or whoami');
    }
  };

  return {
    load,
    list,
    session,
    mcpServer,
    create,
    setAccess,
    disconnect,
    share,
    handle,
    /** Whether the chat `key` is an orchestrator. */
    isOrchestrator: (key) => byKey.has(key),
    /** The orchestrators' agents (descriptors that say they can be one). */
    agents: () => [...runtimes.values()].filter((runtime) => runtime.agent.orchestrator).map((runtime) => runtime.name)
  };
}
