// Orchestrator chats (docs/architecture.md, "Orchestrators").
//
// An orchestrator is a chat of a hosted model (Claude) that may not see the
// project's data: it directs one other chat, its executor, a chat of a model on
// the cluster, and checks its work. The two are made together, as a pair, for
// good. The orchestrator's session starts without Claude Code's tools but the
// web's (as the user allows) and with one MCP server of the bridge's,
// `executor` (codeflower-orchestrator-mcp): ask the executor, answer its
// questions, and see the figures and reports the user allows.
//
// The executor is a chat of a role of its own (`role: executor`): it works in a
// folder of its own, whose AGENTS.md is the executor's short prompt
// (executor-folder.js), with fewer tools where its agent's index.js has an
// `executor` hook. It asks back with codeflower-orchestrator. Both reach the
// bridge on the orchestrator socket. Orchestrators attached to an ordinary chat
// (before pairs) are disconnected when the bridge starts.
//
// Nothing here enforces that the data stays put: the orchestrator is told what
// it may do, and the executor what it may send; the user sees everything that
// went to the orchestrator in the executor's chat ("Sent to orchestrator").
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidRequest } from './agents/support.js';
import { createExecutorFolders } from './executor-folder.js';
import { readAll, rootsDir } from './roots-store.js';
import { inside, listDirectory, resolveFile } from './files.js';
import { listSessions, readJson, readSessionMeta, readTranscript, sessionKey, writeJsonAtomically } from './sessions.js';

export const FROM_META = 'codeflower/from';
export const ORCHESTRATOR_NOTE_META = 'codeflower/orchestratorNote';
// A chat action's prompt (ui ACTION_PROMPT_META).
const ACTION_META = 'codeflower/action';

// `files`: it may list the folders the executor works in (names, not contents);
// `code`: read the scripts the executor wrote in its steps (read_code); `roots`: keep the project's map of ideas.
export const DEFAULT_ACCESS = Object.freeze({ web: true, files: true, code: true, roots: true, figures: 'ask', report: 'ask', approve: false });
const LEVELS = ['never', 'ask', 'always'];
// Questions the executor may ask in one of its turns, so two models cannot go on for ever.
// Asking instead of choosing is the executor's default, so this is only a backstop.
export const MAX_QUESTIONS = 10;
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
  'The next message is from your orchestrator: do this one step as your AGENTS.md says. Your final message goes back to it.';

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
    if (name === 'web' || name === 'files' || name === 'code' || name === 'roots' || name === 'approve') {
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

// The executor's code, which the orchestrator may read (read_code); notebooks
// and documents with code go without their outputs.
export const CODE = /\.(py|R|r|jl|sql|sh|m|do|sas|qmd|Rmd|ipynb)$/;
// A command that installs software, which a step should name (the orchestrator is told).
const INSTALL = /\b(pip3?|uv pip|uv add|conda|mamba|micromamba|npm|apt-get)\s+(install|add|create)\b|install\.packages\(|BiocManager::install|remotes::install_|pak::pkg_install|renv::install/;
// More than one small step: the orchestrator is told to look at what it did.
const DRIFT_COMMANDS = 8;
const DRIFT_SCRIPTS = 2;

// The paths an edit tool wrote: its input's path fields, else its locations.
const writtenPaths = (tool) => {
  const input = tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : {};
  const named = ['file_path', 'filePath', 'notebook_path', 'path'].map((field) => input[field]).filter((value) => typeof value === 'string' && value);
  // Codex's patches name their files as the keys of `changes`.
  if (input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) named.push(...Object.keys(input.changes));
  const located = (tool.locations ?? []).map((location) => location?.path).filter((path) => typeof path === 'string' && path);
  return [...new Set(named.length ? named : located)];
};
const isEdit = (tool) => tool.kind === 'edit' || (tool.rawInput && typeof tool.rawInput === 'object' && ['content', 'new_string', 'new_source', 'changes'].some((field) => field in tool.rawInput));
const isCommand = (tool) => tool.kind === 'execute' || typeof tool.rawInput?.command === 'string' || Array.isArray(tool.rawInput?.command) || typeof tool.rawInput?.cmd === 'string';

// A command's exit status from its tool call's output fields: numbers and
// flags only, never the output text, which may be the data.
const exitOf = (rawOutput) => {
  if (!rawOutput || typeof rawOutput !== 'object') return undefined;
  for (const field of ['exitCode', 'exit_code', 'returnCode', 'return_code']) {
    if (Number.isInteger(rawOutput[field])) return rawOutput[field];
  }
  if (Number.isInteger(rawOutput.metadata?.exit)) return rawOutput.metadata.exit;
  return undefined;
};

/**
 * Follows one turn's updates (server.js relayUpdate): the agent's messages,
 * each tool call starting the next, and its tool calls' titles, input,
 * final status and exit code, and the files edit tools wrote.
 */
export function createTurnCollector() {
  const messages = [''];
  const tools = new Map();
  const track = (tool, update) => {
    if (typeof update.title === 'string' && update.title) tool.title = update.title;
    if (update.kind) tool.kind = update.kind;
    if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
    if (Array.isArray(update.locations)) tool.locations = update.locations;
    if (typeof update.status === 'string') tool.status = update.status;
    const exit = exitOf(update.rawOutput);
    if (exit !== undefined) tool.exitCode = exit;
    if (update.rawOutput?.interrupted === true) tool.interrupted = true;
  };
  return {
    update(update) {
      switch (update?.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content?.type === 'text' && typeof update.content.text === 'string') messages[messages.length - 1] += update.content.text;
          break;
        case 'tool_call': {
          if (messages.at(-1)) messages.push('');
          const id = update.toolCallId ?? `tool-${tools.size}`;
          const tool = { title: update.title ?? 'tool' };
          track(tool, update);
          tools.set(id, tool);
          break;
        }
        case 'tool_call_update': {
          const tool = tools.get(update.toolCallId);
          if (tool) track(tool, update);
          break;
        }
      }
    },
    /** The last message with text, the tools with their input and outcome, and the files written. */
    result() {
      const reply = [...messages].reverse().find((text) => text.trim()) ?? '';
      const commands = [...tools.values()].map((tool) => {
        const input = toolInput(tool.rawInput);
        const failed = tool.status === 'failed' || (tool.exitCode !== undefined && tool.exitCode !== 0) || tool.interrupted === true;
        return {
          title: tool.title,
          ...(tool.kind ? { kind: tool.kind } : {}),
          ...(input !== undefined && input !== tool.title ? { input } : {}),
          ...(isCommand(tool) ? { command: true } : {}),
          ...(tool.status === 'completed' || tool.status === 'failed' ? { status: failed ? 'failed' : 'ok' } : failed ? { status: 'failed' } : {}),
          ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
          ...(tool.interrupted ? { interrupted: true } : {})
        };
      });
      const written = [...new Set([...tools.values()].filter((tool) => isEdit(tool) && tool.status !== 'failed').flatMap(writtenPaths))];
      return { reply, commands, written };
    }
  };
}

const outcome = (command) => {
  if (!command.status) return '';
  if (command.status === 'ok') return ': ok';
  const why = command.interrupted ? 'interrupted' : command.exitCode !== undefined ? `exit ${command.exitCode}` : '';
  return `: failed${why ? ` (${why})` : ''}`;
};

/**
 * The executor's reply as the orchestrator's tool result reads it: a line of
 * the bridge's own counts first, which the executor cannot misreport, then its
 * reply, its commands with their outcome, the code it wrote and the files it
 * showed (`files`: [{ path, status }], §3) and `questions` it asked this step.
 */
export function replyText({ reply, commands = [], written = [], files = [], questions = 0, stopReason, error, withheld }) {
  if (withheld) return 'The user withheld the executor\'s reply.';
  if (error) return `The executor's turn failed: ${error}`;
  const parts = [];
  const run = commands.filter((command) => command.command);
  const failed = run.filter((command) => command.status === 'failed');
  const anyFailed = commands.some((command) => command.status === 'failed');
  const code = written.filter((path) => CODE.test(path));
  const installs = run.filter((command) => INSTALL.test(command.input ?? command.title ?? ''));
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  parts.push(
    `This step (the bridge's count): ${plural(run.length, 'command')}, ${failed.length} failed, ${plural(code.length, 'script')} written, ${plural(files.length, 'file')} shown, ${plural(questions, 'question')} asked.` +
      (run.length > DRIFT_COMMANDS || code.length > DRIFT_SCRIPTS ? ' This is more than one small step: check what it did beyond what you asked.' : '') +
      (anyFailed ? ' Some tool calls failed: check that the reply does not claim what they did not produce.' : '') +
      (installs.length ? ` It installed software (${installs.length === 1 ? 'command' : 'commands'} ${installs.map((command) => run.indexOf(command) + 1).join(', ')} below): was that in your step?` : '')
  );
  if (stopReason && stopReason !== 'end_turn') parts.push(`The executor's turn ended early (${stopReason}): its reply may be cut short.`);
  parts.push(`The executor's reply:\n${reply.trim() ? reply.trim() : '(no text)'}`);
  if (commands.length) {
    parts.push(
      `What it ran this turn (the input and outcome, not the output):\n${commands
        .map((command, index) => `${index + 1}. ${command.title}${outcome(command)}${command.input ? `\n   ${command.input.replace(/\n/g, '\n   ')}` : ''}`)
        .join('\n')}`
    );
  }
  if (code.length) parts.push(`Code it wrote or changed this step (read it with read_code):\n${code.map((path) => `- ${path}`).join('\n')}`);
  const others = written.filter((path) => !CODE.test(path));
  if (others.length) parts.push(`Other files it wrote with its file tools:\n${others.map((path) => `- ${path}`).join('\n')}`);
  if (files.length) parts.push(`Files it showed this step:\n${files.map((file) => `- ${file.path}: ${SHOWN[file.status] ?? file.status}`).join('\n')}`);
  const text = parts.join('\n\n');
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… (cut)` : text;
}

// What the orchestrator should do with a file the executor showed (§3).
const SHOWN = {
  visible: 'shared with you: look at it (view_figure, or read_report) before your next ask',
  declined: "the user didn't share it with you",
  hidden: 'you may not see files of this kind (the user\'s setting)'
};

// What the orchestrator may do with the map of ideas (codeflower-roots), and which of it reads the map.
const ROOTS_COMMANDS = ['tree', 'show', 'todos', 'new', 'update', 'todo', 'need', 'link', 'conclude', 'comment', 'open'];
const ROOTS_READS = ['tree', 'show', 'todos'];
// The ideas a codeflower-roots command names: its ID argument, and the ideas it builds on or needs.
export function ideasNamed(args) {
  const ids = [];
  const id = (text) => {
    const value = Number(String(text ?? '').replace(/^#/, ''));
    if (Number.isInteger(value) && value > 0) ids.push(value);
  };
  const [command, ...rest] = args;
  const positional = rest.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && rest[index - 1].startsWith('--') && rest[index - 1] !== '--done' && rest[index - 1] !== '--json' && rest[index - 1] !== '--mine' && rest[index - 1] !== '--rm'));
  if (['show', 'update', 'link', 'conclude', 'comment', 'open'].includes(command)) id(positional[0]);
  if (command === 'todos' && positional[0]) id(positional[0]);
  if (command === 'todo' || command === 'need') id(positional[1]);
  if (command === 'need' && positional[0] === 'add') for (const need of positional.slice(2)) if (/^#?\d+$/.test(need.trim())) id(need.trim());
  rest.forEach((arg, index) => {
    if (arg === '--from') for (const part of String(rest[index + 1] ?? '').split(',')) if (part.trim() && part.trim() !== 'none') id(part.trim());
    if (arg === '--need' && /^#?\d+$/.test(String(rest[index + 1] ?? '').trim())) id(rest[index + 1].trim());
  });
  return [...new Set(ids)];
}

// The executor's sandbox as codeflower-doctor reports it to the executor.
const runDoctor = () =>
  new Promise((resolve, reject) =>
    execFile('/opt/codeflower/bin/codeflower-doctor', ['--executor', '--json'], { timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new InvalidRequest(`codeflower-doctor failed: ${error.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new InvalidRequest('codeflower-doctor gave no facts'));
      }
    })
  );

/** A notebook's code and markdown cells, without their outputs (which may be the data). */
export function notebookSource(json) {
  let notebook;
  try {
    notebook = JSON.parse(json);
  } catch {
    throw new InvalidRequest('This notebook is not valid JSON');
  }
  return (Array.isArray(notebook?.cells) ? notebook.cells : [])
    .map((cell, index) => `# [${index + 1}] ${cell?.cell_type ?? 'cell'}\n${[cell?.source ?? ''].flat().join('')}`)
    .join('\n\n');
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
const RELEASE_TITLES = {
  question: 'Send this question to the orchestrator?',
  reply: 'Send this reply to the orchestrator?',
  code: 'Send this code to the orchestrator?'
};
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
  // codeflower-roots, which the orchestrator's `roots` tool runs as its chat, and what it needs of the bridge's environment.
  rootsCommand = ['/opt/codeflower/bin/codeflower-roots'],
  rootsEnvironment = {},
  // The storyteller skill, which the orchestrator reads before it writes a report (report_guide).
  reportGuide = '/opt/codeflower/src/storyteller/skill/SKILL.md',
  // The executor's sandbox (codeflower-doctor --executor --json), for the orchestrator's `environment` tool.
  environment = () => runDoctor(),
  // The workspace, and the executor's instructions (templates/EXECUTOR.md, its includes resolved).
  workspace = '/codeflower-state/workspace',
  executorText,
  changed = () => {},
  sessionsChanged = () => {},
  log = () => {}
}) {
  // Each orchestrator by its chat's key; `link` names it to its MCP server.
  const byKey = new Map();
  const byLink = new Map();
  const executorFolders = createExecutorFolders({
    directory: join(privateDirectory, 'executors'),
    installed: join(privateDirectory, 'run', 'templates', 'EXECUTOR.md'),
    text: executorText
  });
  // What an executor of `agent` gets from its index.js's `executor` hook:
  // { meta, settings, tools }; an agent without one keeps its usual tools.
  const executorSpec = (agent) => runtimes.get(agent)?.agent.executor?.({ workspace }) ?? {};

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
      sent: 0,
      // The code the executor wrote in this orchestrator's steps, which read_code serves.
      code: new Set(),
      // The figures and reports it showed in this step: path → { path, kind, status }, and the
      // shares that wait for the user's answer: path → { promise, settle }.
      stepFiles: new Map(),
      pending: new Map(),
      // Shows the user did not share; files already told of; those it looked at.
      declined: new Set(),
      announced: new Set(),
      viewed: new Set(),
      // The code it read (read_code), for the footer.
      read: new Set()
    };
    byKey.set(link.key, link);
    if (link.link) byLink.set(link.link, link);
    return link;
  };

  /** Reads the orchestrators the project has; once, before the bridge takes requests. */
  const load = async () => {
    await executorFolders.update().catch((error) => log(`Could not update the executors' instructions: ${error.message}`));
    for (const session of await listSessions(directory).catch(() => [])) {
      if (session.role !== 'orchestrator') continue;
      const meta = await readSessionMeta(directory, session.key);
      if (!meta) continue;
      const link = add({ key: session.key, link: meta.link, executor: meta.executor, access: meta.access, disconnected: meta.disconnected });
      if (link.disconnected) continue;
      // Attached to an ordinary chat, before pairs: that chat is an ordinary one again.
      const executorMeta = typeof meta.executor === 'string' ? await readSessionMeta(directory, meta.executor) : undefined;
      if (executorMeta?.role !== 'executor') {
        link.disconnected = true;
        await setFields(link, { disconnected: true }).catch((error) => log(`Could not disconnect the orchestrator ${link.key}: ${error.message}`));
        log(`Disconnected the orchestrator ${link.key}: its chat ${meta.executor} is not an executor`);
      }
    }
  };

  const titles = async () => new Map((await listSessions(directory).catch(() => [])).map((session) => [session.key, session.title]));

  /** What the windows see of each orchestrator. */
  // What has been shared with an orchestrator, for its chat's footer: the figures and reports it
  // may see, those waiting for the user's answer or not shared, and the code it read.
  const filesOf = async (link) => {
    const files = new Map();
    for (const kind of ['figure', 'report']) {
      const { files: seen } = await visible(link, kind).catch(() => ({ files: [] }));
      for (const path of seen) files.set(path, { path, kind, status: 'visible' });
    }
    for (const path of link.pending.keys()) files.set(path, { path, kind: IMAGE.test(path) ? 'figure' : 'report', status: 'pending' });
    for (const path of link.declined) if (!files.has(path)) files.set(path, { path, kind: IMAGE.test(path) ? 'figure' : 'report', status: 'declined' });
    for (const path of link.read) files.set(path, { path, kind: 'code', status: 'visible' });
    return [...files.values()];
  };

  const list = async () => {
    const named = await titles();
    return Promise.all([...byKey.values()].map(async (link) => ({
      key: link.key,
      agent: link.agent,
      title: named.get(link.key) ?? 'Orchestrator',
      executor: link.executor,
      executorTitle: named.get(link.executor) ?? link.executor,
      executorAgent: agentOf(link.executor),
      // Its folder, whose AGENTS.md is its prompt.
      executorFolder: executorFolders.folder(link.link),
      // What the executor got: its tools where its agent limits them (`limited`), else its usual ones.
      ...executorTools(link),
      access: link.access,
      state: link.question || link.answering || link.asking ? 'waiting' : link.sharing ? 'sharing' : link.busy ? 'asking' : 'idle',
      sent: link.sent,
      files: link.disconnected ? [] : await filesOf(link),
      ...(link.disconnected ? { disconnected: true } : {})
    })));
  };
  const executorTools = (link) => {
    const tools = executorSpec(agentOf(link.executor)).tools;
    return Array.isArray(tools) ? { executorTools: tools, executorLimited: true } : { executorLimited: false };
  };
  const announce = () => void list().then(changed, (error) => log(`Could not list the orchestrators: ${error.message}`));

  // ---- the orchestrator's session (server.js withSessionMeta) ----

  /** The orchestrator a session of `agent` is, if any: what its starts take. */
  const session = (agent, sessionId) => {
    const link = byKey.get(sessionKey(agent, sessionId));
    return link ? { key: link.key, link: link.link, access: link.access, cwd: orchestratorFolder(link.link) } : undefined;
  };

  /** The executor a session of `agent` is, if any: its folder and what its agent's hook gives it. */
  const executorSession = (agent, sessionId) => {
    const key = sessionKey(agent, sessionId);
    const link = [...byKey.values()].find((candidate) => candidate.executor === key && !candidate.disconnected);
    if (!link) return undefined;
    const { meta, settings } = executorSpec(agent);
    return { key, link: link.link, cwd: executorFolders.folder(link.link), ...(meta ? { meta } : {}), ...(settings ? { settings } : {}) };
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

  const cleanTitle = (title) => (typeof title === 'string' && title.trim() && !/[\r\n]/.test(title) ? title.trim().slice(0, 180) : undefined);

  /**
   * Makes a pair: an executor chat of `executor.agent` (any agent, with
   * `executor.settings`, e.g. its model) in a folder of its own, and an
   * orchestrator of `agent` (Claude) that directs it, for good. An existing
   * chat cannot be made an executor.
   */
  const create = async ({ executor, agent = 'claude', title, access } = {}) => {
    if (typeof executor === 'string') throw new InvalidRequest('An orchestrator comes with an executor chat of its own: give the executor\'s agent ({ executor: { agent } }), not a chat');
    if (!executor || typeof executor !== 'object' || typeof executor.agent !== 'string') throw new InvalidRequest("Which agent should the executor be? Give { executor: { agent } }");
    const runtime = runtimes.get(agent);
    if (!runtime) throw new InvalidRequest(`No agent ${agent} in this sandbox`);
    if (!runtime.agent.orchestrator) throw new InvalidRequest(`${runtime.agent.label ?? agent} cannot be an orchestrator`);
    const executorSide = runtimes.get(executor.agent);
    if (!executorSide) throw new InvalidRequest(`No agent ${executor.agent} in this sandbox`);
    if (executor.settings !== undefined && (typeof executor.settings !== 'object' || executor.settings === null || Array.isArray(executor.settings))) {
      throw new InvalidRequest('The executor\'s settings are an object');
    }
    const chosen = cleanAccess(access);
    const name = cleanTitle(title) ?? 'Orchestrated chat';
    const linkId = randomUUID();
    const executorCwd = await executorFolders.create(linkId);
    const cwd = orchestratorFolder(linkId);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const spec = executorSpec(executor.agent);
    const wanted = executor.settings ?? {};
    const settings = spec.settings
      ? { ...wanted, ...spec.settings, ...(wanted.options || spec.settings.options ? { options: { ...wanted.options, ...spec.settings.options } } : {}) }
      : executor.settings;
    const executorChat = await executorSide.startChat({
      cwd: executorCwd,
      title: name,
      fields: { role: 'executor', link: linkId },
      executor: { link: linkId, cwd: executorCwd, ...(spec.meta ? { meta: spec.meta } : {}) },
      ...(settings ? { settings } : {})
    });
    const fields = { role: 'orchestrator', executor: executorChat.key, link: linkId, access: chosen };
    // Both halves take the title; the chat list tells them apart by their compass, the lines under their headers by name.
    const started = await runtime.startChat({ cwd, title: name, fields, orchestrator: { key: undefined, link: linkId, access: chosen, cwd } });
    await executorSide.setMetaFields(executorChat.sessionId, { orchestrator: started.key });
    add({ key: started.key, link: linkId, executor: executorChat.key, access: chosen });
    log(`Started the orchestrator ${started.key} with its executor ${executorChat.key}`);
    sessionsChanged();
    announce();
    return { key: started.key, agent, title: name, executor: executorChat.key, executorAgent: executor.agent };
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

  /**
   * A chat action that is the orchestrator's to do (one with an `orchestratorPrompt`, e.g. the report),
   * chosen in its executor's chat: its prompt goes to the orchestrator's chat, after its running turn.
   */
  const runAction = ({ executor, action } = {}) => {
    const link = [...byKey.values()].find((candidate) => candidate.executor === executor && !candidate.disconnected);
    if (!link) throw new InvalidRequest('This chat has no orchestrator');
    if (typeof action?.orchestratorPrompt !== 'string') throw new InvalidRequest(`${action?.title ?? 'This action'} is not one for the orchestrator`);
    const runtime = runtimes.get(link.agent);
    if (!runtime) throw new InvalidRequest(`The orchestrator's agent is not in this sandbox (${link.agent})`);
    const prompt = [{ type: 'text', text: action.orchestratorPrompt, _meta: { [ACTION_META]: { id: action.id, title: action.title } } }];
    void runtime.ask(sessionIdOf(link.key), prompt).catch((error) => log(`${action.title} did not reach the orchestrator ${link.key}: ${error.message}`));
    return { key: link.key };
  };

  /** Ends the link: the orchestrator's chat stays, read-only. */
  const disconnect = async ({ key } = {}) => {
    const link = requireLink(key);
    link.disconnected = true;
    await setFields(link, { disconnected: true });
    for (const pending of link.pending.values()) pending.settle('declined');
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
      await addShared(link, path, kind);
      link.declined.delete(path);
      // A share the step waits for: settled now; the prompt's later answer is ignored.
      link.pending.get(path)?.settle('visible');
    }
    announce();
    return { shared: links.map((link) => link.key) };
  };

  const addShared = async (link, path, kind) => {
    const files = await shared(link);
    if (files.some((file) => file.path === path)) return;
    files.push({ path, kind, at: new Date().toISOString() });
    await writeJsonAtomically(sharedFile(link), { files });
  };

  /**
   * The executor `executorKey` showed `files` (server.js noteShown): during a
   * step of its orchestrator's, each figure or report is shared, hidden, or,
   * when the user is to be asked, asked about now in the executor's chat; the
   * step's reply waits for the answer (ask). Shows outside a step are unchanged.
   */
  const shown = (executorKey, files) => {
    for (const link of byKey.values()) {
      // Only in the step's own turn (not the user's, which it may wait behind).
      if (link.executor !== executorKey || link.disconnected || !link.busy || !link.started) continue;
      for (const path of files) {
        if (typeof path !== 'string') continue;
        const kind = IMAGE.test(path) ? 'figure' : REPORT.test(path) ? 'report' : undefined;
        if (!kind || link.pending.has(path)) continue;
        const level = kind === 'figure' ? link.access.figures : link.access.report;
        const note = (status) => link.stepFiles.set(path, { path, kind, status });
        if (level === 'never') note('hidden');
        else if (level === 'always') note('visible');
        else void askShare(link, path, kind, note);
      }
      announce();
    }
  };

  const askShare = async (link, path, kind, note) => {
    if ((await shared(link)).some((file) => file.path === path)) return note('visible');
    if (link.pending.has(path)) return;
    let settle;
    const promise = new Promise((resolve) => (settle = resolve)).then((status) => {
      if (link.pending.get(path)?.promise === promise) link.pending.delete(path);
      if (status === 'declined') link.declined.add(path);
      note(status);
      announce();
      return status;
    });
    let settled = false;
    const once = (status) => {
      if (settled) return;
      settled = true;
      settle(status);
    };
    link.pending.set(path, { promise, settle: once });
    note('pending');
    announce();
    try {
      const { runtime, sessionId } = executorRuntime(link);
      const id = randomUUID().slice(0, 8);
      const what = kind === 'figure' ? 'figure' : 'report';
      const answer = await runtime.askUser(
        sessionId,
        permission(
          id,
          `Share ${basename(path)} with the orchestrator?`,
          `The executor showed the ${what} ${path} during the orchestrator's step. The orchestrator waits for your answer before it goes on: share it so it can check the ${what}, or keep it here.`,
          'Share',
          "Don't share"
        )
      );
      if (allowedAnswer(answer)) {
        await addShared(link, path, kind);
        once('visible');
      } else {
        once('declined');
      }
    } catch (error) {
      log(`Could not ask to share ${path}: ${error.message}`);
      once('declined');
    }
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
        permission(id, RELEASE_TITLES[kind] ?? 'Send this to the orchestrator?', text, 'Send', 'Withhold')
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
    // The step's questions are counted from here (executorAsks counts per executor turn), and its shows.
    link.questionTurn = undefined;
    link.questions = 0;
    link.stepFiles = new Map();
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
        // Shares the user is asked about: the reply waits for the answers, so the orchestrator knows what it may see.
        if (link.pending.size) {
          link.sharing = true;
          announce();
          await Promise.all([...link.pending.values()].map((pending) => pending.promise));
          link.sharing = false;
        }
        if (link.disconnected) event = { type: 'reply', error: 'The user disconnected you from the executor.' };
        else {
          const written = (result.written ?? []).map((path) => (isAbsolute(path) ? path : join(executorFolders.folder(link.link), path)));
          for (const path of written) if (CODE.test(path)) link.code.add(path);
          const files = [...link.stepFiles.values()];
          for (const file of files) if (file.status === 'visible') link.announced.add(file.path);
          event = { type: 'reply', ...result, written, files, questions: link.questionTurn === undefined ? 0 : link.questions };
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

  // The ideas an orchestrator started (its chat is recorded on them), by id. It may read and
  // change only those: the rest of the map is other chats' work, written by agents that see the data.
  const rootsFolder = () => rootsDir({ ...process.env, ...rootsEnvironment, CODEFLOWER_WORKSPACE: workspace });
  const ownIdeas = (link) => {
    const sessionId = sessionIdOf(link.key);
    const { ideas } = readAll(rootsFolder());
    return new Map(ideas.filter((idea) => idea.chats.some((chat) => chat.agent === link.agent && chat.sessionId === sessionId)).map((idea) => [idea.id, idea]));
  };
  const ownTree = (link) => {
    const ideas = [...ownIdeas(link).values()];
    if (!ideas.length) return 'You have started no idea yet: start one for this work with ["new", "TITLE", "--todo", "…"]. You see only the ideas you started.';
    return [
      'Your ideas (you see only those you started):',
      ...ideas.flatMap((idea) => [
        `#${idea.id} [${idea.status}] ${idea.title}${idea.todos.length ? `  todos ${idea.todos.filter((todo) => todo.done).length}/${idea.todos.length}` : ''}`,
        ...idea.todos.map((todo, index) => `  [${todo.done ? 'x' : ' '}] ${index + 1}. ${todo.text}`)
      ])
    ].join('\n');
  };

  const runRoots = (link, args) =>
    new Promise((resolve) => {
      const env = {
        ...process.env,
        ...rootsEnvironment,
        CODEFLOWER_WORKSPACE: workspace,
        CODEFLOWER_AGENT_NAME: link.agent,
        CLAUDE_CODE_SESSION_ID: sessionIdOf(link.key),
        CODEX_THREAD_ID: ''
      };
      execFile(rootsCommand[0], [...rootsCommand.slice(1), ...args], { env, timeout: 30_000, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
        const text = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim() || '(no output)';
        resolve({ text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… (cut)` : text, ...(error ? { isError: true } : {}) });
      });
    });

  // Files the user shared since the orchestrator was last told (the Share button), once each.
  const sharedSince = async (link) => {
    const fresh = [];
    for (const kind of ['figure', 'report']) {
      const { files } = await visible(link, kind);
      for (const path of files) {
        if (link.announced.has(path)) continue;
        link.announced.add(path);
        fresh.push(path);
      }
    }
    return fresh;
  };
  // What follows each exchange's result: files shared since, and the user's
  // messages to the orchestrator that waited meanwhile, steered into its turn
  // now, so it reads them before its next step rather than at its turn's end.
  const afterExchange = async (link, result) => {
    let text = result.text;
    const fresh = await sharedSince(link);
    if (fresh.length) text += `\n\nShared with you since your last call (view_figure or read_report):\n${fresh.map((path) => `- ${path}`).join('\n')}`;
    const runtime = runtimes.get(link.agent);
    const queued = runtime?.deliverQueued ? await runtime.deliverQueued(sessionIdOf(link.key)).catch(() => undefined) : undefined;
    if (queued?.steered) text += '\n\nThe user sent you a message while the executor worked: read it, and act on it, before your next ask.';
    else if (queued?.waiting) text += '\n\nThe user has a message waiting for you: end your turn now to read it (say where you are first).';
    return { ...result, text };
  };

  const tool = async (request, signal) => {
    const link = byLink.get(request?.link);
    if (!link) throw new InvalidRequest('This MCP server belongs to no orchestrator of this project.');
    const input = request.input && typeof request.input === 'object' ? request.input : {};
    // Cut off from all of it, not only from asking.
    usable(link);
    switch (request.tool) {
      case 'ask':
        return afterExchange(link, eventResult(await ask(link, input.message, signal)));
      case 'answer':
        return afterExchange(link, eventResult(await answer(link, input.text, signal)));
      case 'wait':
        return afterExchange(link, eventResult(await wait(link, signal)));
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
      // The project's map of ideas, kept by the orchestrator: codeflower-roots, run as its chat.
      case 'roots': {
        if (!link.access.roots) throw new InvalidRequest('The user does not let you keep the map of ideas.');
        const args = Array.isArray(input.args) ? input.args : [];
        if (!args.length || !args.every((arg) => typeof arg === 'string' && arg.length <= MAX_MESSAGE_CHARS)) {
          throw new InvalidRequest('Give codeflower-roots\'s arguments as a list of strings, e.g. ["tree"] or ["todo", "check", "3", "1"]');
        }
        if (!ROOTS_COMMANDS.includes(args[0])) throw new InvalidRequest(`codeflower-roots ${args[0]} is not for you: ${ROOTS_COMMANDS.join(', ')}`);
        // Only its own ideas: the others were written by chats that see the data, and may hold it.
        const own = ownIdeas(link);
        for (const id of ideasNamed(args)) {
          if (!own.has(id)) throw new InvalidRequest(`Idea #${id} is not one of yours: you see and change only the ideas you started (roots ["tree"] lists them).`);
        }
        if (args[0] === 'tree') return { text: ownTree(link) };
        const output = await runRoots(link, args[0] === 'todos' && args.length === 1 ? ['todos', '--mine'] : args);
        // What the map says may have been written by the executor or the user: noted as sent, not asked about.
        if (ROOTS_READS.includes(args[0])) {
          const { runtime, sessionId } = executorRuntime(link);
          runtime.noteSent(sessionId, { to: link.key, what: 'roots', text: output.text });
        }
        return output;
      }
      // Drafts of the orchestrator's report, in the workspace's orchestrator/ folder, which the executor builds.
      case 'write_draft': {
        if (typeof input.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) throw new InvalidRequest('The name is a slug: lowercase letters, digits and dashes');
        if (typeof input.markdown !== 'string' || !input.markdown.trim()) throw new InvalidRequest('The draft is Markdown text');
        if (input.markdown.length > MAX_REPORT_CHARS) throw new InvalidRequest(`The draft is longer than ${MAX_REPORT_CHARS} characters`);
        const folder = join(workspace, 'orchestrator');
        await mkdir(folder, { recursive: true });
        const path = join(folder, `${input.name}.md`);
        await writeFile(path, input.markdown.endsWith('\n') ? input.markdown : `${input.markdown}\n`);
        return { text: `Wrote ${path}. Have the executor build the report from it, then read it back with read_report.` };
      }
      case 'report_guide':
        return { text: await readFile(reportGuide, 'utf8').catch(() => 'The storyteller skill is not in this image.') };
      // A script the executor wrote in one of this orchestrator's steps, without a notebook's outputs.
      case 'read_code': {
        if (!link.access.code) throw new InvalidRequest('The user does not let you read the executor\'s code.');
        if (typeof input.path !== 'string' || !link.code.has(input.path)) {
          throw new InvalidRequest("Only code the executor wrote or changed in your steps can be read: its replies list it under \"Code it wrote\".");
        }
        const file = await resolveFile(input.path, fileOptions);
        let text = await readFile(file.path, 'utf8');
        if (/\.ipynb$/.test(file.path)) text = notebookSource(text);
        if (text.length > MAX_REPORT_CHARS) text = `${text.slice(0, MAX_REPORT_CHARS)}… (cut)`;
        if (!(await release(link, 'code', text, { path: input.path }))) return { text: 'The user withheld this code.' };
        link.read.add(input.path);
        announce();
        return { text: `${input.path}:\n\`\`\`\n${text}\n\`\`\`` };
      }
      // The doctor's facts, as the executor reads them; host paths only where the user lets it list files.
      case 'environment': {
        const facts = await environment();
        const mounts = (facts.mounts ?? []).map(({ source, ...mount }) => (link.access.files && source ? { ...mount, source } : mount));
        return { text: JSON.stringify({ ...facts, mounts }, null, 2) };
      }
      case 'list_files': {
        const figures = await visible(link, 'figure');
        const reports = await visible(link, 'report');
        const item = (file) => `- ${file}${link.viewed.has(file) ? '' : '  (not looked at yet)'}`;
        for (const file of [...figures.files, ...reports.files]) link.announced.add(file);
        const lines = [
          figures.level === 'never' ? 'Figures: the user does not let you see them.' : `Figures${figures.level === 'ask' ? ' the user shared' : ''}: ${figures.files.length ? `\n${figures.files.map(item).join('\n')}` : 'none yet'}`,
          reports.level === 'never' ? 'Reports: the user does not let you read them.' : `Reports${reports.level === 'ask' ? ' the user shared' : ''}: ${reports.files.length ? `\n${reports.files.map(item).join('\n')}` : 'none yet'}`
        ];
        if (link.declined.size) lines.push(`The user did not share: ${[...link.declined].join(', ')}`);
        return { text: lines.join('\n\n') };
      }
      case 'view_figure': {
        const { files, level } = await visible(link, 'figure');
        if (level === 'never') throw new InvalidRequest('The user does not let you see figures.');
        if (!files.includes(input.path)) throw new InvalidRequest('This figure is not one you may see: list_files lists those you may.');
        const image = await thumbnails.thumbnail(input.path, FIGURE_HEIGHT);
        link.viewed.add(input.path);
        return { image: { data: image.data, mimeType: image.mimeType }, text: input.path };
      }
      case 'read_report': {
        const { files, level } = await visible(link, 'report');
        if (level === 'never') throw new InvalidRequest('The user does not let you read reports.');
        if (!files.includes(input.path)) throw new InvalidRequest('This report is not one you may read: list_files lists those you may.');
        const file = await resolveFile(input.path, fileOptions);
        const text = reportText(file.path, await readFile(file.path, 'utf8'));
        link.viewed.add(input.path);
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
    executorSession,
    mcpServer,
    create,
    setAccess,
    disconnect,
    runAction,
    share,
    shown,
    handle,
    /** Whether the chat `key` is an orchestrator. */
    isOrchestrator: (key) => byKey.has(key),
    /** Whether the chat `key` is a connected orchestrator's executor. */
    isExecutor: (key) => [...byKey.values()].some((link) => link.executor === key && !link.disconnected),
    /** The orchestrators' agents (descriptors that say they can be one). */
    agents: () => [...runtimes.values()].filter((runtime) => runtime.agent.orchestrator).map((runtime) => runtime.name)
  };
}
