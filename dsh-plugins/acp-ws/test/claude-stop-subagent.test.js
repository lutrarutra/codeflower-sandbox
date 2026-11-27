import assert from 'node:assert/strict';
import test from 'node:test';
import { patchSubagentCancel } from '../src/agents/claude/stop-subagent.js';
import { createAgents, loadRegistry } from '../src/agents.js';

const quiet = () => {};

// The adapter's state as stop-subagent.js reads it: a root session whose runtime has a child per task.
function fakeAdapter({ rfdStops = false, stopTask } = {}) {
  const stopped = [];
  class Agent {
    constructor() {
      this.sessions = {
        root: {
          query: { stopTask: stopTask ?? (async (taskId) => void stopped.push(taskId)) },
          nativeSubagentRuntime: {
            children: new Map([
              ['task-1', { sessionId: 'task-1', parentSessionId: 'root' }],
              ['task-2', { sessionId: 'task-2', parentSessionId: 'root', terminalState: 'completed' }]
            ])
          }
        }
      };
    }
    async cancelChildSession() {
      return rfdStops;
    }
  }
  return { Agent, stopped };
}

test('stops a running draft-form subagent by its task', async () => {
  const { Agent, stopped } = fakeAdapter();
  assert.equal(patchSubagentCancel(Agent, quiet), true);
  const agent = new Agent();
  assert.equal(await agent.cancelChildSession('task-1'), true);
  assert.deepEqual(stopped, ['task-1']);
  // Counted as the RFD form counts a cancel, so its end reads as cancelled.
  assert.equal(agent.sessions.root.nativeSubagentRuntime.children.get('task-1').cancels, 1);
});

test('leaves ended or unknown children, and what the adapter stopped itself, alone', async () => {
  const { Agent, stopped } = fakeAdapter();
  patchSubagentCancel(Agent, quiet);
  assert.equal(await new Agent().cancelChildSession('task-2'), false);
  assert.equal(await new Agent().cancelChildSession('nobody'), false);
  assert.deepEqual(stopped, []);

  const rfd = fakeAdapter({ rfdStops: true });
  patchSubagentCancel(rfd.Agent, quiet);
  assert.equal(await new rfd.Agent().cancelChildSession('task-1'), true);
  assert.deepEqual(rfd.stopped, []);
});

test('a failed stop is logged, not thrown', async () => {
  const logged = [];
  const { Agent } = fakeAdapter({
    stopTask: async () => {
      throw new Error('no such task');
    }
  });
  patchSubagentCancel(Agent, (message) => logged.push(message));
  assert.equal(await new Agent().cancelChildSession('task-1'), true);
  assert.match(logged[0], /no such task/);
});

test('leaves an adapter without cancelChildSession alone', () => {
  const logged = [];
  assert.equal(patchSubagentCancel(class {}, (message) => logged.push(message)), false);
  assert.equal(logged.length, 1);
});

test('the bridge stops a running Claude subagent with a cancel of its session', async () => {
  const registry = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'claude');
  const { claude } = createAgents({ nodePath: 'node', modules: '/m', environment: {}, agents: registry });
  assert.deepEqual(claude.subagents.cancel('child', { sessionId: 'child', state: 'running' }), {
    method: 'session/cancel',
    params: { sessionId: 'child' }
  });
  assert.equal(claude.subagents.cancel('child', { sessionId: 'child', state: 'idle' }), undefined);
  // Still the draft form's translation.
  assert.ok(claude.subagents.translate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'c' }, 'p'));
});
