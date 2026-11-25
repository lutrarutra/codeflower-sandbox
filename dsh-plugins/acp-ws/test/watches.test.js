import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { resolvePath } from '../src/files.js';
import { startBridge } from '../src/server.js';
import { createWatches, endNotice, endSummary } from '../src/watches.js';
import { addWatchNeed, create as createIdea, endWatchNeeds, readAll as readIdeas } from '../src/roots-store.js';
import { WatchError, defaultName, formatDuration, parseDuration, parseUntil, readStart, verdictOf } from '../src/watch-rules.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const watchCommand = fileURLToPath(new URL('../../../bin/codeflower-watch', import.meta.url));
const token = 'w'.repeat(43);
const FAST = { minEveryMs: 10, noticeDelayMs: 30, runTimeoutMs: 2000, killGraceMs: 100 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await sleep(20);
  }
}

test('reads durations and conditions, and judges runs', () => {
  assert.equal(parseDuration('90'), 90_000);
  assert.equal(parseDuration('1h30m'), 90 * 60_000);
  assert.equal(parseDuration('0.5s'), 500);
  assert.equal(parseDuration('5 minutes'), undefined);
  assert.equal(formatDuration(90 * 60_000), '1h30m');
  assert.deepEqual(parseUntil(), { kind: 'exit' });
  assert.deepEqual(parseUntil('match:MERGED|CLOSED'), { kind: 'match', pattern: 'MERGED|CLOSED' });
  assert.throws(() => parseUntil('match:('), WatchError);
  assert.throws(() => parseUntil('soon'), /Unknown condition/);

  const exit = { kind: 'exit' };
  assert.equal(verdictOf(exit, { exitCode: 0 }), 'met');
  assert.equal(verdictOf(exit, { exitCode: 1 }), 'waiting');
  assert.equal(verdictOf(exit, { exitCode: 127 }), 'error');
  assert.equal(verdictOf(exit, { exitCode: 0, timedOut: true }), 'error');
  const match = parseUntil('match:"state": *"MERGED"');
  assert.equal(verdictOf(match, { exitCode: 0, output: '{"state": "OPEN"}' }), 'waiting');
  assert.equal(verdictOf(match, { exitCode: 0, output: '{"state": "MERGED"}' }), 'met');
  assert.equal(verdictOf(match, { exitCode: 1, output: '{"state": "MERGED"}' }), 'error');
  const change = { kind: 'change' };
  assert.equal(verdictOf(change, { exitCode: 0, output: 'a' }, undefined), 'waiting');
  assert.equal(verdictOf(change, { exitCode: 0, output: 'a' }, 'a'), 'waiting');
  assert.equal(verdictOf(change, { exitCode: 0, output: 'b' }, 'a'), 'met');

  assert.throws(() => readStart({ command: 'x', every: '1s' }), /at least 10s/);
  assert.throws(() => readStart({ command: ' ' }), /Which command/);
  assert.throws(() => readStart({ command: 'x', timeout: '30d' }), /at most 7d/);
  const spec = readStart({ command: 'gh pr view 12 --json state', wait: true });
  assert.equal(spec.every, 60_000);
  assert.equal(spec.wait, 85_000);
  assert.equal(spec.name, 'gh pr view');
  assert.equal(defaultName('/usr/bin/test -f done.flag'), 'test done.flag');
});

test('tells what ended, with the last output', () => {
  const watch = {
    id: 'w-00000001',
    name: 'PR 12',
    command: 'gh pr view 12',
    until: { kind: 'match', pattern: 'MERGED' },
    every: 120_000,
    state: 'met',
    runs: 4,
    started: '2026-11-25T10:00:00.000Z',
    ended: '2026-11-25T10:06:00.000Z',
    lastRun: { exitCode: 0, verdict: 'met' },
    lastOutput: 'state: MERGED\n',
    log: '/codeflower-state/watches/w-00000001/output.log'
  };
  const text = endNotice([watch]);
  assert.match(text, /^A watch you started ended:\n- PR 12 \(w-00000001\): met, its condition was met \(4 runs in 6m\)\./);
  assert.match(text, /Until: match:MERGED, every 2m/);
  assert.match(text, /```\nstate: MERGED\n```/);
  assert.match(text, /codeflower-watch logs w-00000001/);
  assert.equal(endSummary([watch, { ...watch, name: 'b', state: 'failing' }]), 'PR 12 met, b failing');
});

async function watchesIn(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-watches-')));
  const told = [];
  const lists = [];
  const watches = createWatches({
    directory: join(directory, 'watches'),
    workspace: directory,
    tell: (chat, text, title, summary) => told.push({ chat, text, title, summary }),
    changed: (list) => lists.push(list),
    keyOf: (agent, sessionId) => `${agent}-${sessionId}`,
    ...FAST,
    ...options
  });
  // Closed (its writes done) before its folder goes.
  t.after(async () => {
    await watches.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { watches, directory, told, lists };
}

const chat = { agent: 'claude', sessionId: 's1', key: 'claude-s1' };

test('runs until the condition holds, then tells the chat once', async (t) => {
  const { watches, directory, told, lists } = await watchesIn(t);
  const flag = join(directory, 'done.flag');
  const started = await watches.handle(chat, { action: 'start', command: `test -f ${flag}`, every: 0.05, cwd: directory });
  assert.equal(started.ok, true);
  assert.equal(started.run.verdict, 'waiting');
  assert.equal(started.watch.state, 'watching');
  assert.equal(started.watch.key, 'claude-s1');
  assert.equal(watches.active('claude', 's1'), true);
  await until(async () => (await watches.handle(chat, { action: 'show', id: started.watch.id })).runs.length >= 3);

  await writeFile(flag, '');
  await until(() => told.length);
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].chat, { agent: 'claude', sessionId: 's1' });
  assert.equal(told[0].title, 'Watch ended');
  assert.match(told[0].summary, /met$/);
  assert.equal(watches.active('claude', 's1'), false);
  assert.equal(lists.at(-1)[0].state, 'met');

  // The log holds every run, with how each read.
  const log = await until(async () => {
    const text = await readFile(started.watch.log, 'utf8');
    return /── met · /.test(text) && text;
  });
  assert.match(log, /── run 1 · .* ──\n── exit 1 · not yet · /);
  assert.match(log, /── exit 0 · met · .*\n\n── met · /);
  await sleep(100);
  assert.equal(told.length, 1);
});

test('a first run that is an error does not start, and errors in a row end the watch', async (t) => {
  const { watches, directory, told } = await watchesIn(t);
  const typo = await watches.handle(chat, { action: 'start', command: 'no-such-command-here', every: 0.05 });
  assert.equal(typo.watch.state, 'failing');
  assert.equal(typo.run.exitCode, 127);
  assert.match(typo.run.output, /not found/);

  // Fine at first, then failing: told once it failed MAX_FAILURES times.
  const counter = join(directory, 'count');
  await writeFile(counter, '');
  const command = `echo x >> ${counter}; [ $(wc -l < ${counter}) -lt 2 ] && exit 1; exit 3`;
  const flaky = await watches.handle(chat, { action: 'start', command, every: 0.03 });
  assert.equal(flaky.run.verdict, 'waiting');
  await until(() => told.length);
  assert.match(told[0].text, /failing, its command failed: 3 runs in a row failed \(exit 3\)/);
  assert.equal(told.length, 1, 'the typo was the command\'s own answer, never told');
});

test('the match and change conditions, the per-chat limit, and stopping', async (t) => {
  const { watches, directory, told } = await watchesIn(t);
  const file = join(directory, 'state');
  await writeFile(file, 'OPEN\n');
  const match = await watches.handle(chat, { action: 'start', command: `cat ${file}`, until: 'match:MERGED|CLOSED', every: 0.03, name: 'pr' });
  const change = await watches.handle(chat, { action: 'start', command: `cat ${file}`, until: 'change', every: 0.03 });
  assert.equal(match.watch.name, 'pr');
  assert.equal(change.watch.state, 'watching');
  await sleep(100);
  assert.equal(told.length, 0);
  await writeFile(file, 'MERGED\n');
  // Both end; close together they are told in one notice (a loaded machine may part them).
  await until(() => told.flatMap((each) => each.text.match(/^- /gm) ?? []).length === 2);
  if (told.length === 1) assert.equal(told[0].title, 'Watches ended');
  const toldBefore = told.length;

  for (let index = 0; index < 8; index++) {
    const started = await watches.handle(chat, { action: 'start', command: 'exit 1', every: 10 });
    assert.equal(started.ok, true);
  }
  const ninth = await watches.handle(chat, { action: 'start', command: 'exit 1', every: 10 });
  assert.match(ninth.error, /At most 8 watches/);
  // Another chat has its own.
  assert.equal((await watches.handle({ ...chat, sessionId: 's2', key: 'claude-s2' }, { action: 'start', command: 'exit 1', every: 10 })).ok, true);
  assert.equal((await watches.handle(chat, { action: 'list' })).watches.filter((watch) => watch.state === 'watching').length, 8);
  assert.equal((await watches.handle(chat, { action: 'list', all: true })).watches.filter((watch) => watch.state === 'watching').length, 9);

  // The agent stops its own: no notice. The user stops one: the chat hears.
  const stopped = await watches.handle(chat, { action: 'stop', all: true });
  assert.equal(stopped.stopped.length, 8);
  const other = (await watches.handle(undefined, { action: 'list' })).watches.find((watch) => watch.sessionId === 's2');
  watches.stop(other.id);
  await until(() => told.length === toldBefore + 1);
  assert.match(told.at(-1).text, /stopped, the user stopped it/);
  assert.deepEqual(told.at(-1).chat, { agent: 'claude', sessionId: 's2' });
  assert.equal(watches.count(), 0);
});

test('a subagent\'s watch tells its parent; a caller waits for the end', async (t) => {
  const { watches, directory, told } = await watchesIn(t);
  const flag = join(directory, 'flag');
  const subagent = { agent: 'claude', sessionId: 'child', parent: 's1', key: 'claude-s1' };
  const waiting = watches.handle(subagent, { action: 'start', command: `test -f ${flag}`, every: 0.03, wait: 20 });
  // Once its first run has read "not yet" (a loaded machine runs it slowly).
  await until(() => watches.snapshot()[0]?.state === 'watching' && watches.snapshot()[0].runs >= 1 && !watches.snapshot()[0].running);
  await writeFile(flag, '');
  const answer = await waiting;
  assert.equal(answer.waited, 'ended');
  assert.equal(answer.watch.state, 'met');
  assert.equal(answer.watch.sessionId, 's1');
  await sleep(100);
  assert.equal(told.length, 0, 'the caller had the answer');

  // The wait runs out: it keeps watching, and the chat hears later.
  await rm(flag);
  const short = await watches.handle(chat, { action: 'start', command: `test -f ${flag}`, every: 0.03, wait: 0.1 });
  assert.equal(short.waited, 'waiting');
  assert.equal(short.watch.state, 'watching');
  // A caller that goes away (killed) leaves it watching too.
  const gone = new AbortController();
  const waited = watches.handle(chat, { action: 'wait', id: short.watch.id, wait: 20 }, { signal: gone.signal });
  gone.abort();
  assert.equal((await waited).waited, 'gone');
  await writeFile(flag, '');
  await until(() => told.length);
  assert.equal(told[0].summary, `test flag met`);
});

test('a new bridge marks the watches it finds running as lost, without telling', async (t) => {
  const { watches, directory } = await watchesIn(t);
  const started = await watches.handle(chat, { action: 'start', command: 'exit 1', every: 10 });
  // As if the bridge were killed: the record still says watching.
  const record = await until(() =>
    readFile(join(directory, 'watches', started.watch.id, 'watch.json'), 'utf8').then(JSON.parse, () => undefined)
  );
  assert.equal(record.state, 'watching');
  const told = [];
  const next = createWatches({ directory: join(directory, 'watches'), workspace: directory, tell: (...args) => told.push(args), ...FAST });
  await next.ready;
  const [lost] = next.snapshot();
  assert.equal(lost.id, started.watch.id);
  assert.equal(lost.state, 'lost');
  assert.equal(told.length, 0);
  // Windows may read its output, as a batch job's.
  const resolved = await resolvePath(lost.log, { workspace: join(directory, 'workspace'), privateDirectory: directory });
  assert.equal(resolved.real, lost.log);
  await next.close();
});

test('a watch an idea waits for is its need: blocked meanwhile, met and active again when the condition holds', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-watch-roots-')));
  const roots = join(directory, 'roots');
  createIdea(roots, { title: 'Rerun with the fixed loader', status: 'active' });
  createIdea(roots, { title: 'Write it up', status: 'active', needs: [{ text: 'Reviewer sign-off', met: false }] });
  const told = [];
  const ideas = {
    exists: (id) => readIdeas(roots).ideas.some((idea) => idea.id === id),
    link: (chat, id, watch) => addWatchNeed(roots, id, watch, { chat }),
    ended: (watch) => endWatchNeeds(roots, watch.id, watch.state)
  };
  const watches = createWatches({ directory: join(directory, 'watches'), workspace: directory, tell: (...args) => told.push(args), ideas, ...FAST });
  t.after(async () => {
    await watches.close();
    await rm(directory, { recursive: true, force: true });
  });
  const idea = (id) => readIdeas(roots).ideas.find((each) => each.id === id);
  const flag = join(directory, 'merged');

  assert.match((await watches.handle(chat, { action: 'start', command: 'exit 1', idea: 9 })).error, /There is no idea 9/);
  // Met at once: no need is left behind.
  const atOnce = await watches.handle(chat, { action: 'start', command: 'true', idea: 1 });
  assert.equal(atOnce.watch.state, 'met');
  assert.equal(idea(1).needs.length, 0);

  const started = await watches.handle(chat, { action: 'start', command: `test -f ${flag}`, every: 0.03, name: 'PR 12 merged', idea: '#1' });
  assert.equal(started.watch.idea, 1);
  assert.equal(idea(1).status, 'blocked');
  assert.deepEqual(idea(1).needs, [{ watch: started.watch.id, text: 'PR 12 merged', met: false, log: started.watch.log }]);
  assert.equal(idea(1).chats.at(-1).sessionId, 's1');

  // A second, linked to an idea with another open need: it stays blocked once the watch is met.
  const other = await watches.handle(chat, { action: 'start', command: `test -f ${flag}`, every: 0.03 });
  await watches.handle(chat, { action: 'link', id: other.watch.id, idea: 2 });
  assert.equal(idea(2).status, 'blocked');

  await writeFile(flag, '');
  const said = () => told.map((each) => each[1]).join('\n');
  await until(() => said().includes('#1 Rerun') && said().includes('#2 Write it up'));
  assert.equal(idea(1).status, 'active');
  assert.equal(idea(1).needs[0].met, true);
  assert.equal(idea(2).status, 'blocked');
  assert.match(said(), /Roots: idea #1 Rerun with the fixed loader had it as a need, now met; the idea is active again\./);
  assert.match(said(), /Roots: idea #2 Write it up had it as a need, now met; the idea is still blocked by other needs\./);
  const toldBefore = told.length;

  // One that fails: the need stays open, marked, and the notice says what to do.
  const failing = await watches.handle(chat, { action: 'start', command: 'exit 1', every: 10, idea: 2 });
  watches.stop(failing.watch.id);
  await until(() => told.length === toldBefore + 1);
  const need = idea(2).needs.find((each) => each.watch === failing.watch.id);
  assert.equal(need.met, false);
  assert.equal(need.ended, 'stopped');
  assert.match(told.at(-1)[1], /idea #2 Write it up still needs it \(marked stopped\): rearm it/);
});

test('rearm: a timed-out watch starts again as it was, its Roots need waiting again in its place', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-watch-rearm-')));
  const roots = join(directory, 'roots');
  createIdea(roots, { title: 'Rerun with the fixed loader', status: 'active', needs: [{ text: 'Data from the core', met: true }] });
  const told = [];
  const ideas = {
    exists: (id) => readIdeas(roots).ideas.some((idea) => idea.id === id),
    link: (chat, id, watch) => addWatchNeed(roots, id, watch, { chat }),
    ended: (watch) => endWatchNeeds(roots, watch.id, watch.state)
  };
  const watches = createWatches({ directory: join(directory, 'watches'), workspace: directory, tell: (...args) => told.push(args), ideas, ...FAST });
  t.after(async () => {
    await watches.close();
    await rm(directory, { recursive: true, force: true });
  });
  const idea = () => readIdeas(roots).ideas[0];
  const flag = join(directory, 'flag');

  const started = await watches.handle(chat, { action: 'start', command: `test -f ${flag}`, every: 0.03, timeout: 0.2, name: 'PR 12', idea: 1 });
  const id = started.watch.id;
  await until(() => told.length);
  assert.match(told[0][1], /- PR 12 \(w-[0-9a-f]{8}\): timeout/);
  assert.match(told[0][1], new RegExp(`codeflower-watch rearm ${id} \\[--timeout TIME\\]\` restarts it as it was\\.`));
  assert.match(told[0][1], /idea #1 Rerun with the fixed loader still needs it \(marked timeout\): rearm it/);
  assert.equal(idea().needs[1].ended, 'timeout');
  // The agent unblocked the idea meanwhile; re-arming blocks it again, the need in the same place.
  const runs = (await watches.handle(chat, { action: 'show', id })).watch.runs;
  const again = await watches.handle(chat, { action: 'rearm', id, timeout: '30s' });
  assert.equal(again.ok, true);
  assert.equal(again.watch.id, id);
  assert.equal(again.watch.state, 'watching');
  assert.equal(again.watch.timeout, 30_000);
  assert.equal(again.watch.rearms, 1);
  assert.equal(again.watch.runs, runs + 1);
  assert.equal(again.run.verdict, 'waiting');
  assert.equal(idea().status, 'blocked');
  assert.equal(idea().needs.length, 2);
  assert.deepEqual(idea().needs[1], { watch: id, text: 'PR 12', met: false, log: started.watch.log });
  await until(async () => /── rearmed · /.test(await readFile(started.watch.log, 'utf8')));
  assert.match(await readFile(started.watch.log, 'utf8'), /── timeout: after 200ms · .*\n[\s\S]*── rearmed · .* · every 30ms until exit, for at most 30s ──/);

  // On a running watch, rearm only moves its deadline.
  const deadline = Date.parse(again.watch.deadline);
  await sleep(20);
  const moved = await watches.handle(chat, { action: 'rearm', id });
  assert.ok(Date.parse(moved.watch.deadline) > deadline);
  assert.equal(moved.watch.rearms, 2);

  await writeFile(flag, '');
  await until(() => told.length === 2);
  assert.equal(idea().status, 'active');
  assert.match((await watches.handle(chat, { action: 'rearm', id })).error, /ended with its condition met/);
});

test('check runs the command now; rearm changes how a watch runs and resets it', async (t) => {
  const { watches, directory, told } = await watchesIn(t);
  const file = join(directory, 'state');
  await writeFile(file, 'OPEN\n');
  const started = await watches.handle(chat, { action: 'start', command: `cat ${file}`, until: 'match:MERGED', every: 60 });
  const id = started.watch.id;
  const next = Date.parse(started.watch.nextRun);

  // The agent checks: not yet, and the next run counts from now.
  await sleep(20);
  const checked = await watches.handle(chat, { action: 'check', id });
  assert.equal(checked.run.verdict, 'waiting');
  assert.equal(checked.watch.runs, 2);
  assert.ok(Date.parse(checked.watch.nextRun) > next);

  // A new interval and condition: from a clean slate, the next run from now.
  const changed = await watches.handle(chat, { action: 'rearm', id, every: 0.03, until: 'change' });
  assert.equal(changed.watch.every, 30);
  assert.equal(changed.watch.until, 'change');
  assert.equal(changed.watch.state, 'watching');
  await until(async () => (await watches.handle(chat, { action: 'show', id })).runs.length >= 2);
  // `change` compares with the first run after the reset ("OPEN"), not with what came before.
  await writeFile(file, 'MERGED\n');
  await until(() => told.length);
  assert.match(told[0].text, /: met, its condition was met/);
  assert.match(await readFile(started.watch.log, 'utf8'), /── checked now, by the agent ──[\s\S]*── rearmed · .* · every 30ms, until change, reset, for at most 1d from now ──/);
  assert.match((await watches.handle(chat, { action: 'check', id })).error, /has ended \(met\)/);
  assert.match((await watches.handle(chat, { action: 'rearm', id: started.watch.id, every: '1s' })).error, /ended with its condition met/);

  // The agent's check that meets it: the answer is the check's, no notice.
  await writeFile(file, 'OPEN\n');
  const second = await watches.handle(chat, { action: 'start', command: `cat ${file}`, until: 'match:MERGED', every: 60 });
  await writeFile(file, 'MERGED\n');
  const met = await watches.handle(chat, { action: 'check', id: second.watch.id });
  assert.equal(met.run.verdict, 'met');
  assert.equal(met.watch.state, 'met');
  await sleep(100);
  assert.equal(told.length, 1);

  // The user's check that meets it: the chat is told.
  await writeFile(file, 'OPEN\n');
  const third = await watches.handle(chat, { action: 'start', command: `cat ${file}`, until: 'match:MERGED', every: 60 });
  await writeFile(file, 'MERGED\n');
  assert.equal((await watches.checkNow(third.watch.id)).run.verdict, 'met');
  await until(() => told.length === 2);
  assert.match((await watches.handle(chat, { action: 'rearm', id: 'w-00000000' })).error, /No watch w-00000000/);
  // A bad option changes nothing.
  const fourth = await watches.handle(chat, { action: 'start', command: 'exit 1', every: 60 });
  assert.match((await watches.handle(chat, { action: 'rearm', id: fourth.watch.id, timeout: '2h', until: 'soon' })).error, /Unknown condition/);
  assert.equal((await watches.handle(chat, { action: 'show', id: fourth.watch.id })).watch.timeout, 86_400_000);
});

// ---- through the bridge, with codeflower-watch ----

async function startWatchBridge(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-watch-bridge-')));
  const state = join(directory, 'state');
  const workspace = join(state, 'workspace');
  await mkdir(workspace, { recursive: true });
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const watchSocket = join(directory, 'watch.sock');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-test',
    sessionsDirectory: join(state, 'sessions'),
    workspace,
    agents: { claude: agents.claude },
    environment,
    watchSocket,
    watchesTiming: FAST,
    showSocket: join(directory, 'show.sock'),
    browserSocket: join(directory, 'browser.sock'),
    chatsSocket: join(directory, 'chats.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  const watch = (sessionId, args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [watchCommand, ...args],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CODEFLOWER_WATCH_SOCKET: watchSocket,
            CODEFLOWER_AGENT_NAME: 'claude',
            ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {})
          }
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
    });
  return { bridge, watch, workspace, state };
}

test('codeflower-watch starts a watch the windows list and stop, and the chat hears when it ends', async (t) => {
  const { bridge, watch, workspace, state } = await startWatchBridge(t);
  const chat = await open(bridge.address, 'claude');
  const window = await open(bridge.address);
  t.after(() => {
    chat.close();
    window.close();
  });
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(chat, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;
  assert.deepEqual((await call(window, '_codeflower/status')).result.watches, { active: 0 });

  // The command checks what the bridge would refuse.
  const bad = await watch(sessionId, ['start', '--until', 'soon', '--', 'true']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Unknown condition "soon"/);

  // The watched command's own options stay its own.
  const started = await watch(sessionId, ['start', '--every', '0.05', '--name', 'flag', 'test', '-f', 'done.flag']);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /First run: exit 1, not yet/);
  assert.match(started.stdout, /Started w-[0-9a-f]{8} \(flag\): runs every 50ms until exit/);
  const id = /Started (w-[0-9a-f]{8})/.exec(started.stdout)[1];
  const changed = await receive(window, (message) => message.method === '_codeflower/watches/changed' && message.params.watches.some((each) => each.id === id));
  const listed = changed.params.watches.find((each) => each.id === id);
  assert.equal(listed.key, `claude-${sessionId}`);
  assert.equal(listed.cwd, workspace);
  assert.equal(listed.log, join(state, 'watches', id, 'output.log'));
  assert.match((await watch(sessionId, ['list'])).stdout, new RegExp(`${id} {2}flag {2}every 50ms until exit`));
  assert.match((await watch(sessionId, ['show', 'flag'])).stdout, /Command: test -f done.flag/);
  // Windows read its output as a file.
  const read = await call(window, '_codeflower/files/read', { path: listed.log });
  assert.match(Buffer.from(read.result.data, 'base64').toString('utf8'), /── run 1/);

  // It ends: the chat hears with a notice of the bridge's.
  await writeFile(join(workspace, 'done.flag'), '');
  const told = await receive(chat, (message) => message.method === '_codeflower/prompted');
  assert.match(told.params.prompt[0].text, new RegExp(`A watch you started ended:\\n- flag \\(${id}\\): met`));
  assert.deepEqual(told.params.prompt[0]._meta['codeflower/notice'], { title: 'Watch ended', summary: 'flag met' });
  assert.match((await watch(sessionId, ['logs', id, '--run', '1'])).stdout, /^── run 1 · .*\n── exit 1 · not yet/);

  // A window stops one; --wait holds the command until then.
  const waiting = watch(sessionId, ['start', '--every', '0.05', '--wait', '10s', '--', 'exit 1']);
  const fresh = (each) => each.id !== id && each.state === 'watching';
  const running = await receive(window, (message) => message.method === '_codeflower/watches/changed' && message.params.watches.some(fresh));
  const other = running.params.watches.find(fresh);
  const stopped = await call(window, '_codeflower/watches/stop', { id: other.id });
  assert.equal(stopped.result.watch.state, 'stopped');
  const waited = await waiting;
  assert.equal(waited.code, 1);
  assert.match(waited.stdout, /ended: stopped after \d+ runs/);
  assert.equal((await call(window, '_codeflower/watches/list')).result.watches.length, 2);
});

test('without the worker (a run task), start runs the watch in the foreground', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-watch-task-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await new Promise((resolve) =>
    execFile(process.execPath, [watchCommand, 'start', '--every', '10s', '--', 'true'], { cwd: directory, env: { ...process.env, CODEFLOWER_WATCH_SOCKET: '' } }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr })
    )
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /runs in the foreground/);
  assert.match(result.stdout, /ended: met after 1 runs/);
});

function track(socket) {
  socket.inbox = [];
  socket.waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = socket.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) socket.inbox.push(message);
    else socket.waiters.splice(index, 1)[0].resolve(message);
  });
  return socket;
}

function receive(socket, predicate) {
  const index = socket.inbox.findIndex(predicate);
  if (index !== -1) return Promise.resolve(socket.inbox.splice(index, 1)[0]);
  return new Promise((resolve) => socket.waiters.push({ predicate, resolve }));
}

let nextId = 1;
async function call(socket, method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return receive(socket, (message) => message.id === id && message.method === undefined);
}

async function open(address, agent) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp${agent ? `?agent=${agent}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
  await once(socket, 'open');
  return track(socket);
}
