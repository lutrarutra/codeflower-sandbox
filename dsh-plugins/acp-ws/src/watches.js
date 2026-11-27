// Watches (codeflower-watch): an agent's command that the bridge runs every
// so often for its chat, until a condition holds (watch-rules.js), and then
// tells the chat with a notice prompt, as a batch job's end is told. They run
// whether or not a window is connected, so an agent can end its turn instead
// of holding it in a sleep loop. A watch keeps its record and all its runs'
// output in the project state (watches/ID/watch.json and output.log), which
// windows show like a batch job's output.
//
// Watches stop with the sandbox: those a new bridge finds still running are
// marked lost, without a notice.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FINAL,
  MAX_ACTIVE_PER_CHAT,
  MAX_FAILURES,
  MIN_EVERY_MS,
  RUN_TIMEOUT_MS,
  VERDICT_TEXT,
  WatchError,
  MAX_TIMEOUT_MS,
  PID_CHECK_MS,
  followedProcesses,
  formatDuration,
  misuseOf,
  processAlive,
  parseDuration,
  parseFail,
  parseUntil,
  readStart,
  readWait,
  untilText,
  verdictOf
} from './watch-rules.js';

// Watches that end close together are told to their chat in one message.
const NOTICE_DELAY_MS = 3000;
// A run that is stopped gets this long after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 3000;
// What windows get: the active watches, and those that ended in the last day.
const RECENT_MS = 24 * 60 * 60_000;
const MAX_LISTED = 200;
// Ended watches' folders are removed after this long.
const KEEP_MS = 7 * 24 * 60 * 60_000;
// The output a watch keeps in memory (the latest run's, for the condition and the notice).
const LAST_OUTPUT_CHARS = 64 * 1024;
// Of one run's output, at most this much goes into the log.
const RUN_LOG_CHARS = 256 * 1024;
// The log is trimmed from the front once larger than this.
const LOG_BYTES = 1024 * 1024;
// Of the last output, the notice quotes at most this much.
const NOTICE_OUTPUT_CHARS = 4 * 1024;
// Of a run's stderr, kept apart (also in its output) for the first run's check.
const STDERR_CHARS = 8 * 1024;
// Runs remembered per watch for `show`.
const RUNS_KEPT = 20;

const ID = /^w-[0-9a-f]{8}$/;
const iso = (ms) => new Date(ms).toISOString();
const stamp = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
const tail = (text, chars) => (text.length > chars ? `…${text.slice(-chars)}` : text);

const STATE_TEXT = {
  met: 'its condition was met',
  failed: 'what it watched failed',
  exited: 'the processes it followed ended (their exit status is not known to the watch: read the output)',
  timeout: 'it timed out before its condition was met',
  failing: 'its command failed',
  stopped: 'the user stopped it',
  lost: 'the sandbox stopped while it ran'
};

/** What the chat is told when its watches ended. */
export function endNotice(watches) {
  const blocks = watches.map((watch) => {
    const how = watch.reason ? `${STATE_TEXT[watch.state]}: ${watch.reason}` : STATE_TEXT[watch.state];
    const ran = `${watch.runs} run${watch.runs === 1 ? '' : 's'} in ${formatDuration(Date.parse(watch.ended) - Date.parse(watch.started))}`;
    const last = watch.lastRun
      ? `Last run: exit ${watch.lastRun.exitCode}${watch.lastRun.timedOut ? ' (timed out)' : ''}, ${VERDICT_TEXT[watch.lastRun.verdict]}. Its output:\n\`\`\`\n${tail(watch.lastOutput ?? '', NOTICE_OUTPUT_CHARS).trimEnd() || '(none)'}\n\`\`\``
      : 'It did not run.';
    return [
      `- ${watch.name} (${watch.id}): ${watch.state}, ${how} (${ran}).`,
      `  Command: ${watch.command}`,
      `  Until: ${untilText(watch.until)}${watch.fail ? `, fail: ${untilText(watch.fail)}` : ''}${watch.pids?.length ? `, while process ${watch.pids.join(', ')} runs` : ''}, every ${formatDuration(watch.every)}`,
      `  ${last}`,
      `  All its output: ${watch.log} (codeflower-watch logs ${watch.id})`,
      ...(watch.state === 'met' || watch.state === 'exited' ? [] : [`  Still worth waiting for? \`codeflower-watch rearm ${watch.id} [--timeout TIME]\` restarts it as it was${watch.state === 'failing' || watch.state === 'failed' ? ', once you fixed what failed' : ''}.`]),
      ...(watch.ideas ?? []).map((idea) =>
        watch.state === 'met'
          ? `  Roots: idea #${idea.id} ${idea.title} had it as a need, now met${idea.unblocked ? '; the idea is active again' : idea.status === 'blocked' ? '; the idea is still blocked by other needs' : ''}.`
          : `  Roots: idea #${idea.id} ${idea.title} still needs it (marked ${watch.state}): rearm it (the need waits again), or change the idea.`
      )
    ].join('\n');
  });
  const intro = watches.length === 1 ? 'A watch you started ended:' : 'Watches you started ended:';
  return `${intro}\n${blocks.join('\n')}`;
}

/** The notice's line in the chat, folded: each watch's name and how it ended. */
export function endSummary(watches) {
  const each = watches.map((watch) => `${watch.name} ${watch.state}`);
  return each.length > 3 ? `${each.slice(0, 3).join(', ')} and ${each.length - 3} more` : each.join(', ');
}

/** What windows and the command get of a watch. */
function publicOf(watch) {
  return {
    id: watch.id,
    name: watch.name,
    command: watch.command,
    cwd: watch.cwd,
    every: watch.every,
    until: untilText(watch.until),
    ...(watch.fail ? { fail: untilText(watch.fail) } : {}),
    ...(watch.pids?.length ? { pids: watch.pids.map(({ pid }) => pid) } : {}),
    timeout: watch.timeout,
    state: watch.state,
    running: Boolean(watch.child),
    runs: watch.runs,
    failures: watch.failures,
    ...(watch.lastRun ? { lastRun: watch.lastRun } : {}),
    ...(watch.nextRun ? { nextRun: watch.nextRun } : {}),
    started: watch.started,
    ...(watch.rearmed ? { rearmed: watch.rearmed, rearms: watch.rearms } : {}),
    deadline: watch.deadline,
    ...(watch.ended ? { ended: watch.ended } : {}),
    ...(watch.reason ? { reason: watch.reason } : {}),
    log: watch.log,
    ...(watch.idea !== undefined ? { idea: watch.idea } : {}),
    agent: watch.agent,
    sessionId: watch.sessionId,
    ...(watch.key ? { key: watch.key } : {})
  };
}

/** What the command gets of a run: its exit status, verdict, output and stderr (both their end). */
const runAnswer = (result) => ({
  exitCode: result.exitCode,
  verdict: result.verdict,
  output: tail(result.output, 8 * 1024),
  ...(result.stderr?.trim() ? { stderr: tail(result.stderr, 4 * 1024) } : {}),
  ...(result.misuse ? { misuse: result.misuse } : {}),
  ...(result.timedOut ? { timedOut: true } : {})
});

function stopChild(child, graceMs) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Gone already.
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }, graceMs).unref?.();
}

/**
 * The bridge's side of watches.
 * - directory: where each watch keeps its record and output (the project state's watches/).
 * - workspace: where commands run when the caller's folder is gone.
 * - environmentFor(agent): the environment of the agent's commands.
 * - tell(chat, text, title, summary): a notice for the chat's next prompt.
 * - changed(watches): sends the list to the windows.
 * - ideas: Roots, for watches an idea waits for (--idea): exists(id), link(chat, id, watch) adds the
 *   watch to the idea's needs, ended(watch) marks them → [{id, title, status, unblocked}].
 */
export function createWatches({
  directory,
  workspace,
  environmentFor = () => process.env,
  tell,
  changed = () => {},
  keyOf = () => undefined,
  log = () => {},
  ideas,
  shell = '/bin/sh',
  // Tests make these short.
  minEveryMs = MIN_EVERY_MS,
  runTimeoutMs = RUN_TIMEOUT_MS,
  noticeDelayMs = NOTICE_DELAY_MS,
  killGraceMs = KILL_GRACE_MS,
  pidCheckMs = PID_CHECK_MS
}) {
  const watches = new Map();
  const notices = new Map();
  let closed = false;
  let shown = '';

  const write = (watch, text) => {
    watch.writing = watch.writing.then(() => appendFile(watch.log, text)).catch((error) => log(`watch ${watch.id}: ${error.message}`));
    return watch.writing;
  };

  const save = (watch) => {
    const record = { ...publicOf(watch), lastOutput: tail(watch.lastOutput ?? '', NOTICE_OUTPUT_CHARS) };
    const file = join(watch.folder, 'watch.json');
    watch.writing = watch.writing
      .then(async () => {
        await writeFile(`${file}.tmp`, JSON.stringify(record, null, 2));
        await rename(`${file}.tmp`, file);
      })
      .catch((error) => log(`watch ${watch.id}: ${error.message}`));
    return watch.writing;
  };

  // Keeps the log within LOG_BYTES: the latest runs, from a run's start.
  const trim = (watch) => {
    watch.writing = watch.writing
      .then(async () => {
        if ((await stat(watch.log)).size <= LOG_BYTES) return;
        const text = await readFile(watch.log, 'utf8');
        const rest = text.slice(-Math.floor(LOG_BYTES / 2));
        const start = rest.indexOf('\n── run ');
        await writeFile(`${watch.log}.tmp`, `(earlier runs were trimmed)\n${start >= 0 ? rest.slice(start + 1) : rest}`);
        await rename(`${watch.log}.tmp`, watch.log);
      })
      .catch((error) => log(`watch ${watch.id}: ${error.message}`));
  };

  const snapshot = () => {
    const now = Date.now();
    return [...watches.values()]
      .filter((watch) => !FINAL.has(watch.state) || now - Date.parse(watch.ended ?? watch.started) < RECENT_MS)
      .sort((a, b) => Date.parse(b.started) - Date.parse(a.started))
      .slice(0, MAX_LISTED)
      .map(publicOf);
  };

  const emit = () => {
    const list = snapshot();
    const signature = JSON.stringify(list.map((watch) => [watch.id, watch.state, watch.runs, watch.running]));
    if (signature === shown) return;
    shown = signature;
    changed(list);
  };

  // The ideas that need the watch hear how it ended (Roots).
  const endIdeas = (watch) => {
    if (!ideas || watch.idea === undefined) return;
    try {
      watch.ideas = ideas.ended(publicOf(watch));
    } catch (error) {
      log(`watch ${watch.id}: could not mark its need in Roots: ${error.message}`);
    }
  };

  const noticeFor = (watch) => {
    const key = `${watch.agent}\u0000${watch.sessionId}`;
    let entry = notices.get(key);
    if (!entry) {
      entry = { chat: { agent: watch.agent, sessionId: watch.sessionId }, watches: [] };
      entry.timer = setTimeout(() => {
        notices.delete(key);
        if (closed) return;
        const told = tell(entry.chat, endNotice(entry.watches), entry.watches.length === 1 ? 'Watch ended' : 'Watches ended', endSummary(entry.watches));
        if (told === false) log(`Could not tell ${keyOf(watch.agent, watch.sessionId) ?? watch.sessionId} that its watches ended`);
      }, noticeDelayMs);
      entry.timer.unref?.();
      notices.set(key, entry);
    }
    entry.watches.push({ ...publicOf(watch), until: watch.until, fail: watch.fail, lastOutput: watch.lastOutput, ideas: watch.ideas });
  };

  // Ends a watch. notify: false when whoever ended it already knows (the
  // agent stopped it, or the command that waits for it gets the answer).
  const finish = (watch, state, { reason, notify = true } = {}) => {
    if (FINAL.has(watch.state)) return;
    watch.state = state;
    watch.ended = iso(Date.now());
    if (reason) watch.reason = reason;
    delete watch.nextRun;
    clearTimeout(watch.timer);
    clearTimeout(watch.deadlineTimer);
    clearInterval(watch.pidTimer);
    const line = `\n── ${state}${reason ? `: ${reason}` : ''} · ${stamp(Date.now())} ──\n`;
    if (watch.child) {
      watch.endLine = line;
      stopChild(watch.child, killGraceMs);
    } else {
      void write(watch, line);
    }
    const waited = watch.waiters.size > 0;
    for (const waiter of [...watch.waiters]) waiter.resolve('ended');
    void save(watch);
    endIdeas(watch);
    emit();
    if (notify && !waited && state !== 'lost' && !closed) noticeFor(watch);
  };

  // One run of the command: its exit status and (the end of) its output.
  const execute = (watch) =>
    new Promise((resolve) => {
      let output = '';
      let stderr = '';
      let logged = 0;
      let timedOut = false;
      let done = false;
      const end = (exitCode) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        watch.child = undefined;
        resolve({ exitCode, output: output.slice(-LAST_OUTPUT_CHARS), stderr: stderr.slice(-STDERR_CHARS), timedOut });
      };
      let child;
      try {
        child = spawn(shell, ['-c', watch.command], {
          cwd: watch.cwd,
          env: { ...environmentFor(watch.agent), PAGER: 'cat', GIT_PAGER: 'cat' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        });
      } catch (error) {
        output = `${error.message}\n`;
        void write(watch, output);
        return end(127);
      }
      watch.child = child;
      const take = (text) => {
        output += text;
        if (output.length > LAST_OUTPUT_CHARS * 2) output = output.slice(-LAST_OUTPUT_CHARS);
        if (logged < RUN_LOG_CHARS) {
          const part = text.slice(0, RUN_LOG_CHARS - logged);
          logged += part.length;
          void write(watch, logged >= RUN_LOG_CHARS ? `${part}\n(the rest of this run's output is left out of the log)\n` : part);
        }
      };
      for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8');
      child.stdout.on('data', take);
      child.stderr.on('data', (text) => {
        if (stderr.length < STDERR_CHARS * 2) stderr += text;
        take(text);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        stopChild(child, killGraceMs);
      }, runTimeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        take(`${error.message}\n`);
        if (child.pid === undefined) end(127);
      });
      child.on('close', (code, signal) => end(code ?? (signal ? 128 + (constants.signals[signal] ?? 15) : 1)));
    });

  // One run; the run going on is `watch.current`, which a check asked meanwhile waits for.
  const runOnce = (watch, options) => {
    const run = runNow(watch, options).finally(() => {
      if (watch.current === run) delete watch.current;
    });
    watch.current = run;
    return run;
  };

  // first: the run that starts or re-arms it, whose stderr must not say that the command is wrong.
  const runNow = async (watch, { first = false } = {}) => {
    const number = ++watch.runs;
    const startedAt = Date.now();
    delete watch.nextRun;
    void write(watch, `${number > 1 ? '\n' : ''}── run ${number} · ${stamp(startedAt)} ──\n`);
    const running = execute(watch);
    emit();
    const result = await running;
    const misuse = first ? misuseOf(result.stderr) : undefined;
    const verdict = misuse ? 'error' : verdictOf(watch.until, result, watch.baseline, watch.fail);
    if (watch.until.kind === 'change' && watch.baseline === undefined && verdict !== 'error') watch.baseline = result.output;
    const ms = Date.now() - startedAt;
    watch.lastOutput = result.output;
    watch.lastRun = { run: number, at: iso(startedAt), exitCode: result.exitCode, verdict, ms, ...(result.timedOut ? { timedOut: true } : {}) };
    watch.history.push(watch.lastRun);
    if (watch.history.length > RUNS_KEPT) watch.history.shift();
    watch.failures = verdict === 'error' ? watch.failures + 1 : 0;
    const exit = result.timedOut ? `stopped after ${formatDuration(runTimeoutMs)}` : `exit ${result.exitCode}`;
    void write(watch, `${result.output && !result.output.endsWith('\n') ? '\n' : ''}── ${exit} · ${VERDICT_TEXT[verdict]}${misuse ? ` (its stderr says the command is wrong: ${misuse})` : ''} · ${formatDuration(ms)} ──\n`);
    if (watch.endLine) {
      void write(watch, watch.endLine);
      delete watch.endLine;
    }
    trim(watch);
    if (!FINAL.has(watch.state)) void save(watch);
    return { ...result, verdict, ...(misuse ? { misuse } : {}) };
  };

  const schedule = (watch) => {
    if (closed || FINAL.has(watch.state) || watch.ending) return;
    watch.nextRun = iso(Date.now() + watch.every);
    watch.timer = setTimeout(() => void tick(watch), watch.every);
    watch.timer.unref?.();
    emit();
  };

  const tick = async (watch) => {
    if (closed || FINAL.has(watch.state)) return;
    afterRun(watch, await runOnce(watch));
  };

  // What a run means for the watch: met, failing, or the next run. notify: false when whoever
  // asked for the run gets the answer itself (the agent's check).
  const afterRun = (watch, result, { notify = true } = {}) => {
    if (FINAL.has(watch.state)) return;
    if (result.verdict === 'met') finish(watch, 'met', { notify });
    else if (result.verdict === 'failed') finish(watch, 'failed', { reason: failReason(watch), notify });
    else if (watch.failures >= MAX_FAILURES) {
      finish(watch, 'failing', { reason: `${MAX_FAILURES} runs in a row failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})`, notify });
    } else schedule(watch);
  };

  const failReason = (watch) => `its output matched ${untilText(watch.fail)}`;

  // --pid: every pidCheckMs (not only at its runs), whether its processes still run. When none
  // does, the command runs once more, for the output at the end, and the watch ends: failed or
  // met if that run says so, else exited.
  const followPids = (watch) => {
    clearInterval(watch.pidTimer);
    if (!watch.pids?.length || FINAL.has(watch.state)) return;
    watch.pidTimer = setInterval(() => void checkPids(watch), pidCheckMs);
    watch.pidTimer.unref?.();
  };

  const checkPids = async (watch) => {
    if (closed || FINAL.has(watch.state) || watch.ending || !watch.pids?.length) return;
    if (watch.pids.some(({ pid, start }) => processAlive(pid, start))) return;
    watch.ending = true;
    clearInterval(watch.pidTimer);
    clearTimeout(watch.timer);
    delete watch.nextRun;
    try {
      if (watch.current) await watch.current;
      if (FINAL.has(watch.state)) return;
      const which = watch.pids.map(({ pid }) => pid).join(', ');
      void write(watch, `\n── process ${which} ended: one last run ──\n`);
      const result = await runOnce(watch);
      if (FINAL.has(watch.state)) return;
      if (result.verdict === 'failed') finish(watch, 'failed', { reason: failReason(watch) });
      else if (result.verdict === 'met') finish(watch, 'met');
      else finish(watch, 'exited', { reason: `process ${which} ended` });
    } finally {
      delete watch.ending;
    }
  };

  // How the first run (of a start or a re-arm) ends the watch, if it does: met or failed at once, or an error.
  const afterFirst = (watch, first) => {
    if (FINAL.has(watch.state)) return true;
    if (first.verdict === 'met') finish(watch, 'met', { notify: false });
    else if (first.verdict === 'failed') finish(watch, 'failed', { reason: failReason(watch), notify: false });
    else if (first.verdict === 'error') {
      finish(watch, 'failing', { reason: first.misuse ? `the first run's stderr says the command is wrong: ${first.misuse}` : 'the first run failed', notify: false });
    } else return false;
    return true;
  };

  /**
   * Runs a watch's command now, rather than at its next run, which then counts from this one; a
   * run going on already is the answer. `by`: the agent (codeflower-watch check), which gets the
   * answer itself, or the user (a window), after whose check a met watch is told to the chat.
   */
  const check = async (watch, by = 'agent') => {
    if (FINAL.has(watch.state)) throw new WatchError(`${watch.name} has ended (${watch.state})${watch.state === 'met' ? '' : ': rearm it first'}`);
    if (watch.current) {
      const result = await watch.current;
      return { result, watch };
    }
    clearTimeout(watch.timer);
    delete watch.nextRun;
    void write(watch, `\n── checked now, by ${by === 'agent' ? 'the agent' : 'the user'} ──\n`);
    const result = await runOnce(watch);
    afterRun(watch, result, { notify: by !== 'agent' });
    return { result, watch };
  };

  // Holds a caller until the watch ends, at most ms, or its command goes away.
  const waitFor = (watch, ms, signal) => {
    if (FINAL.has(watch.state)) return Promise.resolve('ended');
    if (signal?.aborted) return Promise.resolve('gone');
    return new Promise((resolve) => {
      const waiter = {
        resolve(outcome) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', gone);
          watch.waiters.delete(waiter);
          resolve(outcome);
        }
      };
      const gone = () => waiter.resolve('gone');
      const timer = setTimeout(() => waiter.resolve('waiting'), ms);
      signal?.addEventListener('abort', gone, { once: true });
      watch.waiters.add(waiter);
    });
  };

  // An idea id from a request: checked against Roots, as the watch should not start for an idea that is not there.
  const readIdea = (value) => {
    if (value === undefined || value === null) return undefined;
    const id = Number(String(value).replace(/^#/, ''));
    if (!Number.isInteger(id) || id < 1) throw new WatchError(`"${value}" is not an idea id`);
    if (!ideas) throw new WatchError('Roots is not available here, so a watch cannot be an idea\'s need');
    if (!ideas.exists(id)) throw new WatchError(`There is no idea ${id} (codeflower-roots tree)`);
    return id;
  };

  const linkIdea = (chat, watch, id) => {
    try {
      ideas.link(chat, id, publicOf(watch));
      watch.idea = id;
      void save(watch);
      emit();
      return true;
    } catch (error) {
      log(`watch ${watch.id}: could not add it to idea ${id}: ${error.message}`);
      return error.message;
    }
  };

  const usableFolder = async (folder) => {
    if (typeof folder !== 'string' || !folder) return workspace;
    try {
      return (await stat(folder)).isDirectory() ? folder : workspace;
    } catch {
      return workspace;
    }
  };

  const ofChat = (chat, watch) => chat && watch.agent === chat.agent && watch.sessionId === (chat.parent ?? chat.sessionId);

  // A watch by its id, or by its name among the chat's (the latest first).
  const find = (chat, reference) => {
    if (typeof reference !== 'string' || !reference) throw new WatchError('Which watch? Give its id (codeflower-watch list)');
    if (watches.has(reference)) return watches.get(reference);
    const named = [...watches.values()]
      .filter((watch) => watch.name === reference && (!chat || ofChat(chat, watch)))
      .sort((a, b) => Number(FINAL.has(a.state)) - Number(FINAL.has(b.state)) || Date.parse(b.started) - Date.parse(a.started));
    if (named.length) return named[0];
    throw new WatchError(`No watch ${reference} (codeflower-watch list)`);
  };

  const start = async (chat, request, signal) => {
    if (!chat) throw new WatchError("A watch tells the chat it runs for, and this command's chat is not known: run codeflower-watch in a chat's turn");
    const spec = readStart(request, { minEveryMs });
    const pids = followedProcesses(spec.pids);
    const idea = readIdea(request.idea);
    const sessionId = chat.parent ?? chat.sessionId;
    const active = [...watches.values()].filter((watch) => ofChat(chat, watch) && !FINAL.has(watch.state)).length;
    if (active >= MAX_ACTIVE_PER_CHAT) throw new WatchError(`At most ${MAX_ACTIVE_PER_CHAT} watches run in a chat: stop one first (codeflower-watch list)`);
    const id = `w-${randomBytes(4).toString('hex')}`;
    const folder = join(directory, id);
    await mkdir(folder, { recursive: true });
    const now = Date.now();
    const watch = {
      id,
      name: spec.name,
      command: spec.command,
      cwd: await usableFolder(request.cwd),
      every: spec.every,
      until: spec.until,
      ...(spec.fail ? { fail: spec.fail } : {}),
      ...(pids.length ? { pids } : {}),
      timeout: spec.timeout,
      state: 'watching',
      runs: 0,
      failures: 0,
      started: iso(now),
      deadline: iso(now + spec.timeout),
      folder,
      log: join(folder, 'output.log'),
      agent: chat.agent,
      sessionId,
      key: chat.key ?? keyOf(chat.agent, sessionId),
      history: [],
      lastOutput: '',
      waiters: new Set(),
      writing: Promise.resolve()
    };
    await writeFile(watch.log, `codeflower-watch ${watch.name}: ${watch.command}\nevery ${formatDuration(watch.every)} until ${untilText(watch.until)}${watch.fail ? `, failed on ${untilText(watch.fail)}` : ''}, for at most ${formatDuration(watch.timeout)}\n\n`);
    watches.set(id, watch);
    arm(watch, now);
    log(`${watch.key ?? sessionId} started watch ${id} (${watch.name}), every ${formatDuration(watch.every)} until ${untilText(watch.until)}`);

    // The first run, at once: the caller sees its output and whether it reads as meant.
    const first = await runOnce(watch, { first: true });
    // (Unless a window stopped it meanwhile.)
    if (!afterFirst(watch, first)) {
      // It waits: the idea it is for needs it (only now, so a watch that ends at once leaves no need).
      if (idea !== undefined) linkIdea(chat, watch, idea);
      schedule(watch);
      followPids(watch);
    }
    const run = runAnswer(first);
    if (!spec.wait || FINAL.has(watch.state)) return { ok: true, watch: publicOf(watch), run };
    const waited = await waitFor(watch, spec.wait, signal);
    return { ok: true, watch: publicOf(watch), run, waited, ...(FINAL.has(watch.state) ? { output: tail(watch.lastOutput, 8 * 1024) } : {}) };
  };

  // Gives up on it after its timeout, from `now`.
  const arm = (watch, now) => {
    clearTimeout(watch.deadlineTimer);
    watch.deadline = iso(now + watch.timeout);
    watch.deadlineTimer = setTimeout(() => finish(watch, 'timeout', { reason: `after ${formatDuration(watch.timeout)}` }), watch.timeout);
    watch.deadlineTimer.unref?.();
  };

  /**
   * Re-arms a watch: one that ended without its condition met (timeout, failing, stopped, lost)
   * starts again as it was, with the same id, log and Roots need, which waits again; a running one
   * gets its timeout from now. `--timeout` may change how long. Cheaper for the user to follow than a
   * new watch each time, and the agent's notice offers it.
   */
  const rearm = async (chat, request) => {
    if (!chat) throw new WatchError("A watch tells the chat it runs for, and this command's chat is not known: run codeflower-watch in a chat's turn");
    const watch = find(chat, request.id);
    if (watch.state === 'met') throw new WatchError(`${watch.name} ended with its condition met: start a new watch to wait for something else`);
    if (watch.state === 'exited') throw new WatchError(`${watch.name} ended with the processes it followed: start a new watch (with the new --pid) to follow others`);
    // Every option checked before anything changes.
    const timeout = request.timeout === undefined ? undefined : parseDuration(request.timeout);
    if (request.timeout !== undefined && !timeout) throw new WatchError(`--timeout does not read: ${request.timeout} (e.g. 2h, 3d)`);
    if (timeout > MAX_TIMEOUT_MS) throw new WatchError(`--timeout is at most ${formatDuration(MAX_TIMEOUT_MS)}`);
    // How it runs may change too; a new condition starts from a clean slate.
    const every = request.every === undefined ? undefined : parseDuration(request.every);
    if (request.every !== undefined && !every) throw new WatchError(`--every does not read: ${request.every} (e.g. 30s, 5m, 1h)`);
    if (every !== undefined && every < minEveryMs) throw new WatchError(`--every is at least ${formatDuration(minEveryMs)}`);
    const until = request.until === undefined ? undefined : parseUntil(request.until);
    const fail = request.fail === undefined ? undefined : parseFail(request.fail);
    if (timeout !== undefined) watch.timeout = timeout;
    if (every !== undefined) watch.every = every;
    if (until) watch.until = until;
    if (fail) watch.fail = fail;
    // --reset (or a new condition): no errors counted, and `change` compares with the next run.
    if (request.reset || until) {
      watch.failures = 0;
      delete watch.baseline;
      watch.history = [];
    }
    const now = Date.now();
    watch.rearmed = iso(now);
    watch.rearms = (watch.rearms ?? 0) + 1;
    const changes = [
      every !== undefined ? `every ${formatDuration(watch.every)}` : '',
      until ? `until ${untilText(watch.until)}` : '',
      fail ? `fail on ${untilText(watch.fail)}` : '',
      request.reset || until ? 'reset' : ''
    ].filter(Boolean);
    if (watch.state === 'watching') {
      arm(watch, now);
      void write(watch, `\n── rearmed · ${stamp(now)} · ${changes.length ? `${changes.join(', ')}, ` : ''}for at most ${formatDuration(watch.timeout)} from now ──\n`);
      // A new interval counts from now (unless a run is going on, which schedules the next).
      if (every !== undefined && !watch.current) {
        clearTimeout(watch.timer);
        schedule(watch);
      }
      void save(watch);
      emit();
      return { ok: true, watch: publicOf(watch) };
    }
    const sessionId = chat.parent ?? chat.sessionId;
    const active = [...watches.values()].filter((other) => ofChat(chat, other) && !FINAL.has(other.state)).length;
    if (active >= MAX_ACTIVE_PER_CHAT) throw new WatchError(`At most ${MAX_ACTIVE_PER_CHAT} watches run in a chat: stop one first (codeflower-watch list)`);
    // The chat that re-arms it hears of it now.
    Object.assign(watch, { agent: chat.agent, sessionId, key: chat.key ?? keyOf(chat.agent, sessionId) });
    watch.state = 'watching';
    watch.failures = 0;
    for (const field of ['ended', 'reason', 'ideas']) delete watch[field];
    if (watch.folder) await mkdir(watch.folder, { recursive: true });
    void write(watch, `\n── rearmed · ${stamp(now)} · every ${formatDuration(watch.every)} until ${untilText(watch.until)}, for at most ${formatDuration(watch.timeout)} ──\n`);
    arm(watch, now);
    // Its Roots need waits again (the idea blocked again if it went on meanwhile).
    if (watch.idea !== undefined && ideas) {
      try {
        ideas.link(chat, watch.idea, publicOf(watch));
      } catch (error) {
        log(`watch ${watch.id}: could not reopen its need on idea ${watch.idea}: ${error.message}`);
      }
    }
    log(`${watch.key ?? sessionId} re-armed watch ${watch.id} (${watch.name}) for ${formatDuration(watch.timeout)}`);
    const first = await runOnce(watch, { first: true });
    if (!FINAL.has(watch.state)) {
      if (first.verdict === 'met') finish(watch, 'met', { notify: false });
      else if (first.verdict === 'failed') finish(watch, 'failed', { reason: failReason(watch), notify: false });
      else if (first.misuse) finish(watch, 'failing', { reason: `the first run's stderr says the command is wrong: ${first.misuse}`, notify: false });
      else if (watch.failures >= MAX_FAILURES) finish(watch, 'failing', { reason: `${MAX_FAILURES} runs in a row failed`, notify: false });
      else {
        schedule(watch);
        // Its processes may have ended meanwhile: then it ends now.
        followPids(watch);
        void checkPids(watch);
      }
    }
    return { ok: true, watch: publicOf(watch), run: runAnswer(first) };
  };

  const stop = (id, by = 'user') => {
    const watch = watches.get(id);
    if (!watch) throw new WatchError(`No watch ${id}`);
    finish(watch, 'stopped', { reason: by === 'agent' ? 'stopped by the agent' : undefined, notify: by !== 'agent' });
    return publicOf(watch);
  };

  // Watches a bridge before this one left: those still running are lost; old ones go.
  const recover = async () => {
    let names;
    try {
      names = (await readdir(directory)).filter((name) => ID.test(name));
    } catch {
      await mkdir(directory, { recursive: true }).catch((error) => log(`watches: ${error.message}`));
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const folder = join(directory, name);
      let record;
      try {
        record = JSON.parse(await readFile(join(folder, 'watch.json'), 'utf8'));
      } catch {
        continue;
      }
      if (record.ended && now - Date.parse(record.ended) > KEEP_MS) {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const watch = {
        ...record,
        until: { kind: 'exit' },
        ...(Array.isArray(record.pids) ? { pids: record.pids.map((pid) => ({ pid })) } : {}),
        folder,
        history: [],
        waiters: new Set(),
        writing: Promise.resolve(),
        key: record.agent && record.sessionId ? keyOf(record.agent, record.sessionId) ?? record.key : record.key
      };
      try {
        watch.until = parseUntil(record.until);
        watch.fail = parseFail(record.fail);
      } catch {
        // An old condition that no longer reads: it is only shown.
      }
      watches.set(name, watch);
      if (!FINAL.has(record.state)) {
        watch.state = 'lost';
        watch.ended = iso(now);
        watch.reason = 'the sandbox stopped while it ran';
        delete watch.nextRun;
        void write(watch, `\n── lost: the sandbox stopped while it ran ──\n`);
        void save(watch);
        endIdeas(watch);
      }
    }
  };
  const ready = recover().then(emit);

  return {
    ready,
    /** A request from codeflower-watch; chat is the chat it runs in, if known. */
    async handle(chat, request, { signal } = {}) {
      await ready;
      try {
        switch (request?.action) {
          case 'start':
            return await start(chat, request, signal);
          case 'wait': {
            const watch = find(chat, request.id);
            const waited = await waitFor(watch, readWait(request.wait ?? true), signal);
            return { ok: true, watch: publicOf(watch), waited, ...(FINAL.has(watch.state) ? { output: tail(watch.lastOutput ?? '', 8 * 1024) } : {}) };
          }
          case 'rearm':
            return await rearm(chat, request);
          case 'check': {
            const { result, watch } = await check(find(chat, request.id), 'agent');
            return { ok: true, watch: publicOf(watch), run: runAnswer(result) };
          }
          case 'link': {
            const watch = find(chat, request.id);
            if (FINAL.has(watch.state)) throw new WatchError(`${watch.name} has ended (${watch.state}): start a new watch with --idea`);
            const id = readIdea(request.idea);
            if (id === undefined) throw new WatchError('Which idea? codeflower-watch link ID IDEA');
            const linked = linkIdea(chat, watch, id);
            if (linked !== true) throw new WatchError(`Could not add it to idea ${id}: ${linked}`);
            return { ok: true, watch: publicOf(watch) };
          }
          case 'list': {
            const list = snapshot().filter((watch) => request.all || !chat || ofChat(chat, watch));
            return { ok: true, watches: list };
          }
          case 'show': {
            const watch = find(chat, request.id);
            return { ok: true, watch: publicOf(watch), runs: watch.history, output: tail(watch.lastOutput ?? '', 8 * 1024) };
          }
          case 'stop': {
            const targets = request.all
              ? [...watches.values()].filter((watch) => !FINAL.has(watch.state) && (!chat || ofChat(chat, watch)))
              : [find(chat, request.id)];
            for (const watch of targets) finish(watch, 'stopped', { reason: 'stopped by the agent', notify: false });
            return { ok: true, stopped: targets.map(publicOf) };
          }
          default:
            return { ok: false, code: 'invalid', error: 'Unknown request' };
        }
      } catch (error) {
        if (error instanceof WatchError) return { ok: false, code: 'invalid', error: error.message };
        throw error;
      }
    },
    /** The watches windows are shown: active ones and those of the last day. */
    snapshot,
    /** A window's Stop. */
    stop,
    /** A window's Check now: the run's verdict; a met watch is told to its chat. */
    async checkNow(id) {
      const watch = watches.get(id);
      if (!watch) throw new WatchError(`No watch ${id}`);
      const { result } = await check(watch, 'user');
      return { watch: publicOf(watch), run: { exitCode: result.exitCode, verdict: result.verdict, ...(result.timedOut ? { timedOut: true } : {}) } };
    },
    /** The chat has a watch still running, whose end it hears of. */
    active: (agent, sessionId) => [...watches.values()].some((watch) => watch.agent === agent && watch.sessionId === sessionId && !FINAL.has(watch.state)),
    count: () => [...watches.values()].filter((watch) => !FINAL.has(watch.state)).length,
    // What a chat that wraps up should know of its watches still running.
    wrapUpNote(agent, sessionId) {
      const active = [...watches.values()].filter((watch) => watch.agent === agent && watch.sessionId === sessionId && !FINAL.has(watch.state));
      if (!active.length) return '';
      const lines = active.map((watch) => `- ${watch.name} (${watch.id}): ${watch.command}, every ${formatDuration(watch.every)} until ${untilText(watch.until)}`);
      return `\n\nYour watches still running:\n${lines.join('\n')}\nThey stop with the sandbox. Write them into your notes, so the next session can start them again (codeflower-watch start).`;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const entry of notices.values()) clearTimeout(entry.timer);
      notices.clear();
      for (const watch of watches.values()) {
        clearTimeout(watch.timer);
        clearTimeout(watch.deadlineTimer);
        clearInterval(watch.pidTimer);
        for (const waiter of [...watch.waiters]) waiter.resolve('gone');
        if (FINAL.has(watch.state)) continue;
        if (watch.child) stopChild(watch.child, killGraceMs);
        watch.state = 'lost';
        watch.ended = iso(Date.now());
        watch.reason = 'the sandbox stopped while it ran';
        delete watch.nextRun;
        void write(watch, `\n── lost: the sandbox stopped ──\n`);
        void save(watch);
        endIdeas(watch);
      }
      await Promise.all([...watches.values()].map((watch) => watch.writing));
    }
  };
}
