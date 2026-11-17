import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivity, scopedActivity } from '../src/activity.js';

test('says whether a chat that waits for the user has a turn running', () => {
  const activity = createActivity();
  activity.turnStarted('turn-1', 'chat');
  activity.permission('request-1', 'chat', { toolCallId: 'call-1' });
  assert.deepEqual(activity.snapshot().chats, [{ sessionId: 'chat', state: 'waiting', waitingFor: 'permission', turn: true }]);
  // A background subagent asks after the turn that started it ended: the chat waits, but takes a prompt.
  activity.turnEnded('turn-1', 'end_turn');
  assert.deepEqual(activity.snapshot().chats, [{ sessionId: 'chat', state: 'waiting', waitingFor: 'permission', turn: false }]);
  activity.answered('request-1');
  assert.deepEqual(activity.snapshot().chats, []);
});

test('a chat works on background work after its turn, and takes a prompt', () => {
  const activity = createActivity();
  activity.turnStarted('turn-1', 'chat');
  activity.backgroundStarted('task-1', 'chat');
  activity.backgroundStarted('subagent-a', 'chat');
  assert.deepEqual(activity.snapshot().chats, [{ sessionId: 'chat', state: 'working', turn: true }]);
  activity.turnEnded('turn-1', 'end_turn');
  assert.deepEqual(activity.snapshot().chats, [{ sessionId: 'chat', state: 'working', turn: false }]);
  assert.equal(activity.snapshot().working, 1);
  assert.equal(activity.busy('chat'), false);
  assert.equal(activity.running, false);
  activity.backgroundEnded('task-1');
  assert.equal(activity.snapshot().working, 1);
  activity.backgroundEnded('subagent-a');
  assert.deepEqual(activity.snapshot().chats, []);
  activity.backgroundStarted('task-2', 'chat');
  activity.clear();
  assert.deepEqual(activity.snapshot().chats, []);
});

test('a chat is active while its agent or a subagent works, not while it only waits for the user', () => {
  const activity = createActivity();
  activity.turnStarted('turn-1', 'turn');
  activity.permission('request-1', 'turn', { toolCallId: 'call-1' });
  activity.turnStarted('turn-2', 'subagent');
  activity.backgroundStarted('subagent-a', 'subagent');
  activity.turnEnded('turn-2', 'end_turn');
  activity.handoff('browser:handoff', 'handoff');
  assert.deepEqual(activity.active().sort(), ['subagent', 'turn']);
  activity.backgroundEnded('subagent-a');
  activity.answered('request-1');
  activity.turnEnded('turn-1', 'end_turn');
  assert.deepEqual(activity.active(), []);
  // The chat with the handoff still waits, but nothing of it works.
  assert.equal(activity.snapshot().waiting, 1);

  const scoped = scopedActivity(createActivity(), 'claude');
  scoped.backgroundStarted('task-1', 'chat');
  assert.deepEqual(scoped.active(), ['chat']);
});
