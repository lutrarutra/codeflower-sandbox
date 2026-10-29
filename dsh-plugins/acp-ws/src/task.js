import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agentEnvironment, createRecorder, endChild } from './server.js';
import { createSessionStore, sessionKey, writeJsonAtomically } from './sessions.js';

// A task runs the agent without VS Code: the runner is its ACP client. It
// sets the task as the agent's goal, answers what a user would (permissions
// allowed, questions declined), and asks after each round whether the task is
// done, as goal outcomes reach only some clients.

export const EXIT_CODES = { completed: 0, failed: 1, unmet: 2, not_signed_in: 3, cancelled: 130 };

const DEFAULT_ROUNDS = 3;
// The launcher stops the sandbox 15 s after asking; the turn's end must be recorded before.
const CANCEL_GRACE_MS = 8_000;
const STATUS_PATTERN = /TASK_STATUS:\s*(complete|incomplete|impossible)\b[\s:—–-]*(.*)/i;

export const STATUS_PROMPT = [
  'Before this run ends: is the task completely done?',
  'Answer with exactly one line and do nothing else:',
  'TASK_STATUS: complete | incomplete | impossible — one sentence why'
].join('\n');

/**
 * The task instructions for a run: {{output}} is replaced, and
 * {{#report}}…{{/report}} is kept only with a report, {{^report}}…{{/report}}
 * only without.
 */
export function renderInstructions(template, { output, report }) {
  return template
    .replace(/\{\{([#^])report\}\}([\s\S]*?)\{\{\/report\}\}/g, (_, kind, body) =>
      (kind === '#') === report ? body : ''
    )
    .replaceAll('{{output}}', output)
    .replace(/\n{3,}/g, '\n\n');
}

/** The last TASK_STATUS line of an answer, or `unknown`. */
export function parseStatus(text) {
  const lines = text.split('\n').filter((line) => STATUS_PATTERN.test(line));
  const match = lines.length ? STATUS_PATTERN.exec(lines.at(-1)) : null;
  if (!match) return { status: 'unknown', reason: text.trim().slice(0, 300) };
  return { status: match[1].toLowerCase(), reason: match[2].trim() };
}

function reportPath(task) {
  return join(task.output, 'report.html');
}

/** What the agent is asked first: its goal when it has one, else the task itself. */
export function firstPrompt(task, { goal, instructions, systemPrompt }) {
  const done = task.report ? `\n\nDone only when a finalized storyteller report of the work is at ${reportPath(task)}.` : '';
  const condition = `${task.task.trim()}${done}`;
  if (goal && condition.length <= goal.maxLength) return { text: `/goal ${condition}`, goal: true };
  const preface = systemPrompt ? '' : `${instructions}\n\n# The task\n\n`;
  return { text: `${preface}${condition}`, goal: false };
}

/**
 * The session settings a task asks for: the model and effort by their
 * category, which all three agents share, and others by their id.
 */
export function requestedSettings(task) {
  const wanted = [];
  if (task.model) wanted.push({ category: 'model', flag: '--model', value: task.model });
  if (task.effort) wanted.push({ category: 'thought_level', flag: '--effort', value: task.effort });
  for (const [id, value] of Object.entries(task.options ?? {})) wanted.push({ id, flag: `--option ${id}`, value });
  return wanted;
}

// A select option's values, also inside groups (dsh groups models by provider).
function choices(option) {
  return (option.options ?? []).flatMap((choice) => choice.options ?? [choice]);
}

// How a value is named on the command line: dsh's are [provider, model].
function valueName(value) {
  return Array.isArray(value) ? String(value.at(-1)) : String(value);
}

/** The choice of a config option that a command-line value names, if any. */
export function findChoice(option, wanted) {
  const name = wanted.toLowerCase();
  return choices(option).find((choice) =>
    [valueName(choice.value), Array.isArray(choice.value) ? choice.value.join('/') : '', choice.name ?? ''].some(
      (candidate) => candidate.toLowerCase() === name
    )
  );
}

/** The model, effort and other settings a session runs with, by name. */
export function currentSettings(configOptions, ids = []) {
  const settings = {};
  for (const option of configOptions) {
    const key = option.category === 'model' ? 'model' : option.category === 'thought_level' ? 'effort' : option.id;
    if (key === 'model' || key === 'effort' || ids.includes(option.id)) settings[key] = valueName(option.currentValue);
  }
  return settings;
}

function continuePrompt(first, reason) {
  if (first.goal) return first.text;
  return `The task is not done yet${reason ? ` (${reason})` : ''}. Continue working on it until it is.`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Runs `storyteller check` on the report, if it is there. */
function checkReport(path, environment) {
  const storyteller = join(environment.VIRTUAL_ENV ?? '/codeflower-state/env/venv', 'bin', 'storyteller');
  return new Promise((resolve) => {
    const child = spawn(storyteller, ['check', path], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', (error) => resolve({ ok: false, output: error.message }));
    child.once('close', (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

// The most permissive option the agent offers: nobody is there to choose.
function allowOption(options = []) {
  return (
    options.find((option) => option.kind === 'allow_always') ??
    options.find((option) => option.kind === 'allow_once') ??
    options[0]
  );
}

/** One line of progress for an update, or undefined. */
function describeUpdate(update) {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content?.type === 'text' ? update.content.text : undefined;
    case 'tool_call':
      return `\n▸ ${update.title ?? update.kind ?? 'tool'}\n`;
    case 'plan':
      return `\n▸ plan: ${(update.entries ?? []).map((entry) => entry.content).join(' · ')}\n`;
    default:
      return undefined;
  }
}

/**
 * Runs one task to its end and returns its result; the result is also written
 * next to the task file as result.json.
 */
export async function runTask({
  agentName,
  agent,
  taskFile,
  sessionsDirectory,
  instanceId,
  workspace,
  instructionsTemplate,
  environment = process.env,
  signal,
  out = process.stdout,
  log = (message) => process.stderr.write(`${message}\n`)
}) {
  const task = JSON.parse(await readFile(taskFile, 'utf8'));
  const resultFile = join(dirname(taskFile), 'result.json');
  const startedAt = new Date().toISOString();
  const result = { status: 'failed', agent: agentName, startedAt, rounds: 0 };
  const finish = async (fields) => {
    Object.assign(result, fields, { endedAt: new Date().toISOString() });
    await writeJsonAtomically(resultFile, result);
    return result;
  };

  if (!(await agent.signedIn())) {
    return finish({
      status: 'not_signed_in',
      message: `${agent.label} is not signed in for this project. Start "codeflower interactive" for it, connect VS Code and sign in once.`
    });
  }

  const instructions = renderInstructions(instructionsTemplate, task);
  const store = createSessionStore({ directory: sessionsDirectory, instanceId, harness: agentName, log });
  const recorder = createRecorder(store, log);
  const command = await agent.command();
  const child = spawn(command[0], command.slice(1), {
    env: agentEnvironment(environment, agent.env),
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const calls = new Map();
  let nextId = 1;
  let sessionId;
  let turnText = '';
  let ended;
  const agentEnded = new Promise((resolve) => (ended = resolve));
  child.once('error', (error) => ended(error));
  child.once('close', (code, sig) => ended(new Error(`${agentName} exited (${sig ?? `status ${code}`})`)));

  const write = (message) => {
    recorder.fromClient(message);
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const call = (method, params) => {
    const id = `task-${nextId++}`;
    const reply = new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
    write({ jsonrpc: '2.0', id, method, params });
    return Promise.race([reply, agentEnded.then((error) => Promise.reject(error))]);
  };

  const answer = (message) => {
    if (message.method === 'session/request_permission') {
      const option = allowOption(message.params?.options);
      const title = message.params?.toolCall?.title;
      if (title) out.write(`  (allowed: ${title})\n`);
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    if (message.method === 'elicitation/create') {
      out.write('  (question declined: nobody is there to answer)\n');
      return { action: 'decline' };
    }
    return undefined;
  };

  const fromAgent = (message) => {
    recorder.fromAgent(message);
    if (message.method === undefined) {
      const pending = calls.get(message.id);
      if (!pending) return;
      calls.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'ACP error'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      const update = message.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        turnText += update.content.text;
      }
      const text = describeUpdate(update);
      if (text) out.write(text);
      return;
    }
    if (message.id !== undefined) {
      const response = answer(message);
      write(
        response === undefined
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
          : { jsonrpc: '2.0', id: message.id, result: response }
      );
    }
  };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const frame = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!frame) continue;
      try {
        fromAgent(JSON.parse(frame));
      } catch (error) {
        log(`Invalid ACP frame from ${agentName}: ${error.message}`);
      }
    }
  });

  // Runs one turn. A cancel asks the agent to stop and waits a little for the
  // turn's end, so the transcript records it.
  const prompt = async (text) => {
    turnText = '';
    if (signal?.aborted) return { stopReason: 'cancelled', text: '' };
    out.write(`\n━━ ${text.split('\n')[0].slice(0, 120)}\n`);
    const turn = call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    let timer;
    let onAbort;
    const cancelled = new Promise((resolve) => {
      onAbort = () => {
        write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
        timer = setTimeout(resolve, CANCEL_GRACE_MS, { stopReason: 'cancelled' });
      };
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const done = await Promise.race([turn, cancelled]);
      return { stopReason: done?.stopReason ?? null, text: turnText };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      out.write('\n');
    }
  };

  let settled;
  const settle = (fields) => (settled ??= close(fields));
  const close = async (fields) => {
    await recorder.flush().catch(() => {});
    await recorder.closeAll();
    await recorder.flush().catch(() => {});
    endChild(child);
    if (sessionId) fields.sessionKey = sessionKey(agentName, sessionId);
    return finish(fields);
  };

  try {
    const initialized = await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'codeflower-task', version: '1' }
    });
    const systemPrompt = Boolean(initialized?.agentCapabilities?.sessionCapabilities?.systemPrompt);
    const session = await call('session/new', {
      cwd: workspace,
      mcpServers: [],
      ...(systemPrompt ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] } } : {})
    });
    sessionId = session.sessionId;

    // The model first: it can change which efforts there are.
    const wanted = requestedSettings(task);
    let configOptions = session.configOptions ?? [];
    for (const want of wanted) {
      const option = configOptions.find((candidate) =>
        want.id ? candidate.id === want.id : candidate.category === want.category
      );
      if (!option) {
        const what = want.id
          ? `setting ${want.id} (it has ${configOptions.map((candidate) => candidate.id).join(', ') || 'none'})`
          : want.category === 'model'
            ? 'model choice'
            : 'effort setting';
        return await settle({ status: 'failed', message: `${want.flag}: ${agent.label} has no ${what}` });
      }
      const choice = findChoice(option, want.value);
      if (!choice) {
        const offered = choices(option).map((candidate) => valueName(candidate.value)).join(', ');
        return await settle({ status: 'failed', message: `${want.flag} ${want.value}: ${agent.label} offers ${offered}` });
      }
      const updated = await call('session/set_config_option', { sessionId, configId: option.id, value: choice.value });
      configOptions = updated?.configOptions ?? configOptions;
    }
    result.settings = currentSettings(
      configOptions,
      wanted.filter((want) => want.id).map((want) => want.id)
    );
    const described = Object.entries(result.settings).map(([key, value]) => `${key} ${value}`).join(' · ');
    if (described) out.write(`${described}\n`);

    const first = firstPrompt(task, { goal: agent.goal, instructions, systemPrompt });
    if (agent.goal && !first.goal) log('The task is too long for a goal; it runs as a plain prompt.');
    const rounds = Number.isInteger(task.maxRounds) && task.maxRounds > 0 ? task.maxRounds : DEFAULT_ROUNDS;
    let next = first.text;
    for (let round = 1; ; round += 1) {
      result.rounds = round;
      const work = await prompt(next);
      if (signal?.aborted || work.stopReason === 'cancelled') return await settle({ status: 'cancelled', stopReason: work.stopReason });
      if (work.stopReason !== 'end_turn') {
        return await settle({ status: 'failed', stopReason: work.stopReason, message: `The agent stopped: ${work.stopReason}` });
      }

      const check = await prompt(STATUS_PROMPT);
      if (signal?.aborted || check.stopReason === 'cancelled') return await settle({ status: 'cancelled', stopReason: check.stopReason });
      let { status, reason } = parseStatus(check.text);
      const report = task.report ? { path: reportPath(task), exists: await exists(reportPath(task)) } : undefined;
      if (status === 'complete' && report && !report.exists) {
        status = 'incomplete';
        reason = `there is no report at ${report.path}`;
      }
      if (report?.exists && (status === 'complete' || status === 'impossible' || round >= rounds)) {
        const checked = await checkReport(report.path, environment);
        Object.assign(report, { checked: checked.ok, check: checked.output });
        if (status === 'complete' && !checked.ok) {
          status = 'incomplete';
          reason = `storyteller check failed${checked.output ? `: ${checked.output}` : ''}`;
        }
      }
      if (status === 'complete' || status === 'impossible' || round >= rounds) {
        return await settle({
          status: status === 'complete' ? 'completed' : 'unmet',
          stopReason: work.stopReason,
          message: status === 'complete' || status === 'impossible' ? reason : `Still not done after ${round} rounds: ${reason}`,
          ...(report ? { report } : {})
        });
      }
      out.write(`\n━━ not done yet (${reason}); round ${round + 1} of ${rounds}\n`);
      next = continuePrompt(first, reason);
    }
  } catch (error) {
    return await settle({ status: signal?.aborted ? 'cancelled' : 'failed', message: error.message });
  }
}
