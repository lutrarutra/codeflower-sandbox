import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { airDraft, createSubagentAdapter, subagentFeatures } from '../src/subagents/adapters.js';
import { createSubagentSettings, mergeMeta, settingsEffects } from '../src/subagents/settings.js';
import { createSubagentTracker } from '../src/subagents/tracker.js';
import { loadRegistry } from '../src/agents.js';

test('an agent names its adapter, and its index.js may replace parts of it', () => {
  assert.equal(createSubagentAdapter(undefined, undefined), undefined);
  const rfd = createSubagentAdapter({}, undefined);
  assert.deepEqual(rfd.clientCapabilities, { subagents: {} });
  assert.equal(rfd.translate({ sessionUpdate: 'tool_call' }, 'parent'), undefined);
  assert.equal(rfd.cancel('child', { capabilities: {} }), undefined);
  assert.deepEqual(rfd.cancel('child', { capabilities: { cancel: {} } }), { method: 'session/cancel', params: { sessionId: 'child' } });
  const watch = () => () => {};
  assert.equal(createSubagentAdapter({ adapter: 'air-draft' }, { watch }).watch, watch);
  assert.throws(() => createSubagentAdapter({ adapter: 'nope' }), /Unknown subagents adapter/);
});

test('the draft form becomes the RFD form', () => {
  const { translate } = airDraft();
  assert.deepEqual(translate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'c', name: 'Task 3', task: 'Look' }, 'p'), [
    { sessionId: 'p', update: { sessionUpdate: 'subagent_update', sessionId: 'c', title: 'Task 3', state: { state: 'running' } } },
    { sessionId: 'p', update: { sessionUpdate: 'session_message', messageId: 'c:task', senderSessionId: 'p', recipientSessionId: 'c', content: [{ type: 'text', text: 'Look' }] } },
    { sessionId: 'c', update: { sessionUpdate: 'session_message', messageId: 'c:task', senderSessionId: 'p', recipientSessionId: 'c', content: [{ type: 'text', text: 'Look' }] } }
  ]);
  const ended = (state) => translate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'c', state }, 'p')[0].update.state;
  assert.deepEqual(ended('completed'), { state: 'idle', stopReason: 'end_turn' });
  assert.deepEqual(ended('failed'), { state: 'idle', stopReason: 'error' });
  assert.deepEqual(ended('cancelled'), { state: 'idle', stopReason: 'cancelled' });
  assert.deepEqual(ended('disconnected'), { state: 'unknown' });
});

// codex-acp 2.3.0 makes a subagent a session of its own only from Codex's
// `subAgentActivity` items, which only multi_agent_v2 sends. Without them it
// holds the child back, so the child's approvals never reach the user and
// the parent's turn waits on it for good.
test("Codex runs with multi_agent_v2, which the subagent settings keep", async () => {
  const [{ descriptor }] = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'codex');
  assert.equal(descriptor.subagents.adapter, 'air-draft');
  assert.deepEqual(JSON.parse(descriptor.env.CODEX_CONFIG), { 'features.multi_agent_v2': true });
  const { env } = settingsEffects(descriptor.subagents.settings, { model: 'small', effort: 'same' }, descriptor.env);
  assert.deepEqual(JSON.parse(env.CODEX_CONFIG), { 'features.multi_agent_v2': true, 'agents.default_subagent_model': 'small' });
});

test('features say only what the descriptor declares', () => {
  assert.deepEqual(subagentFeatures({ reports: { model: true, usage: 'tokens' }, settings: { effort: { kind: 'env', applies: 'session' } } }), {
    reports: { model: true, effort: false, usage: 'tokens', result: false },
    settings: { effort: { applies: 'session' } }
  });
  assert.deepEqual(subagentFeatures({ reports: { usage: 'lots' } }).reports.usage, 'none');
});

test('settings go where the agent takes them; "same" leaves them out', () => {
  const specs = {
    model: { kind: 'session-meta', path: ['tool', 'options', 'env', 'MODEL'], applies: 'session' },
    effort: { kind: 'json-env', variable: 'CONFIG', key: 'agents.effort', applies: 'restart' }
  };
  assert.deepEqual(settingsEffects(specs, { model: 'same', effort: 'same' }), { sessionMeta: {}, env: {} });
  assert.deepEqual(settingsEffects(specs, { model: 'small', effort: 'low' }, { CONFIG: '{"hooks":{}}' }), {
    sessionMeta: { tool: { options: { env: { MODEL: 'small' } } } },
    env: { CONFIG: '{"hooks":{},"agents.effort":"low"}' }
  });
  assert.deepEqual(settingsEffects({ model: { kind: 'env', variable: 'M', same: 'inherit' } }, { model: 'same', effort: 'same' }).env, { M: 'inherit' });
  assert.deepEqual(mergeMeta({ a: { b: 1, c: { d: 1 } } }, { a: { c: { e: 2 } } }), { a: { b: 1, c: { d: 1, e: 2 } } });
});

test('settings are kept in the project and checked', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-subagents-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'subagents', 'claude.json');
  const settings = await createSubagentSettings({ file });
  await settings.set({ model: ' opus ', effort: 42, other: 'x' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { model: 'opus', effort: 'same' });
  assert.deepEqual((await createSubagentSettings({ file })).get(), { model: 'opus', effort: 'same' });
});

test('the tracker follows children, their children, and children that work again', () => {
  const changes = [];
  let clock = 0;
  const tracker = createSubagentTracker({ onChange: (summary) => changes.push(summary.state), now: () => new Date(++clock * 1000) });
  assert.equal(tracker.observe('p', { sessionUpdate: 'subagent_update', sessionId: 'c', state: { state: 'running' } }), 'c');
  assert.equal(tracker.observe('p', { sessionUpdate: 'subagent_update', sessionId: 'c', title: 'Again' }), undefined);
  assert.equal(tracker.observe('c', { sessionUpdate: 'subagent_update', sessionId: 'g', state: { state: 'running' } }), 'g');
  assert.deepEqual(tracker.ancestors('g'), ['c', 'p']);
  assert.equal(tracker.rootOf('g'), 'p');
  assert.equal(tracker.rootOf('p'), 'p');

  tracker.observe('p', { sessionUpdate: 'subagent_update', sessionId: 'c', state: { state: 'idle', stopReason: 'end_turn', usage: { totalTokens: 5 } } });
  const ended = tracker.summary('c');
  assert.equal(ended.stopReason, 'end_turn');
  assert.deepEqual(ended.usage, { tokens: { totalTokens: 5 } });
  assert.ok(ended.endedAt);
  tracker.observe('p', { sessionUpdate: 'subagent_update', sessionId: 'c', state: { state: 'running' } });
  assert.equal(tracker.summary('c').endedAt, undefined);
  assert.equal(tracker.summary('c').stopReason, undefined);

  // A message in chunks, then a new one after other work.
  tracker.observe('c', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
  tracker.observe('c', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } });
  assert.equal(tracker.summary('c').lastMessage, 'ab');
  tracker.observe('c', { sessionUpdate: 'tool_call', toolCallId: 't' });
  tracker.observe('c', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' } });
  assert.equal(tracker.summary('c').lastMessage, 'c');

  tracker.forget('p');
  assert.equal(tracker.isChild('c'), false);
  assert.equal(tracker.isChild('g'), false);
  assert.ok(changes.length > 0);
});
