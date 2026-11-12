import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivity } from '../src/activity.js';

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
