// Claude Code's terminal UI, for tests: resumes a session (--resume), runs the
// hooks its settings name (--settings) as Claude Code does, with the event on
// stdin, and writes its transcript where Claude Code keeps it. Each line typed
// is a turn: a text answer and a Bash tool call that asks for permission.
// `other` moves it to another session (as /resume does); `quit` quits.
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
let sessionId = option('--resume');
const settings = JSON.parse(option('--settings'));
const directory = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(directory, { recursive: true });
const transcript = () => join(directory, `${sessionId}.jsonl`);
const write = (entry) => appendFileSync(transcript(), `${JSON.stringify({ sessionId, ...entry })}\n`);
const hook = (name, extra = {}) => {
  for (const { hooks } of settings.hooks[name] ?? []) {
    for (const { command } of hooks) {
      const event = { hook_event_name: name, session_id: sessionId, transcript_path: transcript(), cwd: process.cwd(), ...extra };
      execSync(command, { input: JSON.stringify(event), stdio: ['pipe', 'ignore', 'inherit'] });
    }
  }
};

process.stdout.write(`claude tui for ${sessionId} in ${option('--permission-mode') ?? 'no mode'}${option('--mcp-config') ? ' with mcp' : ''}\r\n`);
hook('SessionStart', { source: 'resume' });
let turn = 0;
createInterface({ input: process.stdin }).on('line', (typed) => {
  // A prompt typed for the user arrives as a bracketed paste.
  const line = typed.replace(/\x1b\[20[01]~/g, '').trim();
  if (!line) return;
  if (line === 'quit') {
    hook('SessionEnd', { reason: 'prompt_input_exit' });
    process.exit(0);
  }
  if (line === 'other') {
    sessionId = 'other-session';
    hook('SessionStart', { source: 'resume' });
    return;
  }
  turn += 1;
  hook('UserPromptSubmit', { prompt: line });
  write({ type: 'user', message: { role: 'user', content: line } });
  write({ type: 'assistant', message: { content: [{ type: 'text', text: `answer to ${line}` }, { type: 'tool_use', id: `tool-${turn}`, name: 'Bash', input: { command: 'ls' } }] } });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${turn}`, content: 'a.txt' }] } });
  hook('PostToolUse', { tool_name: 'Bash' });
  hook('Stop', {});
  process.stdout.write(`done ${line}\r\n`);
});
