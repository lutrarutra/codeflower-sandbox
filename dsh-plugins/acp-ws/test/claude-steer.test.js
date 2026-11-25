import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgents, loadRegistry } from '../src/agents.js';
import { BACKGROUND_NOTE, patchSteer } from '../src/agents/claude/steer-background.js';

const LAUNCH = new URL('../src/agents/claude/launch.js', import.meta.url).pathname;

// The adapter's agent as far as the wrapper sees it: sessions with a query, and
// a steer that records what it got.
function fakeAdapter({ turnRunning = true, openInputs = 0, backgroundTasks } = {}) {
  const calls = [];
  class Agent {
    constructor() {
      this.sessions = {
        s1: {
          turnQueue: turnRunning ? [{ settled: true }, { settled: false }] : [{ settled: true }],
          openUserInputs: new Set(Array.from({ length: openInputs }, (_, i) => i)),
          query: {
            backgroundTasks:
              backgroundTasks ??
              (async () => {
                calls.push('background');
                return true;
              })
          }
        }
      };
    }
    async steer(params) {
      calls.push(['steer', params]);
      return { outcome: 'injected' };
    }
  }
  return { Agent, calls };
}

const quiet = () => {};
const steer = { sessionId: 's1', prompt: [{ type: 'text', text: 'and also this' }] };

test('a steer into a running turn moves foreground work to the background first, and says so', async () => {
  const { Agent, calls } = fakeAdapter();
  assert.equal(patchSteer(Agent, quiet), true);
  assert.deepEqual(await new Agent().steer(steer), { outcome: 'injected' });
  assert.equal(calls[0], 'background');
  const [, params] = calls[1];
  assert.equal(params.sessionId, 's1');
  assert.deepEqual(params.prompt, [
    { type: 'text', text: BACKGROUND_NOTE, _meta: { 'codeflower/steerNote': true } },
    { type: 'text', text: 'and also this' }
  ]);
  // The caller's blocks are not changed in place.
  assert.equal(steer.prompt.length, 1);
});

test('nothing moves without a running turn or while a request waits for the user', async () => {
  for (const options of [{ turnRunning: false }, { openInputs: 1 }]) {
    const { Agent, calls } = fakeAdapter(options);
    patchSteer(Agent, quiet);
    await new Agent().steer(steer);
    assert.deepEqual(calls, [['steer', steer]], JSON.stringify(options));
  }
});

test('steers as before when background tasks are off or the session is unknown', async () => {
  const logged = [];
  const { Agent, calls } = fakeAdapter({
    backgroundTasks: async () => {
      throw new Error('background tasks are disabled');
    }
  });
  patchSteer(Agent, (message) => logged.push(message));
  await new Agent().steer(steer);
  assert.deepEqual(calls, [['steer', steer]]);
  assert.match(logged[0], /disabled/);

  const unknown = { sessionId: 'other', prompt: steer.prompt };
  await new Agent().steer(unknown);
  assert.deepEqual(calls[1], ['steer', unknown]);
});

test('leaves an adapter without steer alone', () => {
  const logged = [];
  assert.equal(patchSteer(class {}, (message) => logged.push(message)), false);
  assert.equal(logged.length, 1);
});

test('Claude Code starts through its wrapper, a test agent without it', async () => {
  const registry = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'claude');
  const { claude } = createAgents({ nodePath: 'node', modules: '/m', environment: {}, agents: registry });
  assert.deepEqual(await claude.command(), ['node', LAUNCH, '/m/@agentclientprotocol/claude-agent-acp/dist/index.js']);
  const fake = createAgents({ nodePath: 'node', launch: { claude: '/fake.js' }, environment: {}, agents: registry }).claude;
  assert.deepEqual(await fake.command(), ['node', '/fake.js']);
});

test('the wrapper patches the adapter, then runs its entry as if started directly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-claude-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'v1'));
  await writeFile(
    join(directory, 'v1', 'acp-agent.js'),
    'export class ClaudeAcpAgent { steer() {} }\nexport const original = ClaudeAcpAgent.prototype.steer;\n'
  );
  await writeFile(
    join(directory, 'index.js'),
    "import { ClaudeAcpAgent, original } from './v1/acp-agent.js';\n" +
      'console.log(JSON.stringify({ patched: ClaudeAcpAgent.prototype.steer !== original, script: process.argv[1], args: process.argv.slice(2) }));\n'
  );
  const run = spawnSync(process.execPath, [LAUNCH, join(directory, 'index.js'), '--cli', 'auth'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  // The adapter reruns itself as `node <argv[1]> …` for its terminal sign-in.
  assert.deepEqual(JSON.parse(run.stdout), { patched: true, script: join(directory, 'index.js'), args: ['--cli', 'auth'] });

  // An entry without the adapter's module (a fake agent in its place) still runs.
  await mkdir(join(directory, 'fake'));
  const bare = join(directory, 'fake', 'bare.js');
  await writeFile(bare, "console.log('ran');\n");
  const plain = spawnSync(process.execPath, [LAUNCH, bare], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), 'ran');
  assert.match(plain.stderr, /Claude adapter unchanged/);
});
