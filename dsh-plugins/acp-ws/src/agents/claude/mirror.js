// A chat open in Claude Code's own terminal UI, mirrored for the windows.
// Claude Code cannot share a session with the ACP adapter, so the bridge hands
// the chat over (the adapter closes it) and follows the terminal UI instead:
// its hooks say when a turn starts and ends, and its transcript says what
// happened, which becomes the ACP updates the windows already show.
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TAIL_MS = 250;
const MAX_TEXT = 64 * 1024;

// Where Claude Code keeps a session's transcript: its projects folder, named
// after the working directory with everything but letters and digits as -.
export function transcriptPath(home, cwd, sessionId) {
  return join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

// ACP's tool kinds for Claude Code's tools, as its adapter reports them.
const TOOL_KINDS = {
  Bash: 'execute',
  BashOutput: 'execute',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  TodoWrite: 'think',
  ExitPlanMode: 'switch_mode'
};

function toolTitle(name, input) {
  const detail = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.description;
  return typeof detail === 'string' && detail ? `${name}: ${detail.slice(0, 200)}` : name;
}

function text(content) {
  if (typeof content === 'string') return content.slice(0, MAX_TEXT);
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .slice(0, MAX_TEXT);
}

/**
 * The ACP updates for one line of a Claude Code transcript: the assistant's
 * text, thinking and tool calls, and the tools' results. The user's own
 * messages come from the UserPromptSubmit hook, not from here.
 */
export function updatesFor(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content) || entry.isSidechain) return [];
  const updates = [];
  if (entry.type === 'assistant') {
    for (const part of content) {
      if (part?.type === 'text' && part.text) {
        updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part.text.slice(0, MAX_TEXT) } });
      } else if (part?.type === 'thinking' && part.thinking) {
        updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.thinking.slice(0, MAX_TEXT) } });
      } else if (part?.type === 'tool_use' && typeof part.id === 'string') {
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: part.id,
          title: toolTitle(part.name, part.input),
          kind: TOOL_KINDS[part.name] ?? 'other',
          status: 'in_progress',
          rawInput: part.input ?? {}
        });
      }
    }
  } else if (entry.type === 'user') {
    for (const part of content) {
      if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      const output = text(part.content);
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: part.tool_use_id,
        status: part.is_error ? 'failed' : 'completed',
        ...(output ? { content: [{ type: 'content', content: { type: 'text', text: output } }] } : {})
      });
    }
  }
  return updates;
}

/**
 * Follows a transcript from its current end, calling onUpdate with the ACP
 * update of each new entry. flush() reads what is there now (at a turn's
 * end); stop() ends it.
 */
export async function tailTranscript(path, onUpdate, { log = () => {}, intervalMs = TAIL_MS } = {}) {
  let offset = await stat(path).then((info) => info.size, () => 0);
  let partial = '';
  let reading = Promise.resolve();
  let stopped = false;

  const read = async () => {
    let handle;
    try {
      handle = await open(path, 'r');
      const { size } = await handle.stat();
      if (size < offset) offset = 0;
      if (size === offset) return;
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      partial += buffer.toString('utf8');
      let newline;
      while ((newline = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        for (const update of updatesFor(entry)) onUpdate(update);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log(`Could not follow ${path}: ${error.message}`);
    } finally {
      await handle?.close();
    }
  };
  const next = () => (reading = reading.then(read));
  const timer = setInterval(() => !stopped && void next(), intervalMs);
  timer.unref();
  return {
    flush: () => next(),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await next();
    }
  };
}

// Claude Code's hooks in its own settings (`--settings`): each runs
// codeflower-hook, which hands the event to the bridge and decides nothing.
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd'
];

export function hookSettings(hookCommand, extra = {}) {
  const hook = { type: 'command', command: hookCommand, timeout: 5 };
  const matched = new Set(['PermissionRequest', 'PostToolUse', 'PostToolUseFailure']);
  return {
    ...extra,
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [event, [{ ...(matched.has(event) ? { matcher: '*' } : {}), hooks: [hook] }]])
    )
  };
}
