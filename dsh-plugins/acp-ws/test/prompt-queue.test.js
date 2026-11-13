import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_QUEUED, createPromptQueue, queuedPromptOf } from '../src/prompt-queue.js';

const prompt = (text) => ({ prompt: [{ type: 'text', text }], text, title: text, editable: true });

test('prompts go one per turn, in order, after end_turn', () => {
  const changes = [];
  const queue = createPromptQueue({ onChange: (sessionId) => changes.push(sessionId) });
  queue.add('s', prompt('one'));
  queue.add('s', { ...prompt('two'), editable: false, action: { id: 'checkpoint', title: 'Checkpoint' } });
  assert.deepEqual(queue.snapshot('s'), {
    items: [
      { id: 'q-1', title: 'one', editable: true },
      { id: 'q-2', title: 'two', action: { id: 'checkpoint', title: 'Checkpoint' } }
    ]
  });
  assert.equal(queue.ready('s'), true);
  assert.equal(queue.next('s').text, 'one');
  assert.equal(queue.turnEnded('s', 'end_turn'), true);
  assert.equal(queue.next('s').text, 'two');
  assert.equal(queue.ready('s'), false);
  // An empty queue forgets the chat.
  assert.equal(queue.turnEnded('s', 'end_turn'), false);
  assert.deepEqual(queue.sessions(), []);
  assert.deepEqual(changes, ['s', 's', 's', 's']);
});

test('any other end of a turn pauses the queue until it is resumed', () => {
  const queue = createPromptQueue();
  queue.add('s', prompt('one'));
  assert.equal(queue.turnEnded('s', 'refusal'), false);
  assert.deepEqual(queue.snapshot('s').paused, { stopReason: 'refusal' });
  assert.equal(queue.ready('s'), false);
  // Paused, later turns do not send either.
  assert.equal(queue.turnEnded('s', 'end_turn'), false);
  queue.resume('s');
  assert.equal(queue.ready('s'), true);
  assert.equal(queue.snapshot('s').paused, undefined);
});

test('a cancel the queue asked for goes on with the next prompt', () => {
  const queue = createPromptQueue();
  queue.add('s', prompt('one'));
  queue.add('s', prompt('two'));
  assert.equal(queue.sendFirst('s', 'q-2', { afterCancel: true }).text, 'two');
  assert.equal(queue.turnEnded('s', 'cancelled'), true);
  assert.equal(queue.next('s').text, 'two');
  // The next cancel was not asked for.
  assert.equal(queue.turnEnded('s', 'cancelled'), false);
  assert.deepEqual(queue.snapshot('s').paused, { stopReason: 'cancelled' });
  // Send now unpauses.
  queue.sendFirst('s', 'q-1');
  assert.equal(queue.ready('s'), true);
});

test('replace empties the queue and goes on after the cancel', () => {
  const queue = createPromptQueue();
  queue.add('s', prompt('one'));
  queue.pause('s', 'error');
  queue.add('s', { ...prompt('wrap up'), editable: false }, { replace: true });
  assert.deepEqual(queue.snapshot('s'), { items: [{ id: 'q-2', title: 'wrap up' }] });
  assert.equal(queue.turnEnded('s', 'cancelled'), true);
});

test('takes the user’s own prompts, or one, back to a window', () => {
  const queue = createPromptQueue();
  queue.add('s', prompt('mine'));
  queue.add('s', { ...prompt('feedback'), editable: false });
  queue.add('s', prompt('also mine'));
  assert.deepEqual(queue.take('s', { id: 'q-2' }).map((item) => item.text), ['feedback']);
  assert.deepEqual(queue.take('s', { editable: true }).map((item) => item.text), ['mine', 'also mine']);
  assert.deepEqual(queue.take('s', { id: 'q-9' }), []);
  assert.equal(queue.remove('s', 'q-1'), false);
  queue.putFirst('s', [{ id: 'q-1', text: 'back', title: 'back', prompt: [] }]);
  assert.deepEqual(queue.snapshot('s').items, [{ id: 'q-1', title: 'back' }]);
  queue.clear('s');
  assert.deepEqual(queue.snapshot('s'), { items: [] });
});

test('chats have queues of their own, of a limited length', () => {
  const queue = createPromptQueue();
  queue.add('a', prompt('one'));
  assert.equal(queue.ready('b'), false);
  for (let index = 1; index < MAX_QUEUED; index++) queue.add('a', prompt(`${index}`));
  assert.throws(() => queue.add('a', prompt('too many')), RangeError);
});

test('checks a queued prompt from a window', () => {
  assert.deepEqual(queuedPromptOf({ prompt: [{ type: 'text', text: 'hi' }], editable: true }), {
    prompt: [{ type: 'text', text: 'hi' }],
    text: 'hi',
    title: 'hi',
    editable: true
  });
  assert.deepEqual(queuedPromptOf({ prompt: [{ type: 'text', text: 'x' }], text: 'shown', title: 'Feedback', action: { id: 'a' } }), {
    prompt: [{ type: 'text', text: 'x' }],
    text: 'shown',
    title: 'Feedback',
    editable: false,
    action: { id: 'a', title: 'a' }
  });
  assert.deepEqual(queuedPromptOf({ prompt: [{ type: 'text', text: 'x' }], steer: [{ type: 'text', text: 'y' }] }).steer, [{ type: 'text', text: 'y' }]);
  assert.throws(() => queuedPromptOf({ prompt: [{ type: 'text', text: 'x' }], steer: [] }), TypeError);
  assert.throws(() => queuedPromptOf({ prompt: [] }), TypeError);
  assert.throws(() => queuedPromptOf({ prompt: 'hi' }), TypeError);
  assert.throws(() => queuedPromptOf({ prompt: [{ type: 'text', text: 'x'.repeat(1_000_001) }] }), RangeError);
});
