import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findChoice, firstPrompt, parseStatus, renderInstructions, requestedSettings, runTask } from '../src/task.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const template = 'Headless.{{#report}} Report to {{output}}/report.html.{{/report}}{{^report}} No report.{{/report}}';

function fakeAgentDefinition(options = {}) {
  const { signedIn = true, args = [] } = options;
  const goal = 'goal' in options ? options.goal : { maxLength: 4000 };
  return {
    label: 'Fake',
    async command() {
      return [process.execPath, fakeAgent, ...args];
    },
    env: {},
    goal,
    async signedIn() {
      return signedIn;
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
  // A stand-in for the venv's storyteller command.
  const venv = join(root, 'venv');
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(venv, 'bin', 'storyteller'), `#!/bin/sh\necho "checked $2"\nexit ${checkExit}\n`);
  await chmod(join(venv, 'bin', 'storyteller'), 0o755);
  const taskFile = join(taskDirectory, 'task.json');
  await writeFile(taskFile, JSON.stringify({ output, report: true, maxRounds: 2, ...task }));
  return { root, output, taskFile, venv };
}

async function run(t, task, agentOptions, extra = {}) {
  const { checkExit = 0, ...runOptions } = extra;
  const context = await setup(t, task, checkExit);
  let printed = '';
  const result = await runTask({
    agentName: 'claude',
    agent: fakeAgentDefinition(agentOptions),
    taskFile: context.taskFile,
    sessionsDirectory: join(context.root, 'sessions'),
    instanceId: 'instance-1',
    workspace: join(context.root, 'workspace'),
    instructionsTemplate: template,
    environment: { ...process.env, VIRTUAL_ENV: context.venv },
    out: { write: (text) => (printed += text) },
    log: () => {},
    ...runOptions
  });
  const written = JSON.parse(await readFile(join(context.root, 'tasks', 'one', 'result.json'), 'utf8'));
  assert.deepEqual(written, result);
  return { ...context, result, printed };
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

test('an agent without a system prompt gets the instructions in its first prompt', async (t) => {
  const { root, result } = await run(t, { task: 'task: cluster', report: false }, { goal: undefined, args: ['--no-system-prompt'] });
  assert.equal(result.status, 'completed');
  assert.equal(result.report, undefined);
  const entries = await transcript(root, result.sessionKey);
  assert.equal(entries[0].prompt[0].text, 'Headless. No report.\n\n# The task\n\ntask: cluster');
});

test('a task that stays unfinished ends unmet after its rounds', async (t) => {
  const { root, result } = await run(t, { task: 'task: never done' });
  assert.equal(result.status, 'unmet');
  assert.equal(result.rounds, 2);
  assert.match(result.message, /after 2 rounds: more to do/);
  const prompts = (await transcript(root, result.sessionKey)).filter((entry) => entry.kind === 'prompt');
  // Goal, status check, goal again, status check.
  assert.equal(prompts.length, 4);
  assert.equal(prompts[2].prompt[0].text, prompts[0].prompt[0].text);
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
