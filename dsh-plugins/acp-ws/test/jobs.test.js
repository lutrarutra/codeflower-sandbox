import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { resolvePath } from '../src/files.js';
import { approvalRequest, createJobs, describeRequest, endNotice, readJobsInfo } from '../src/jobs.js';
import { agentEnvironment, startBridge } from '../src/server.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const jobCommand = fileURLToPath(new URL('../../../bin/codeflower-job', import.meta.url));
const token = 'j'.repeat(43);

const INFO = {
  scheduler: 'slurm',
  approve: 'ask',
  supports: ['queue', 'array', 'after'],
  defaults: { cpus: 1, memory: '4G', time: '1h', queue: 'shortq' },
  limits: {},
  active: 20,
  array: 100,
  onStop: 'keep'
};

test('describes what a request asks for, and asks to allow it', () => {
  assert.equal(readJobsInfo({}), undefined);
  assert.equal(readJobsInfo({ CODEFLOWER_JOBS: 'nope' }), undefined);
  assert.equal(readJobsInfo({ CODEFLOWER_JOBS: JSON.stringify(INFO) }).scheduler, 'slurm');
  assert.equal(
    describeRequest(INFO, { cpus: 8, memory: '32G', gpus: 1, gpuType: 'l4', array: '1-10%2', after: ['j-abcdef'] }),
    'queue shortq, 8 CPUs, 32G memory, 1h, 1 GPU (l4), array 1-10%2, after j-abcdef'
  );
  const { toolCall, options } = approvalRequest(INFO, { command: ['/data/code/x/run.sh', 'a b'], workdir: '/data/output/x' }, 'abc');
  assert.equal(toolCall.title, 'Submit the batch job run.sh (slurm)');
  assert.match(toolCall.content[0].content.text, /Command: \/data\/code\/x\/run\.sh 'a b'\nFolder: \/data\/output\/x/);
  assert.deepEqual(options.map((option) => option.kind), ['allow_once', 'allow_always', 'reject_once']);
  assert.match(
    endNotice([{ id: 'j-1', name: 'align', scheduler: 'slurm', schedulerId: '7', state: 'failed', exitCode: 2, logs: '/codeflower-state/jobs/j-1' }]),
    /- align \(j-1, slurm 7\): failed \(exit 2\); output in \/codeflower-state\/jobs\/j-1\//
  );
  // The agent of a bridge reaches the app only through it.
  const environment = agentEnvironment({ CODEFLOWER_JOBS_SOCKET: '/s', CODEFLOWER_JOBS_SPOOL: '/p', CODEFLOWER_JOBS: '{}' });
  assert.equal(environment.CODEFLOWER_JOBS_SPOOL, undefined);
  assert.equal(environment.CODEFLOWER_JOBS, '{}');
  assert.equal(agentEnvironment({ CODEFLOWER_JOBS_SPOOL: '/p' }).CODEFLOWER_JOBS_SPOOL, '/p');
});

test('a chat that wraps up hears of its jobs still running', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (job) => {
    await mkdir(join(directory, job.id), { recursive: true });
    await writeFile(join(directory, job.id, 'job.json'), JSON.stringify({ submitted: new Date().toISOString(), logs: `/codeflower-state/jobs/${job.id}`, ...job }));
  };
  await write({ id: 'j-aaaaaa', name: 'align', state: 'running', scheduler: 'slurm', schedulerId: '5', agent: 'claude', sessionId: 's1' });
  await write({ id: 'j-bbbbbb', name: 'other', state: 'running', agent: 'claude', sessionId: 's2' });
  await write({ id: 'j-cccccc', name: 'old', state: 'done', agent: 'claude', sessionId: 's1', ended: new Date().toISOString() });
  const jobs = createJobs({ info: INFO, spool: join(directory, 'spool'), directory, askUser: async () => undefined, tell: () => {}, watchMs: 60_000 });
  t.after(() => jobs.close());
  await jobs.refresh();
  const note = jobs.wrapUpNote('claude', 's1');
  assert.match(note, /- align \(j-aaaaaa, slurm 5\): running; output in \/codeflower-state\/jobs\/j-aaaaaa\//);
  assert.doesNotMatch(note, /j-bbbbbb|j-cccccc/);
  assert.match(note, /keep running after the sandbox stops/);
  assert.equal(jobs.wrapUpNote('claude', 's3'), '');
});

test('windows may read the jobs\' output, not the rest of the project state', async (t) => {
  const state = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-jobs-')));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, 'jobs', 'j-aaaaaa'), { recursive: true });
  await mkdir(join(state, 'workspace'));
  await mkdir(join(state, 'home'));
  await writeFile(join(state, 'jobs', 'j-aaaaaa', 'output.log'), 'hello\n');
  await writeFile(join(state, 'home', 'secret'), 'x');
  const options = { workspace: join(state, 'workspace'), privateDirectory: state };
  assert.equal((await resolvePath(join(state, 'jobs', 'j-aaaaaa', 'output.log'), options)).real, join(state, 'jobs', 'j-aaaaaa', 'output.log'));
  await assert.rejects(resolvePath(join(state, 'home', 'secret'), options), /cannot be shown/);
});

// A stand-in for the app: answers the spool's requests and keeps the
// project's jobs folder, as the app's broker does.
function fakeApp(spool, jobsDirectory) {
  let next = 0;
  const seen = [];
  const jobs = new Map();
  const save = async (job) => {
    await mkdir(join(jobsDirectory, job.id), { recursive: true });
    const file = join(jobsDirectory, job.id, 'job.json');
    await writeFile(`${file}.tmp`, JSON.stringify(job));
    await rename(`${file}.tmp`, file);
  };
  const timer = setInterval(async () => {
    let names = [];
    try {
      names = (await readdir(join(spool, 'requests'))).filter((name) => /^[\w-]+\.json$/.test(name));
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(spool, 'requests', name);
      let request;
      try {
        request = JSON.parse(await readFile(path, 'utf8'));
        await rm(path);
      } catch {
        continue;
      }
      seen.push(request);
      let response;
      if (request.action === 'submit') {
        next++;
        const job = {
          id: `j-00000${next}`,
          name: request.name ?? 'job',
          scheduler: 'slurm',
          schedulerId: String(100 + next),
          state: 'queued',
          command: request.command,
          workdir: request.workdir,
          logs: `/codeflower-state/jobs/j-00000${next}`,
          agent: request.agent,
          sessionId: request.sessionId,
          notify: request.notify !== false,
          approved: request.approved,
          submitted: new Date().toISOString(),
          updated: new Date().toISOString()
        };
        jobs.set(job.id, job);
        await save(job);
        response = { ok: true, job };
      } else {
        const job = jobs.get(request.job);
        if (job) {
          job.state = 'cancelled';
          await save(job);
        }
        response = job ? { ok: true, job } : { ok: false, code: 'unknown', error: `no job ${request.job}` };
      }
      await mkdir(join(spool, 'responses'), { recursive: true });
      await writeFile(join(spool, 'responses', name), JSON.stringify(response));
    }
  }, 50);
  return {
    seen,
    jobs,
    async finish(id, state, exitCode) {
      const job = jobs.get(id);
      Object.assign(job, { state, exitCode, ended: new Date().toISOString(), updated: new Date().toISOString() });
      await save(job);
    },
    stop: () => clearInterval(timer)
  };
}

async function startJobsBridge(t, info = INFO) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-jobs-')));
  const state = join(directory, 'state');
  const sessionsDirectory = join(state, 'sessions');
  const spool = join(state, 'run', 'jobs', 'instance-test');
  const jobsDirectory = join(state, 'jobs');
  const workspace = join(state, 'workspace');
  await mkdir(workspace, { recursive: true });
  const environment = {
    ...process.env,
    CODEFLOWER_TOKEN: token,
    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEFLOWER_JOBS: JSON.stringify(info),
    CODEFLOWER_JOBS_SPOOL: spool
  };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const jobsSocket = join(directory, 'jobs.sock');
  const app = fakeApp(spool, jobsDirectory);
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-test',
    sessionsDirectory,
    workspace,
    agents: { claude: agents.claude },
    environment,
    jobsSocket,
    jobsTiming: { watchMs: 50, noticeDelayMs: 100, answerWaitMs: 1500 },
    showSocket: join(directory, 'show.sock'),
    browserSocket: join(directory, 'browser.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    app.stop();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  // The agent's command: codeflower-job with what the agent exports.
  const job = (sessionId, args, extra = {}) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [jobCommand, ...args],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CODEFLOWER_JOBS: JSON.stringify(info),
            CODEFLOWER_JOBS_SOCKET: jobsSocket,
            CODEFLOWER_JOBS_DIR: jobsDirectory,
            CODEFLOWER_AGENT_NAME: 'claude',
            ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}),
            ...extra
          }
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
    });
  return { bridge, app, job, spool, jobsDirectory, workspace };
}

test('asks the user, submits through the app, and tells the chat when its job ends', async (t) => {
  const { bridge, app, job, workspace } = await startJobsBridge(t);
  const chat = await open(bridge.address, 'claude');
  const window = await open(bridge.address);
  t.after(() => {
    chat.close();
    window.close();
  });
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(chat, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;

  const status = (await call(window, '_codeflower/status')).result;
  assert.deepEqual(status.jobs, { scheduler: 'slurm', approve: 'ask', active: 0 });

  // The first job: the chat's windows are asked.
  const submitted = job(sessionId, ['submit', '--name', 'align', '--cpus', '4', '--', './run.sh', 'x']);
  const asked = await receive(chat, (message) => message.method === 'session/request_permission');
  assert.equal(asked.params.sessionId, sessionId);
  assert.match(asked.params.toolCall.title, /Submit the batch job align \(slurm\)/);
  assert.match(asked.params.toolCall.content[0].content.text, new RegExp(`Command: ${workspace}/run.sh x`));
  assert.equal(asked.params._meta['codeflower/bridge'], true);
  const waiting = (await call(window, '_codeflower/activity')).result.chats;
  assert.equal(waiting[0].waitingFor, 'permission');
  chat.send(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'allow_chat' } } }));
  const first = await submitted;
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Submitted j-000001 \(align\) to slurm as job 101/);
  assert.equal(app.seen[0].approved, 'user');
  assert.equal(app.seen[0].sessionId, sessionId);
  assert.equal(app.seen[0].cpus, 4);
  assert.deepEqual(app.seen[0].command, [`${workspace}/run.sh`, 'x']);
  const changed = await receive(window, (message) => message.method === '_codeflower/jobs/changed' && message.params.jobs.length === 1);
  assert.equal(changed.params.jobs[0].id, 'j-000001');
  assert.equal(changed.params.jobs[0].key, `claude-${sessionId}`);

  // Allowed for the chat: the next one is not asked.
  const second = await job(sessionId, ['submit', '--json', '--', 'python', '-c', 'print(1)']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).job.id, 'j-000002');
  assert.equal(app.seen[1].approved, 'chat');
  assert.equal(chat.inbox.filter((message) => message.method === 'session/request_permission').length, 0);

  // Reading and cancelling.
  assert.match((await job(sessionId, ['list'])).stdout, /j-000001 {2}align\s+queued/);
  assert.match((await job(sessionId, ['status', '101'])).stdout, /j-000001 \(align\): queued/);
  const cancelled = await call(window, '_codeflower/jobs/cancel', { id: 'j-000002' });
  assert.equal(cancelled.result.job.state, 'cancelled');
  assert.match((await job(sessionId, ['cancel', 'j-000002'])).stdout, /had already ended: cancelled/);
  assert.match((await job(sessionId, ['status', 'j-999999'])).stderr, /No job j-999999/);

  // The user cancelled it in a window: the chat hears.
  const cancelNotice = await receive(chat, (message) => message.method === '_codeflower/prompted');
  assert.match(cancelNotice.params.prompt[0].text, /- job \(j-000002, slurm 102\): cancelled/);

  // It ends: the chat hears, once.
  await app.finish('j-000001', 'failed', 3);
  const told = await receive(chat, (message) => message.method === '_codeflower/prompted');
  assert.match(told.params.prompt[0].text, /A batch job you submitted ended:\n- align \(j-000001, slurm 101\): failed \(exit 3\)/);
  const listed = (await call(window, '_codeflower/jobs/list')).result.jobs;
  assert.deepEqual(listed.map((each) => [each.id, each.state]), [['j-000002', 'cancelled'], ['j-000001', 'failed']]);
});

test('a denied job is not submitted, and one the user has not answered yet is pending', async (t) => {
  const { bridge, app, job, workspace } = await startJobsBridge(t);
  const chat = await open(bridge.address, 'claude');
  t.after(() => chat.close());
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(chat, 'session/new', { cwd: workspace, mcpServers: [] })).result.sessionId;

  const denied = job(sessionId, ['submit', '--', 'python']);
  const asked = await receive(chat, (message) => message.method === 'session/request_permission');
  chat.send(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'deny' } } }));
  const result = await denied;
  assert.equal(result.code, 3);
  assert.match(result.stderr, /did not allow/);
  assert.equal(app.seen.length, 0);

  // No answer in time: pending; the chat hears once the user allows it.
  const pending = await job(sessionId, ['submit', '--name', 'slow', '--', 'python']);
  assert.equal(pending.code, 4);
  assert.match(pending.stderr, /Waiting for the user/);
  const later = await receive(chat, (message) => message.method === 'session/request_permission');
  chat.send(JSON.stringify({ jsonrpc: '2.0', id: later.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
  const told = await receive(chat, (message) => message.method === '_codeflower/prompted');
  assert.match(told.params.prompt[0].text, /slow is j-000001/);

  // Not in a chat's turn and no session named: nobody to ask.
  assert.match((await job(undefined, ['submit', '--', 'python'])).stderr, /approval in a chat/);
});

test('without the bridge (a task), jobs go straight to the spool only when the config does not ask', async (t) => {
  const { app, job, spool, jobsDirectory } = await startJobsBridge(t);
  const withoutBridge = { CODEFLOWER_JOBS_SOCKET: '', CODEFLOWER_JOBS_SPOOL: spool };
  const refused = await job(undefined, ['submit', '--', 'python'], withoutBridge);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /jobs\.approve: never/);
  const never = JSON.stringify({ ...INFO, approve: 'never' });
  const submitted = await job(undefined, ['submit', '--', 'python'], { ...withoutBridge, CODEFLOWER_JOBS: never });
  assert.equal(submitted.code, 0, submitted.stderr);
  assert.equal(app.seen.at(-1).approved, 'policy');
  assert.match((await job(undefined, ['info'], { CODEFLOWER_JOBS: never, CODEFLOWER_JOBS_DIR: jobsDirectory })).stdout, /submitted without asking/);
  assert.match((await job(undefined, ['list'], { CODEFLOWER_JOBS: '' })).stderr, /Batch jobs are off/);
});

// ---- through the bridge ----

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
