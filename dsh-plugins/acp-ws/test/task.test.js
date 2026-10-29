import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  continuationKind,
  continuationPrompt,
  findChoice,
  firstPrompt,
  parseStatus,
  renderInstructions,
  requestedSettings,
  runTask
} from '../src/task.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const fakePty = fileURLToPath(new URL('../fixtures/fake-pty.js', import.meta.url));
const template = 'Headless.{{#report}} Report to {{output}}/report.html.{{/report}}{{^report}} No report.{{/report}}';
const templateDirectory = fileURLToPath(new URL('../../../templates/task/', import.meta.url));
const templates = {
  instructions: template,
  continue: await readFile(join(templateDirectory, 'continue.md'), 'utf8'),
  wrapUp: await readFile(join(templateDirectory, 'wrap-up.md'), 'utf8')
};

function fakeAgentDefinition(options = {}) {
  const { signedIn = true, args = [], usageFd } = options;
  const goal = 'goal' in options ? options.goal : { maxLength: 4000 };
  return {
    label: 'Fake',
    async command() {
      return [process.execPath, fakeAgent, ...args];
    },
    env: {},
    usageFd,
    goal,
    async signedIn() {
      return typeof signedIn === 'function' ? signedIn() : signedIn;
    }
  };
}

async function setup(t, task, checkExit = 0) {
  const root = await mkdtemp(join(tmpdir(), 'codeflower-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'output');
  const taskDirectory = join(root, 'tasks', 'one');
  await mkdir(taskDirectory, { recursive: true });
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'claude-home'));
  // A stand-in for the venv's storyteller command.
  const venv = join(root, 'venv');
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(venv, 'bin', 'storyteller'), `#!/bin/sh\necho "checked $2"\nexit ${checkExit}\n`);
  await chmod(join(venv, 'bin', 'storyteller'), 0o755);
  await writeFile(join(taskDirectory, 'task.json'), JSON.stringify({ output, report: true, maxRounds: 2, ...task }));
  return { root, output, taskDirectory, venv };
}

// Runs attempt `number` (default 1) at the task of `context`.
async function attempt(context, agentOptions, extra = {}) {
  const { number = 1, attempt: fields = {}, ...runOptions } = extra;
  const attemptFile = join(context.taskDirectory, 'attempts', String(number), 'attempt.json');
  await mkdir(dirname(attemptFile), { recursive: true });
  await writeFile(attemptFile, JSON.stringify({ attempt: number, ...fields }));
  const claudeHome = join(context.root, 'claude-home');
  const signedIn =
    agentOptions?.signedIn === 'login-file'
      ? async () => {
          try {
            await stat(join(claudeHome, '.credentials.json'));
            return true;
          } catch {
            return false;
          }
        }
      : agentOptions?.signedIn;
  let printed = '';
  let authOutput = '';
  const result = await runTask({
    agentName: 'claude',
    agent: fakeAgentDefinition({ ...agentOptions, signedIn }),
    attemptFile,
    sessionsDirectory: join(context.root, 'sessions'),
    instanceId: 'instance-1',
    workspace: join(context.root, 'workspace'),
    templates,
    environment: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, VIRTUAL_ENV: context.venv },
    out: { write: (text) => (printed += text) },
    authOut: { write: (text) => (authOutput += text) },
    log: () => {},
    ...runOptions
  });
  const written = JSON.parse(await readFile(join(dirname(attemptFile), 'result.json'), 'utf8'));
  assert.deepEqual(written, result);
  return { ...context, result, printed, authOutput };
}

async function run(t, task, agentOptions, extra = {}) {
  const { checkExit = 0, ...rest } = extra;
  return attempt(await setup(t, task, checkExit), agentOptions, rest);
}

async function transcript(root, key) {
  const text = await readFile(join(root, 'sessions', key, 'transcript.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function agentText(entries) {
  return entries
    .filter((entry) => entry.kind === 'update' && entry.update?.sessionUpdate === 'agent_message_chunk')
    .map((entry) => entry.update.content.text)
    .join('\n');
}

test('instructions keep the report part only when a report is wanted', () => {
  assert.equal(renderInstructions(template, { output: '/data/output/x', report: true }), 'Headless. Report to /data/output/x/report.html.');
  assert.equal(renderInstructions(template, { output: '/data/output/x', report: false }), 'Headless. No report.');
});

test('the status line is read from the end of the answer', () => {
  assert.deepEqual(parseStatus('Looking.\nTASK_STATUS: complete — figures and report done'), {
    status: 'complete',
    reason: 'figures and report done'
  });
  assert.deepEqual(parseStatus('task_status: Incomplete - QC left'), { status: 'incomplete', reason: 'QC left' });
  assert.equal(parseStatus('I think so').status, 'unknown');
});

test('a task becomes a goal unless it is too long or the agent has none', () => {
  const task = { task: 'task: cluster', output: '/data/output/r', report: true };
  assert.equal(
    firstPrompt(task, { goal: { maxLength: 4000 }, instructions: 'I', systemPrompt: true }).text,
    '/goal task: cluster\n\nDone only when a finalized storyteller report of the work is at /data/output/r/report.html.'
  );
  const long = firstPrompt({ ...task, task: 'x'.repeat(5000) }, { goal: { maxLength: 4000 }, instructions: 'I', systemPrompt: true });
  assert.equal(long.goal, false);
  const plain = firstPrompt({ ...task, report: false }, { goal: undefined, instructions: 'I', systemPrompt: false });
  assert.deepEqual(plain, { text: 'I\n\n# The task\n\ntask: cluster', goal: false });
});

test('a task runs as a recorded session, with permissions allowed and questions declined', async (t) => {
  const { root, output, result, printed } = await run(t, { task: 'task: cluster the cells' });
  assert.equal(result.status, 'completed');
  assert.equal(result.rounds, 1);
  assert.equal(result.sessionKey, 'claude-session-1');
  assert.deepEqual(result.report, {
    path: join(output, 'report.html'),
    exists: true,
    checked: true,
    check: `checked ${join(output, 'report.html')}`
  });
  assert.match(printed, /allowed: Run analysis\.py/);

  const entries = await transcript(root, result.sessionKey);
  assert.equal(entries[0].kind, 'prompt');
  assert.match(entries[0].prompt[0].text, /^\/goal task: cluster the cells/);
  assert.deepEqual(entries.find((entry) => entry.kind === 'permission_outcome').outcome, {
    outcome: 'selected',
    optionId: 'always'
  });
  assert.equal(entries.find((entry) => entry.kind === 'question_outcome').action, 'decline');
  assert.match(agentText(entries), /system prompt given/);
  assert.match(agentText(entries), /TASK_STATUS: complete/);

  // The session is released for VS Code to continue it.
  await assert.rejects(stat(join(root, 'sessions', result.sessionKey, 'lease.json')));
});

test('attached task progress is structured and includes usage and quota updates', async (t) => {
  const { result, printed } = await run(t, { task: 'task: use tokens', report: false, progress: 'json' });
  const events = printed.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.every((event) => event.codeflowerTask));
  assert.ok(events.some((event) => event.type === 'text'));
  assert.ok(events.some((event) => event.type === 'settings'));
  const stats = events.filter((event) => event.type === 'stats').at(-1).usage;
  assert.equal(stats.auth.plan, 'max');
  assert.equal(stats.totals.tokens.totalTokens, 170);
  assert.equal(stats.totals.cost.amount, 0.25);
  assert.equal(stats.limits[0].label, '5-hour');
  assert.equal(result.usage.totals.tokens.totalTokens, 170);
});

test('attached task progress includes dsh token reports from its usage pipe', async (t) => {
  const { result } = await run(
    t,
    { task: 'task: use tokens', report: false, progress: 'json' },
    { usageFd: 3 }
  );
  assert.equal(result.usage.totals.tokens.totalTokens, 19);
});

test('an agent without a system prompt gets the instructions in its first prompt', async (t) => {
  const { root, result } = await run(t, { task: 'task: cluster', report: false }, { goal: undefined, args: ['--no-system-prompt'] });
  assert.equal(result.status, 'completed');
  assert.equal(result.report, undefined);
  const entries = await transcript(root, result.sessionKey);
  assert.equal(entries[0].prompt[0].text, 'Headless. No report.\n\n# The task\n\ntask: cluster');
});

test('a task that stays unfinished wraps up and ends unmet after its rounds', async (t) => {
  const { root, result } = await run(t, { task: 'task: never done' });
  assert.equal(result.status, 'unmet');
  assert.equal(result.rounds, 2);
  assert.equal(result.wrapUp.reason, 'rounds');
  assert.match(result.message, /after 2 rounds; wrapped up: more to do/);
  const prompts = (await transcript(root, result.sessionKey)).filter((entry) => entry.kind === 'prompt');
  // Goal, status check, goal again, status check, wrap-up, status check.
  assert.equal(prompts.length, 6);
  assert.equal(prompts[2].prompt[0].text, prompts[0].prompt[0].text);
  assert.match(prompts[4].prompt[0].text, /^This run is out of rounds\. Do not start new work/);
  assert.match(prompts[4].prompt[0].text, /storyteller check reports\/task\.html/);
});

test('a task whose time is almost up is cut short and wraps up', async (t) => {
  const { root, result, printed } = await run(t, { task: 'task: hang, never done', report: false }, undefined, {
    attempt: { wrapUpAt: new Date(Date.now() + 300).toISOString() }
  });
  assert.equal(result.status, 'unmet');
  assert.equal(result.rounds, 1);
  assert.equal(result.wrapUp.reason, 'time');
  assert.match(result.message, /^The time limit was near; wrapped up: more to do/);
  assert.match(printed, /wrapping up: the time is almost up/);
  const entries = await transcript(root, result.sessionKey);
  assert.equal(entries.find((entry) => entry.kind === 'turn_end').stopReason, 'cancelled');
  const prompts = entries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.prompt[0].text);
  assert.match(prompts[1], /^This run's time is almost up\./);
  assert.match(prompts[1], /README\.md/);
});

test('a missing report keeps the task going', async (t) => {
  const { result } = await run(t, { task: 'task: but write no report file' });
  assert.equal(result.status, 'unmet');
  assert.match(result.message, /no report at/);
  assert.equal(result.report.exists, false);
});

test('a report that fails storyteller check is not marked completed', async (t) => {
  const { result } = await run(t, { task: 'task: cluster' }, undefined, { checkExit: 1 });
  assert.equal(result.status, 'unmet');
  assert.match(result.message, /storyteller check failed: checked .+\/report\.html/);
  assert.equal(result.report.checked, false);
  assert.match(result.report.check, /checked .+\/report\.html/);
});

test('an impossible task ends at once', async (t) => {
  const { result } = await run(t, { task: 'task: impossible' });
  assert.equal(result.status, 'unmet');
  assert.equal(result.rounds, 1);
  assert.equal(result.message, 'the data is missing');
});

test('a task stops when its agent is not signed in', async (t) => {
  const { result } = await run(t, { task: 'task: x' }, { signedIn: false });
  assert.equal(result.status, 'not_signed_in');
  assert.match(result.message, /codeflower interactive/);
});

test('a task signs in through the agent terminal method before it starts', async (t) => {
  const { result, authOutput, printed } = await run(
    t,
    { task: 'task: cluster', progress: 'json' },
    { signedIn: 'login-file' },
    {
      interactive: true,
      ptyHelper: [process.execPath, fakePty],
      input: Readable.from(['LOGIN-CODE\n'])
    }
  );
  assert.equal(result.status, 'completed');
  assert.match(authOutput, /Starting Claude Subscription/);
  assert.match(authOutput, /Paste code here if prompted/);
  assert.match(authOutput, /Signed in\. Starting the task/);
  const authProgress = printed
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'auth-start' || event.type === 'auth-end')
    .map((event) => event.type);
  assert.deepEqual(authProgress, ['auth-start', 'auth-end']);
});

test('cancelling a task ends its turn and records it', async (t) => {
  const aborting = new AbortController();
  setTimeout(() => aborting.abort(), 300);
  const { root, result } = await run(t, { task: 'task: hang' }, undefined, { signal: aborting.signal });
  assert.equal(result.status, 'cancelled');
  const entries = await transcript(root, result.sessionKey);
  assert.equal(entries.at(-1).kind, 'turn_end');
  assert.equal(entries.at(-1).stopReason, 'cancelled');
  assert.deepEqual(await readdir(join(root, 'sessions', result.sessionKey)), ['meta.json', 'transcript.jsonl']);
});

test('model and effort are found by category, other settings by id', () => {
  assert.deepEqual(requestedSettings({ model: 'opus', effort: 'high', options: { fast: 'on' } }), [
    { category: 'model', flag: '--model', value: 'opus' },
    { category: 'thought_level', flag: '--effort', value: 'high' },
    { id: 'fast', flag: '--option fast', value: 'on' }
  ]);
  assert.deepEqual(requestedSettings({}), []);
  const grouped = {
    options: [{ group: 'acme', options: [{ value: ['acme', 'large'], name: 'Acme Large' }] }]
  };
  for (const name of ['large', 'acme/large', 'Acme Large', 'LARGE']) {
    assert.deepEqual(findChoice(grouped, name)?.value, ['acme', 'large'], name);
  }
  assert.equal(findChoice(grouped, 'small'), undefined);
});

test('a task sets the model before the effort and reports what it ran with', async (t) => {
  const { root, result, printed } = await run(
    t,
    { task: 'task: cluster', model: 'small', effort: 'Medium', options: { mode: 'plan' } },
    { args: ['--models'] }
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.settings, { mode: 'plan', effort: 'medium', model: 'small' });
  assert.match(printed, /mode plan · effort medium · model small/);
  assert.ok((await transcript(root, result.sessionKey)).length > 0);
});

test('a setting the agent does not offer stops the task before any prompt', async (t) => {
  // The small model has no high effort.
  const { result } = await run(t, { task: 'task: x', model: 'small', effort: 'high' }, { args: ['--models'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.message, '--effort high: Fake offers low, medium');
  assert.equal(result.rounds, 0);

  const missing = await run(t, { task: 'task: x', model: 'large' });
  assert.equal(missing.result.message, '--model: Fake has no model choice');
  const unknown = await run(t, { task: 'task: x', options: { turbo: 'on' } });
  assert.equal(unknown.result.message, '--option turbo: Fake has no setting turbo (it has mode, effort)');
});

test('a continuation says why the session continues', () => {
  const task = { task: 'task: cluster', output: '/data/output/x', report: true };
  const render = (kind, extra = {}) => continuationPrompt(templates.continue, { kind, task, instructions: 'Headless.', ...extra });
  assert.equal(continuationKind(undefined, { status: 'completed' }), 'restart');
  assert.equal(continuationKind({}, undefined), 'interrupted');
  assert.equal(continuationKind({}, { status: 'cancelled' }), 'interrupted');
  assert.equal(continuationKind({}, { status: 'not_signed_in' }), 'error');
  assert.equal(continuationKind({}, { status: 'unmet' }), 'unmet');
  assert.equal(continuationKind({}, { status: 'completed' }), 'completed');

  assert.match(render('interrupted'), /was interrupted before it finished/);
  assert.match(render('error', { message: 'Usage limit reached.' }), /because of an error: Usage limit reached\./);
  assert.match(render('unmet', { message: 'Still not done after 3 rounds.' }), /before the task was done: Still not done after 3 rounds\./);
  assert.match(render('completed'), /go over it again: check the results and the report/);
  const followUp = render('completed', { followUp: 'Also {{plot}} the genes' });
  assert.match(followUp, /# Follow-up request from the user\n\nAlso \{\{plot\}\} the genes/);
  assert.doesNotMatch(followUp, /go over it again/);
  for (const text of [render('interrupted'), followUp]) {
    assert.match(text, /# The original task\n\ntask: cluster/);
    assert.match(text, /report of the work is at \/data\/output\/x\/report\.html/);
    assert.match(text, /\(repeated\)\n\nHeadless\.$/);
    assert.doesNotMatch(text.replace('{{plot}}', ''), /\{\{/);
  }
});

test('a task records its session before it works, and a later attempt continues it', async (t) => {
  const context = await setup(t, { task: 'task: cluster the cells' });
  const first = await attempt(context);
  assert.equal(first.result.status, 'completed');
  assert.equal(first.result.attempt, 1);
  const sessionFile = join(context.taskDirectory, 'session.json');
  const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(saved.nativeSessionId, 'session-1');
  assert.equal(saved.sessionKey, first.result.sessionKey);
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

  // Killed before it recorded a result: the next attempt continues the session.
  await rm(join(context.taskDirectory, 'attempts', '1', 'result.json'));
  const second = await attempt(context, undefined, { number: 2 });
  assert.equal(second.result.status, 'completed');
  assert.equal(second.result.attempt, 2);
  assert.equal(second.result.rounds, 1);
  assert.equal(second.result.sessionKey, first.result.sessionKey);
  assert.deepEqual(second.result.continuation, { kind: 'interrupted', followUp: false });
  assert.match(second.printed, /Continuing the session after an interruption/);

  const prompts = (await transcript(context.root, first.result.sessionKey)).filter((entry) => entry.kind === 'prompt');
  assert.equal(prompts.length, 4);
  assert.match(prompts[2].prompt[0].text, /^This `codeflower task` run continues/);
  assert.match(prompts[2].prompt[0].text, /interrupted/);
  assert.match(prompts[2].prompt[0].text, /task: cluster the cells/);
});

test('a finished task takes a follow-up, which later rounds have as their goal', async (t) => {
  const context = await setup(t, { task: 'task: cluster the cells' });
  await attempt(context);
  const { result } = await attempt(context, undefined, {
    number: 2,
    attempt: { followUp: 'task: also plot the genes, never done', maxRounds: 2 }
  });
  assert.equal(result.status, 'unmet');
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.continuation, { kind: 'completed', followUp: true });
  const prompts = (await transcript(context.root, result.sessionKey)).filter((entry) => entry.kind === 'prompt');
  assert.match(prompts[2].prompt[0].text, /# Follow-up request from the user\n\ntask: also plot the genes, never done/);
  assert.match(prompts[4].prompt[0].text, /^\/goal task: also plot the genes, never done\n\nDone only when/);
});

test('session/load continues a session when the agent has no session/resume, without recording its replay', async (t) => {
  const context = await setup(t, { task: 'task: cluster the cells' });
  await attempt(context, { args: ['--no-resume'] });
  const { result } = await attempt(context, { args: ['--no-resume'] }, { number: 2 });
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionKey, 'claude-session-1');
  const entries = await transcript(context.root, result.sessionKey);
  assert.doesNotMatch(agentText(entries), /replayed history/);
});

test('a session that cannot be continued fails the attempt instead of starting another', async (t) => {
  const context = await setup(t, { task: 'task: cluster the cells' });
  await attempt(context);
  const { result } = await attempt(context, { args: ['--resume-fails'] }, { number: 2 });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /could not continue the task's session: Session not found/);
  assert.equal(result.sessionKey, 'claude-session-1');
  assert.deepEqual(await readdir(join(context.root, 'sessions')), ['claude-session-1']);
});

test('a session open on another worker is not continued', async (t) => {
  const context = await setup(t, { task: 'task: cluster the cells' });
  await attempt(context);
  await writeFile(
    join(context.root, 'sessions', 'claude-session-1', 'lease.json'),
    JSON.stringify({ instanceId: 'vscode-worker', heartbeatAt: new Date().toISOString() })
  );
  const { result } = await attempt(context, undefined, { number: 2 });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /open on another worker \(vscode-worker\)/);
});

test('an attempt after one that never started a session starts over', async (t) => {
  const context = await setup(t, { task: 'task: cluster the cells' });
  const first = await attempt(context, { signedIn: false });
  assert.equal(first.result.status, 'not_signed_in');
  const { result, printed } = await attempt(context, undefined, { number: 2 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.continuation, { kind: 'restart', followUp: false });
  assert.match(printed, /Starting over/);
  const prompts = (await transcript(context.root, result.sessionKey)).filter((entry) => entry.kind === 'prompt');
  assert.match(prompts[0].prompt[0].text, /^\/goal task: cluster the cells/);
});
