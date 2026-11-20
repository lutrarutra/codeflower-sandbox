// Batch jobs (docs/jobs.md in the workspace): the agent asks for one with
// codeflower-job, which reaches the bridge on a local socket. The bridge asks
// the user in the chat when the app's config says so, then passes the request
// to the app through the project's spool (requests/ID.json, answered in
// responses/ID.json): the app checks it against the config's limits, submits
// it, and records each job in the project's jobs folder (jobs/ID/job.json),
// which the bridge watches to tell the windows and the chat that asked.
//
// The approval is the user's say over what runs on their account; it is not
// what keeps jobs in bounds, which the app does outside the sandbox.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// How long codeflower-job waits for the user and the scheduler before it
// says the request is pending; the chat hears the outcome later.
export const ANSWER_WAIT_MS = 85_000;
// How long the bridge waits for the app's answer once it has the request.
const APP_WAIT_MS = 5 * 60_000;
const SPOOL_POLL_MS = 250;
// How often the jobs folder is read (fs.watch misses changes made on other
// nodes and through some bind mounts).
const WATCH_MS = 2000;
// Jobs that end close together are told to their chat in one message.
const NOTICE_DELAY_MS = 20_000;
// What windows get: the active jobs, and those that ended in the last day.
const RECENT_MS = 24 * 60 * 60_000;
const MAX_LISTED = 200;

const FINAL = new Set(['done', 'failed', 'cancelled', 'lost']);

/** Reads CODEFLOWER_JOBS: what the app's config allows, or undefined when jobs are off. */
export function readJobsInfo(environment = process.env) {
  const text = environment.CODEFLOWER_JOBS;
  if (!text) return undefined;
  try {
    const info = JSON.parse(text);
    return info && typeof info.scheduler === 'string' ? info : undefined;
  } catch {
    return undefined;
  }
}

const memory = (value) => (value ? `${value} memory` : undefined);

/** A one-line description of what a request asks for. */
export function describeRequest(info, request) {
  const parts = [];
  if (request.queue || info.defaults?.queue) parts.push(`queue ${request.queue || info.defaults.queue}`);
  parts.push(`${request.cpus || info.defaults?.cpus || 1} CPU${(request.cpus || info.defaults?.cpus || 1) === 1 ? '' : 's'}`);
  const size = memory(request.memory || info.defaults?.memory);
  if (size) parts.push(size);
  const time = request.time || info.defaults?.time;
  if (time) parts.push(time);
  if (request.gpus) parts.push(`${request.gpus} GPU${request.gpus === 1 ? '' : 's'}${request.gpuType ? ` (${request.gpuType})` : ''}`);
  if (request.array) parts.push(`array ${request.array}`);
  if (request.after?.length) parts.push(`after ${request.after.join(', ')}`);
  return parts.join(', ');
}

const shellQuote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`);

/** The permission request a submission shows in the chat. */
export function approvalRequest(info, request, id) {
  const name = request.name || String(request.command?.[0] ?? 'job').split('/').pop();
  const command = (request.command ?? []).map(shellQuote).join(' ');
  const details = [
    `Command: ${command}`,
    `Folder: ${request.workdir}`,
    `Resources: ${describeRequest(info, request)}`,
    ...(request.env && Object.keys(request.env).length ? [`Variables: ${Object.keys(request.env).join(', ')}`] : []),
    `It runs in a sandbox like this one (same folders and network), submitted to ${info.scheduler} as you.`
  ].join('\n');
  return {
    toolCall: {
      toolCallId: `codeflower-job-${id}`,
      title: `Submit the batch job ${name} (${info.scheduler})`,
      kind: 'execute',
      status: 'pending',
      rawInput: { command: request.command, workdir: request.workdir, ...request },
      content: [{ type: 'content', content: { type: 'text', text: details } }]
    },
    options: [
      { optionId: 'allow', name: 'Submit', kind: 'allow_once' },
      { optionId: 'allow_chat', name: 'Submit and allow for this chat', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
  };
}

/** What the chat is told when a job ended. */
export function endNotice(jobs) {
  const lines = jobs.map((job) => {
    const outcome = job.outcome
      ? ` (${job.outcome.done} done, ${job.outcome.failed + (job.outcome.lost ?? 0)} failed${job.outcome.cancelled ? `, ${job.outcome.cancelled} cancelled` : ''})`
      : job.exitCode !== undefined && job.exitCode !== null
        ? ` (exit ${job.exitCode})`
        : '';
    const where = job.schedulerId ? `, ${job.scheduler} ${job.schedulerId}` : '';
    return `- ${job.name} (${job.id}${where}): ${job.state}${outcome}; output in ${job.logs}/`;
  });
  const intro = jobs.length === 1 ? 'A batch job you submitted ended:' : 'Batch jobs you submitted ended:';
  return `${intro}\n${lines.join('\n')}\nRead the output (codeflower-job log ID) before going on.`;
}

/**
 * The bridge's side of batch jobs.
 * - info: readJobsInfo(); spool: this sandbox's spool; directory: the project's jobs folder.
 * - askUser(chat, { toolCall, options }) → the answer, or undefined when it cannot ask.
 * - tell(chat, text, title): a message for the chat's next prompt.
 * - changed(jobs): sends the list to the windows.
 */
export function createJobs({
  info,
  spool,
  directory,
  askUser,
  tell,
  changed = () => {},
  log = () => {},
  // The key of the chat a job is for (sessions.js), for the windows.
  keyOf = () => undefined,
  // Tests make these short.
  watchMs = WATCH_MS,
  noticeDelayMs = NOTICE_DELAY_MS,
  answerWaitMs = ANSWER_WAIT_MS
}) {
  // Chats the user allowed to submit without asking again.
  const allowed = new Set();
  const known = new Map();
  let watched = false;
  let watchTimer;
  let closed = false;
  let list = [];
  const notices = new Map();

  const toApp = async (request) => {
    const id = randomUUID();
    const requests = join(spool, 'requests');
    const responses = join(spool, 'responses');
    await mkdir(requests, { recursive: true });
    const file = join(requests, `${id}.json`);
    // Written aside and renamed, so the app never reads half of it.
    await writeFile(join(requests, `.${id}.tmp`), JSON.stringify({ ...request, id }), { mode: 0o600 });
    await rename(join(requests, `.${id}.tmp`), file);
    const answer = join(responses, `${id}.json`);
    const deadline = Date.now() + APP_WAIT_MS;
    while (!closed && Date.now() < deadline) {
      try {
        const response = JSON.parse(await readFile(answer, 'utf8'));
        await rm(answer, { force: true });
        void refresh();
        return response;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, SPOOL_POLL_MS));
      }
    }
    await rm(file, { force: true });
    return { ok: false, code: 'scheduler', error: 'The app did not answer: is the sandbox still connected to it?' };
  };

  const approve = async (chat, request) => {
    if (info.approve !== 'ask') return 'policy';
    if (chat && allowed.has(chat.key)) return 'chat';
    if (!chat) throw new Error("Jobs need the user's approval in a chat: run codeflower-job in a chat's turn");
    const answer = await askUser(chat, approvalRequest(info, request, randomUUID().slice(0, 8)));
    const option = answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : undefined;
    if (option === 'allow_chat') allowed.add(chat.key);
    if (option === 'allow' || option === 'allow_chat') return 'user';
    return undefined;
  };

  // A submission: asked, then sent to the app. Resolves with the outcome.
  const submitNow = async (chat, request) => {
    const approved = await approve(chat, request);
    if (!approved) return { ok: false, code: 'denied', error: 'The user did not allow this job.' };
    return toApp({
      ...request,
      action: 'submit',
      approved,
      ...(chat ? { agent: chat.agent, sessionId: chat.sessionId } : {})
    });
  };

  const submit = async (chat, request) => {
    const outcome = submitNow(chat, request);
    let waited;
    const pending = new Promise((resolve) => {
      waited = setTimeout(() => resolve(undefined), answerWaitMs);
    });
    const first = await Promise.race([outcome, pending]);
    clearTimeout(waited);
    if (first) return first;
    // Still waiting for the user (or the scheduler): the chat hears later.
    void outcome.then((late) => {
      if (!chat) return;
      const text = late.ok
        ? `The batch job request you made was ${late.job?.approved === 'user' ? 'allowed' : 'submitted'}: ${late.job?.name} is ${late.job?.id} (${info.scheduler} ${late.job?.schedulerId ?? ''}).`
        : `The batch job request you made was not submitted: ${late.error}`;
      tell(chat, text, 'Batch job');
    });
    return {
      ok: false,
      code: 'pending',
      error: "Waiting for the user to allow the job; you get a message when it is submitted or denied. End your turn rather than waiting."
    };
  };

  const cancel = (id) => toApp({ action: 'cancel', job: id });

  const readJob = async (name) => {
    const path = join(directory, name, 'job.json');
    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }
    const previous = known.get(name);
    if (previous && previous.mtime === info.mtimeMs && previous.size === info.size) return previous.job;
    try {
      const job = JSON.parse(await readFile(path, 'utf8'));
      known.set(name, { mtime: info.mtimeMs, size: info.size, job });
      return job;
    } catch {
      return previous?.job;
    }
  };

  const noticeFor = (job) => {
    if (!job.notify || !job.agent || !job.sessionId) return;
    const key = `${job.agent}\u0000${job.sessionId}`;
    let entry = notices.get(key);
    if (!entry) {
      entry = { chat: { agent: job.agent, sessionId: job.sessionId }, jobs: [] };
      entry.timer = setTimeout(() => {
        notices.delete(key);
        if (!closed) tell(entry.chat, endNotice(entry.jobs), entry.jobs.length === 1 ? 'Batch job ended' : 'Batch jobs ended');
      }, noticeDelayMs);
      entry.timer.unref?.();
      notices.set(key, entry);
    }
    entry.jobs.push(job);
  };

  // Reads the jobs folder; tells the windows when something changed, and the
  // chat when one of its jobs ended (not those that had ended before).
  const refresh = async () => {
    let names;
    try {
      names = (await readdir(directory)).filter((name) => /^j-[0-9a-f]{6,16}$/.test(name));
    } catch {
      names = [];
    }
    const jobs = [];
    for (const name of names) {
      const before = known.get(name)?.job;
      const read = await readJob(name);
      if (!read) continue;
      const key = read.agent && read.sessionId ? keyOf(read.agent, read.sessionId) : undefined;
      const job = key ? { ...read, key } : read;
      jobs.push(job);
      if (watched && before && !FINAL.has(before.state) && FINAL.has(job.state)) noticeFor(job);
    }
    watched = true;
    const now = Date.now();
    const recent = jobs
      .filter((job) => !FINAL.has(job.state) || now - Date.parse(job.ended ?? job.updated ?? 0) < RECENT_MS)
      .sort((a, b) => Date.parse(b.submitted) - Date.parse(a.submitted))
      .slice(0, MAX_LISTED);
    const signature = JSON.stringify(recent.map((job) => [job.id, job.state, job.updated]));
    if (signature !== JSON.stringify(list.map((job) => [job.id, job.state, job.updated]))) {
      list = recent;
      changed(list);
    }
  };

  const tick = async () => {
    if (closed) return;
    await refresh().catch((error) => log(`jobs: ${error.message}`));
    if (!closed) {
      watchTimer = setTimeout(tick, watchMs);
      watchTimer.unref?.();
    }
  };
  void tick();

  return {
    info,
    /** A request from codeflower-job; chat is the chat it runs in, if known. */
    async handle(chat, request) {
      switch (request?.action) {
        case 'submit':
          return submit(chat, request.job ?? {});
        case 'cancel':
          if (typeof request.job !== 'string' || !request.job) return { ok: false, code: 'invalid', error: 'Which job? codeflower-job cancel ID' };
          return cancel(request.job);
        default:
          return { ok: false, code: 'invalid', error: 'Unknown request' };
      }
    },
    cancel,
    /** The jobs windows are shown: active ones and those of the last day. */
    snapshot: () => list,
    summary: () => ({ scheduler: info.scheduler, approve: info.approve, active: list.filter((job) => !FINAL.has(job.state)).length }),
    // What a chat that wraps up should know of its jobs still active.
    wrapUpNote(agent, sessionId) {
      const active = list.filter((job) => job.agent === agent && job.sessionId === sessionId && !FINAL.has(job.state));
      if (!active.length) return '';
      const lines = active.map((job) => `- ${job.name} (${job.id}${job.schedulerId ? `, ${job.scheduler} ${job.schedulerId}` : ''}): ${job.state}; output in ${job.logs}/`);
      const after = info.onStop === 'cancel' ? 'They are cancelled when the sandbox stops.' : 'They keep running after the sandbox stops.';
      return `\n\nYour batch jobs not done yet:\n${lines.join('\n')}\n${after} Write their ids and output folders into your notes, so the next session can check them (codeflower-job list).`;
    },
    refresh,
    close() {
      closed = true;
      clearTimeout(watchTimer);
      for (const entry of notices.values()) clearTimeout(entry.timer);
      notices.clear();
    }
  };
}
