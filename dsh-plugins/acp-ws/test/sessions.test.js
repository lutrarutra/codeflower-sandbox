import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readTranscriptPage } from '../src/sessions.js';

const key = 'claude-paged';
const t = '2026-11-02T10:00:00.000Z';
const prompt = (text) => ({ t, kind: 'prompt', prompt: [{ type: 'text', text }] });
const chunk = (text) => ({ t, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const commands = { t, kind: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init' }] } };
const turnEnd = { t, kind: 'turn_end', stopReason: 'end_turn' };

async function transcript(context, entries, tail = '') {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-sessions-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, key));
  await writeFile(join(directory, key, 'transcript.jsonl'), entries.map((entry) => `${JSON.stringify(entry)}\n`).join('') + tail);
  return directory;
}

// Three turns of about 40 kB each.
const turns = [0, 1, 2].flatMap((turn) => [
  prompt(`question ${turn}`),
  ...Array.from({ length: 10 }, () => chunk('x'.repeat(4000))),
  turnEnd
]);

test('pages a transcript from its end, starting at a turn', async (context) => {
  const directory = await transcript(context, [commands, ...turns], '{"t":"torn');
  const last = await readTranscriptPage(directory, key, { maxBytes: 64 << 10 });
  assert.equal(last.total, 37);
  // The budget reaches into the middle turn; the page starts at its prompt.
  assert.equal(last.start, 13);
  assert.equal(last.entries.length, 24);
  assert.deepEqual(last.entries[0], prompt('question 1'));
  assert.deepEqual(last.context, [commands]);

  const earlier = await readTranscriptPage(directory, key, { before: last.start, maxBytes: 64 << 10 });
  assert.equal(earlier.start, 0);
  assert.deepEqual(earlier.entries, [commands, ...turns.slice(0, 12)]);
  assert.equal(earlier.context, undefined);
});

test('pages a whole small transcript at once, and none of a missing one', async (context) => {
  const directory = await transcript(context, turns.slice(0, 3));
  assert.deepEqual(await readTranscriptPage(directory, key, {}), { entries: turns.slice(0, 3), start: 0, total: 3 });
  assert.deepEqual(await readTranscriptPage(directory, 'claude-none', {}), { entries: [], start: 0, total: 0 });
});

test('cuts a turn larger than the limit inside it, keeping at least one entry', async (context) => {
  const big = chunk('y'.repeat(9 << 20));
  const directory = await transcript(context, [prompt('long'), ...Array.from({ length: 3 }, () => chunk('z'.repeat(3 << 20))), big]);
  const page = await readTranscriptPage(directory, key, { maxBytes: 1 << 20 });
  assert.equal(page.start, 4);
  assert.deepEqual(page.entries, [big]);
  const before = await readTranscriptPage(directory, key, { before: 4, maxBytes: 1 << 20 });
  // 9 MiB of chunks would pass the 8 MiB limit: the page does not reach back to the prompt.
  assert.equal(before.start, 3);
});
