import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('../bin/codeflower-path', import.meta.url));

function mapFile(t, mounts, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'paths.json');
  execFileSync(process.execPath, [helper, '--write-map', file], {
    env: { ...process.env, CODEFLOWER_MOUNTS: JSON.stringify(mounts), ...extra }
  });
  return file;
}

const run = (file, args) => spawnSync(process.execPath, [helper, ...args], {
  env: { ...process.env, CODEFLOWER_PATHS_FILE: file }, encoding: 'utf8'
});

test('paths translate both ways, the longest mount winning', (t) => {
  const file = mapFile(t, [
    { target: '/data/input/study42', source: '/gpfs/ana/study42', given: '/home/ana/study42', readOnly: true },
    { target: '/data/input/raw', source: '/gpfs/ana/study42/raw', readOnly: true },
    { target: '/data/output/results', source: '/Users/ana/results', readOnly: false }
  ], { CODEFLOWER_HOST_STATE: '/Users/ana/codeflower/projects/p' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).at(-1).target, '/codeflower-state');

  const result = run(file, [
    '/home/ana/study42/meta/samples.csv',
    '/gpfs/ana/study42/raw/a.fastq.gz',
    '/gpfs/ana/study42/',
    '/data/output/results/umap.png',
    '/codeflower-state/workspace/reports/r.html'
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    '/data/input/study42/meta/samples.csv',
    '/data/input/raw/a.fastq.gz',
    '/data/input/study42',
    '/Users/ana/results/umap.png',
    '/Users/ana/codeflower/projects/p/workspace/reports/r.html'
  ]);
  // A sibling with a common prefix is not inside the mount.
  const outside = run(file, ['/gpfs/ana/study420/x']);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /not in a mounted folder/);

  const listing = run(file, []);
  assert.match(listing.stdout, /\/data\/input\/study42 \(read-only\) = \/gpfs\/ana\/study42 \(the user may also write \/home\/ana\/study42\)/);
});

test('Windows host paths match without case and keep their separators', (t) => {
  const file = mapFile(t, [{ target: '/data/input/study', source: 'C:\\Users\\Ana\\Study', readOnly: true }]);
  const result = run(file, ['c:/users/ana/study/a.csv', '/data/input/study/sub/b.csv']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['/data/input/study/a.csv', 'C:\\Users\\Ana\\Study\\sub\\b.csv']);
});

test('without a map the helper says so', () => {
  const result = spawnSync(process.execPath, [helper], {
    env: { ...process.env, CODEFLOWER_PATHS_FILE: '' }, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CODEFLOWER_PATHS_FILE is not set/);
});
