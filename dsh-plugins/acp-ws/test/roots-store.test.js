import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { change, create, fileName, format, needMet, parse, readAll, RootsError, rootsDir, withLock } from '../src/roots-store.js';

const store = fileURLToPath(new URL('../src/roots-store.js', import.meta.url));

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-roots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'roots');
}

test('finds the folder in the workspace, or where the environment says', () => {
  assert.equal(rootsDir({}), '/codeflower-state/workspace/roots');
  assert.equal(rootsDir({ CODEFLOWER_WORKSPACE: '/w' }), '/w/roots');
  assert.equal(rootsDir({ CODEFLOWER_WORKSPACE: '/w', CODEFLOWER_ROOTS_DIR: '/r' }), '/r');
});

test('names files by id and title', () => {
  assert.equal(fileName(3, 'Batch-correct with Harmony!'), '003-batch-correct-with-harmony.md');
  assert.equal(fileName(12, 'Ünïcode café'), '012-unicode-cafe.md');
  assert.equal(fileName(1, '???'), '001-idea.md');
});

test('writes and reads an idea the same, conclusion included', () => {
  const idea = {
    id: 2, title: 'Doublets', status: 'done', from: [1], needs: [{ idea: 1 }, { text: 'sheet', met: true }],
    todos: [{ text: 'run', done: true }], files: ['figures/a.png'], chats: [], comments: [{ by: 'user', text: 'hi', at: 'x' }],
    created: 'a', updated: 'b', conclusion: 'Removed **6.9%**.\n\n- one\n- two'
  };
  const text = format(idea);
  assert.match(text, /^---\n\{\n  "id": 2,\n/);
  assert.match(text, /\n    \{"text":"run","done":true\}\n/);
  assert.deepEqual(parse(text), idea);
  // The front matter is JSON, so any YAML reader takes it too.
  assert.equal(JSON.parse(text.split('\n---\n')[0].slice(4)).title, 'Doublets');
});

test('fills in missing fields and refuses wrong ones', () => {
  const idea = parse('---\n{"id": 1, "title": "x"}\n---\n');
  assert.equal(idea.status, 'active');
  assert.deepEqual(idea.todos, []);
  assert.equal(idea.conclusion, '');
  assert.throws(() => parse('no front matter'), /front matter/);
  assert.throws(() => parse('---\n{"id": 1, "title": "x"\n---\n'), /not JSON/);
  assert.throws(() => parse('---\n{"id": 1, "title": "x", "status": "maybe"}\n---\n'), /status must be one of/);
  assert.throws(() => parse('---\n{"id": 1, "title": "x", "todos": ["a"]}\n---\n'), /each todo/);
});

test('creates ideas with the next id, and checks what they build on', (t) => {
  const dir = folder(t);
  const chat = { agent: 'claude', sessionId: 's1' };
  const first = create(dir, { title: 'QC' }, { chat });
  assert.equal(first.id, 1);
  assert.equal(first.file, '001-qc.md');
  assert.deepEqual(first.chats.map(({ agent, sessionId }) => ({ agent, sessionId })), [chat]);
  const second = create(dir, { title: 'Cluster', from: [1], needs: [{ idea: 1 }] });
  assert.equal(second.id, 2);
  assert.throws(() => create(dir, { title: 'x', from: [9] }), (error) => error instanceof RootsError && error.code === 'unknown');
  assert.throws(() => change(dir, 1, (idea) => (idea.from = [2])), /circle: 1 → 2 → 1/);
  assert.throws(() => change(dir, 1, (idea) => (idea.needs = [{ idea: 1 }])), /cannot need itself/);
  // Nothing was written by the refused changes.
  assert.deepEqual(readAll(dir).ideas.find((idea) => idea.id === 1).from, []);
});

test('keeps a file that does not parse apart, and its number taken', (t) => {
  const dir = folder(t);
  create(dir, { title: 'QC' });
  writeFileSync(join(dir, '002-broken.md'), 'oops');
  writeFileSync(join(dir, 'notes.md'), 'not an idea');
  const { ideas, errors } = readAll(dir);
  assert.deepEqual(ideas.map((idea) => idea.id), [1]);
  assert.deepEqual(errors.map((error) => error.file), ['002-broken.md']);
  assert.equal(create(dir, { title: 'Next' }).id, 3);
  assert.throws(() => change(dir, 2, () => {}), /002-broken.md cannot be read/);
});

test('records the chats that changed an idea, the latest last', (t) => {
  const dir = folder(t);
  create(dir, { title: 'QC' }, { chat: { agent: 'claude', sessionId: 'a' } });
  change(dir, 1, () => {}, { chat: { agent: 'codex', sessionId: 'b' } });
  const idea = change(dir, 1, () => {}, { chat: { agent: 'claude', sessionId: 'a' } });
  assert.deepEqual(idea.chats.map((entry) => entry.sessionId), ['b', 'a']);
});

test('a need on an idea is met when that idea is done', () => {
  const byId = new Map([[1, { status: 'done' }], [2, { status: 'active' }]]);
  assert.equal(needMet({ idea: 1 }, byId), true);
  assert.equal(needMet({ idea: 2 }, byId), false);
  assert.equal(needMet({ text: 'x', met: true }, byId), true);
  assert.equal(needMet({ text: 'x' }, byId), false);
});

test('breaks a lock left behind by a crash', (t) => {
  const dir = folder(t);
  create(dir, { title: 'QC' });
  writeFileSync(join(dir, '.lock'), '1\n');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, '.lock'), old, old);
  assert.equal(withLock(dir, () => 'ran'), 'ran');
  assert.ok(!readdirSync(dir).includes('.lock'));
});

test('writers in several processes at once get distinct ids', async (t) => {
  const dir = folder(t);
  const script = `const { create } = await import(${JSON.stringify(store)}); for (let i = 0; i < 5; i++) create(process.argv[1], { title: 'p' + process.pid + ' ' + i });`;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: 'inherit' }));
  const codes = await Promise.all(children.map(async (child) => (await once(child, 'exit'))[0]));
  assert.deepEqual(codes, Array(6).fill(0));
  const { ideas, errors } = readAll(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(ideas.map((idea) => idea.id), Array.from({ length: 30 }, (_, index) => index + 1));
});
