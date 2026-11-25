import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const roots = fileURLToPath(new URL('../bin/codeflower-roots', import.meta.url));

function setup(t, env = {}) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'codeflower-roots-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'figures'));
  writeFileSync(join(workspace, 'figures', 'umap.png'), '');
  const base = { ...process.env, CODEFLOWER_WORKSPACE: workspace, CODEFLOWER_AGENT_NAME: 'claude', CLAUDE_CODE_SESSION_ID: 'chat-1', ...env };
  delete base.CODEX_THREAD_ID;
  delete base.CODEFLOWER_ROOTS_DIR;
  const run = (...args) => {
    const input = typeof args.at(-1) === 'object' ? args.pop().input : undefined;
    return spawnSync(process.execPath, [roots, ...args], { cwd: workspace, env: base, encoding: 'utf8', input });
  };
  const idea = (id) => JSON.parse(run('show', String(id), '--json').stdout);
  return { workspace, run, idea };
}

test('starts with an empty map and says how to begin', (t) => {
  const { run } = setup(t);
  const result = run('tree');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No ideas yet/);
});

test('builds a map of ideas with todos, needs, files and conclusions', (t) => {
  const { run, idea, workspace } = setup(t);
  assert.equal(run('new', 'Explore and QC', '--todo', 'Violins', '--todo', 'Thresholds').stdout, '#1 Explore and QC (roots/001-explore-and-qc.md)\n');
  run('new', 'Published markers');
  assert.equal(run('new', 'Annotate cell types', '--from', '1', '--need', '#2', '--need', 'Sample sheet', '--status', 'idea').status, 0);
  assert.equal(run('todo', 'check', '1', '1', '2').status, 0);
  assert.equal(run('link', '1', 'figures/umap.png').status, 0);
  assert.equal(run('conclude', '1', 'Kept **41,812** cells.', '--done').status, 0);
  assert.equal(run('need', 'check', '3', '2').status, 0);

  const qc = idea(1);
  assert.equal(qc.status, 'done');
  assert.deepEqual(qc.todos.map((todo) => todo.done), [true, true]);
  assert.deepEqual(qc.files, ['figures/umap.png']);
  assert.equal(qc.conclusion, 'Kept **41,812** cells.');
  assert.deepEqual(qc.chats.map(({ agent, sessionId }) => ({ agent, sessionId })), [{ agent: 'claude', sessionId: 'chat-1' }]);
  assert.match(readFileSync(join(workspace, 'roots', '001-explore-and-qc.md'), 'utf8'), /\n---\nKept \*\*41,812\*\* cells\.\n$/);

  const annotate = idea(3);
  assert.equal(annotate.status, 'idea');
  assert.deepEqual(annotate.from, [1]);
  assert.deepEqual(annotate.needs, [{ idea: 2 }, { text: 'Sample sheet', met: true }]);

  const tree = run('tree').stdout;
  assert.match(tree, /^#1 \[done\] Explore and QC {2}\(todos 2\/2; 1 file; concluded\)\n└─ #3 \[idea\] Annotate cell types {2}\(needs #2\)\n#2 \[active\] Published markers\n$/);
  const show = run('show', '3').stdout;
  assert.match(show, /Builds on: #1 Explore and QC/);
  assert.match(show, /1\. \[ \] #2 Published markers \(active\)/);
  assert.match(show, /2\. \[x\] Sample sheet/);
});

test('shows an idea that builds on several under the first, and names it under the others', (t) => {
  const { run } = setup(t);
  run('new', 'A');
  run('new', 'B');
  run('new', 'Merge', '--from', '1,2');
  assert.equal(run('tree').stdout, '#1 [active] A\n└─ #3 [active] Merge\n#2 [active] B\n└─ #3 Merge (also builds on #1, shown there)\n');
});

test('points at the user\'s comments until an agent answers', (t) => {
  const { run, workspace } = setup(t);
  run('new', 'Harmony');
  // The user's comment, as the bridge writes it.
  const path = join(workspace, 'roots', readdirSync(join(workspace, 'roots')).find((name) => name.endsWith('.md')));
  writeFileSync(path, readFileSync(path, 'utf8').replace('"comments": []', '"comments": [\n    {"by":"user","text":"Try scVI too","at":"t"}\n  ]'));
  assert.match(run('tree').stdout, /1 comment from the user\)\n\nThe user commented on #1/);
  assert.match(run('show', '1').stdout, /user, t: Try scVI too\n {2}\(answer with codeflower-roots comment/);
  assert.equal(run('comment', '1', 'Added #2 for scVI.').status, 0);
  assert.doesNotMatch(run('tree').stdout, /commented/);
});

test('refuses what would break the map, with exit status 2 and no lock left', (t) => {
  const { run, workspace } = setup(t);
  run('new', 'A');
  run('new', 'B', '--from', '1', '--need', '1');
  for (const [args, message] of [
    [['new', 'C', '--from', '7'], /there is no idea 7/],
    [['update', '1', '--from', '2'], /circle: 1 → 2 → 1/],
    [['update', '1', '--status', 'maybe'], /status must be one of/],
    [['todo', 'check', '1', '1'], /there is no todo 1 \(this idea has 0\)/],
    [['need', 'check', '2', '1'], /it is met when that idea is done/],
    [['link', '1', 'figures/missing.png'], /does not exist/],
    [['show', '9'], /there is no idea 9/],
    [['new'], /give the idea a title/],
    [['frobnicate'], /unknown command/]
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, message);
  }
  assert.ok(!readdirSync(join(workspace, 'roots')).includes('.lock'));
});

test('reads a conclusion from standard input or a file, and removes items', (t) => {
  const { run, idea, workspace } = setup(t);
  run('new', 'A', '--todo', 'one', '--todo', 'two', '--todo', 'three');
  assert.equal(run('conclude', '1', '-', { input: '# Found\n\nIt works.\n' }).status, 0);
  assert.equal(idea(1).conclusion, '# Found\n\nIt works.');
  writeFileSync(join(workspace, 'c.md'), 'From a file.');
  run('conclude', '1', '--file', 'c.md');
  assert.equal(idea(1).conclusion, 'From a file.');
  run('todo', 'rm', '1', '1', '3');
  assert.deepEqual(idea(1).todos.map((todo) => todo.text), ['two']);
  run('link', '1', 'figures/umap.png');
  run('link', '1', '--rm', 'figures/umap.png');
  assert.deepEqual(idea(1).files, []);
});

test('keeps files outside the workspace by their full path', (t) => {
  const { run, idea } = setup(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'codeflower-roots-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'table.csv'), '');
  run('new', 'A');
  assert.equal(run('link', '1', join(outside, 'table.csv')).status, 0);
  assert.deepEqual(idea(1).files, [join(outside, 'table.csv')]);
});
