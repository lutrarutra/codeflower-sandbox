import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgents, loadRegistry } from '../src/agents.js';

// Claude Code with its CLI at a path of the test's, as the app binds it in.
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modules = join(directory, 'node_modules');
  const executable = join(directory, 'agents', 'claude', 'claude');
  const registry = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'claude');
  const agents = registry.map(({ descriptor, hooks }) => ({
    descriptor: { ...descriptor, env: { ...descriptor.env, CLAUDE_CODE_EXECUTABLE: executable } },
    hooks
  }));
  const { claude } = createAgents({ nodePath: 'node', modules, environment: {}, agents });
  return { claude, modules, executable };
}

test('the image runs Claude Code from where the app binds it in', async () => {
  const [{ descriptor }] = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'claude');
  assert.equal(descriptor.env.CLAUDE_CODE_EXECUTABLE, '/opt/codeflower/agents/claude/claude');
});

test('reads the turns Claude Code starts by itself from its async tasks', async (t) => {
  const { claude } = await setup(t);
  assert.deepEqual(claude.clientCapabilities._meta.jetbrains.air, { version: 1, capabilities: ['asyncTasks'] });
  const spawned = (taskType) => ({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'task-1', taskType });
  const ended = (state) => ({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'task-1', state });
  assert.deepEqual(claude.autonomousTurn(spawned('turn')), { id: 'task-1', started: true });
  // Its background commands are tasks too, but no turns.
  assert.equal(claude.autonomousTurn(spawned('local_bash')), undefined);
  assert.deepEqual(claude.autonomousTurn(ended('completed')), { id: 'task-1', stopReason: 'end_turn' });
  assert.deepEqual(claude.autonomousTurn(ended('stopped')), { id: 'task-1', stopReason: 'cancelled' });
  assert.deepEqual(claude.autonomousTurn(ended('failed')), { id: 'task-1', stopReason: 'error' });
  assert.equal(claude.autonomousTurn(ended('running')), undefined);
  assert.equal(claude.autonomousTurn({ sessionUpdate: 'agent_message_chunk' }), undefined);
});

test('says Claude Code is missing until both the SDK and the CLI are there', async (t) => {
  const { claude, modules, executable } = await setup(t);
  assert.match(await claude.missing(), /Claude Code is not installed/);

  await mkdir(join(modules, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
  await writeFile(join(modules, '@anthropic-ai', 'claude-agent-sdk', 'package.json'), '{}');
  assert.match(await claude.missing(), /codeflower pull/);

  await mkdir(join(executable, '..'), { recursive: true });
  await writeFile(executable, '');
  assert.equal(await claude.missing(), undefined);
});
