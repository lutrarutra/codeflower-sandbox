import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repro = fileURLToPath(new URL('../bin/codeflower-repro', import.meta.url));

// A Python with Snakemake, PyYAML and Pillow: CODEFLOWER_REPRO_PYTHON, or a venv made once with uv.
function findPython() {
  if (process.env.CODEFLOWER_REPRO_PYTHON) return process.env.CODEFLOWER_REPRO_PYTHON;
  if (spawnSync('uv', ['--version']).status !== 0) return null;
  const venv = join(tmpdir(), 'codeflower-repro-test-venv');
  const python = join(venv, 'bin', 'python');
  const ready = () => spawnSync(python, ['-c', 'import snakemake, yaml, PIL']).status === 0;
  if (!ready()) {
    spawnSync('uv', ['venv', '-q', '--python', '3.13', venv]);
    spawnSync('uv', ['pip', 'install', '-q', '--python', python, 'snakemake==9.27.2', 'pyyaml', 'pillow']);
  }
  return ready() ? python : null;
}

const python = findPython();
const skip = python ? false : 'needs uv, or CODEFLOWER_REPRO_PYTHON with snakemake, pyyaml and pillow';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-repro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CODEFLOWER_SNAKEMAKE: `${python} -m snakemake`, CODEFLOWER_IMAGE_REF: 'codeflower-sandbox:test',
    CODEFLOWER_IMAGE_ID: 'sha256:abc' };
  delete env.VIRTUAL_ENV;
  delete env.R_LIBS_USER;
  const run = (...args) => spawnSync(python, ['-I', repro, ...args], { env, encoding: 'utf8', cwd: dir });
  return { dir, env, run };
}

// A pipeline with a deterministic table, a table with run-to-run noise below 1e-9 and a PNG.
function writePipeline(run, dir) {
  const pipeline = join(dir, 'demo');
  assert.equal(run('init', pipeline, '--title', 'Demo').status, 0);
  writeFileSync(join(pipeline, 'workflow', 'Snakefile'), `configfile: "workflow/config.yaml"

rule all:
    input:
        "results/example.csv",
        "results/noisy.tsv",
        "results/plot.png",

rule example:
    input:
        "data/example.csv",
    output:
        "results/example.csv",
    params:
        seed=config["seed"],
    log:
        "logs/example.log",
    script:
        "scripts/example.py"

rule noisy:
    output:
        "results/noisy.tsv",
    log:
        "logs/noisy.log",
    script:
        "scripts/noisy.py"

rule plot:
    output:
        "results/plot.png",
    log:
        "logs/plot.log",
    script:
        "scripts/plot.py"
`);
  writeFileSync(join(pipeline, 'workflow', 'scripts', 'noisy.py'),
    'import time\nwith open(snakemake.output[0], "w") as f:\n    f.write("x\\ty\\n1\\t%.15f\\n" % (0.5 + (time.time_ns() % 997) * 1e-13))\n');
  writeFileSync(join(pipeline, 'workflow', 'scripts', 'plot.py'),
    'from PIL import Image\nImage.new("RGB", (8, 8), (200, 10, 10)).save(snakemake.output[0])\n');
  return pipeline;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('init, freeze, check and pack make a deterministic archive', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = writePipeline(run, dir);
  const frozen = run('freeze', pipeline);
  assert.equal(frozen.status, 0, frozen.stderr + frozen.stdout);
  const expected = readFileSync(join(pipeline, 'expected', 'checksums.tsv'), 'utf8');
  assert.match(expected, /results\/example\.csv\t[0-9a-f]{64}\t\d+\texact/);
  assert.match(expected, /results\/noisy\.tsv\t[0-9a-f]{64}\t\d+\ttable\trtol=/);
  assert.match(expected, /results\/plot\.png\t[0-9a-f]{64}\t\d+\texact/);
  assert.ok(existsSync(join(pipeline, 'expected', 'reference', 'results', 'noisy.tsv')));
  const manifest = readFileSync(join(pipeline, 'codeflower-repro.yaml'), 'utf8');
  assert.match(manifest, /ref: codeflower-sandbox:test/);
  assert.match(manifest, /platform: linux\//);
  assert.match(manifest, /wall_seconds:/);

  const checked = run('check', pipeline);
  assert.equal(checked.status, 0, checked.stdout);
  assert.doesNotMatch(checked.stdout, /conda environment or container/);

  const first = run('pack', pipeline, '--out', join(dir, 'a'));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const second = run('pack', pipeline, '--out', join(dir, 'b'));
  assert.equal(second.status, 0);
  assert.equal(sha256(join(dir, 'a', 'demo.tar.gz')), sha256(join(dir, 'b', 'demo.tar.gz')));
  const listing = spawnSync('tar', ['tzf', join(dir, 'a', 'demo.tar.gz')], { encoding: 'utf8' }).stdout;
  assert.match(listing, /demo\/SHA256SUMS/);
  assert.doesNotMatch(listing, /\.repro|demo\/results\/|\.snakemake/);
  assert.match(listing, /demo\/expected\/reference\/results\/noisy\.tsv/);
});

test('an unpacked archive reruns from scratch and verifies', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = writePipeline(run, dir);
  assert.equal(run('freeze', pipeline).status, 0);
  assert.equal(run('pack', pipeline, '--out', join(dir, 'out')).status, 0);
  const unpacked = join(dir, 'unpacked');
  mkdirSync(unpacked);
  spawnSync('tar', ['xzf', join(dir, 'out', 'demo.tar.gz'), '-C', unpacked]);
  const archive = join(unpacked, 'demo');

  const checked = run('check', archive, '--packed');
  assert.equal(checked.status, 0, checked.stdout);
  const out = join(dir, 'repro');
  const ran = run('run', archive, '--workdir', join(dir, 'work'), '--copy-to', out, '--record', join(dir, 'run.json'));
  assert.equal(ran.status, 0, ran.stderr);
  const verified = run('verify', archive, '--dir', out, '--report', join(out, 'reproduce-report'));
  assert.equal(verified.status, 0, verified.stdout);
  const report = JSON.parse(readFileSync(join(out, 'reproduce-report.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.checked, 3);
  assert.match(readFileSync(join(out, 'reproduce-report.md'), 'utf8'), /3 of 3 results match/);

  // A changed result fails, and says what differs.
  writeFileSync(join(out, 'results', 'example.csv'), 'gene,count\nCD3E,13\n');
  const changed = run('verify', archive, '--dir', out);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /example\.csv.*sha256/);

  // So does a file edited after packing.
  appendFileSync(join(archive, 'workflow', 'config.yaml'), 'extra: 1\n');
  const edited = run('check', archive, '--packed', '--no-dry-run');
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /config\.yaml changed after packing/);
});

test('check finds paths of this machine and unpinned locks', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = join(dir, 'demo');
  assert.equal(run('init', pipeline).status, 0);
  writeFileSync(join(pipeline, 'workflow', 'scripts', 'example.py'),
    'import shutil\nshutil.copy("/codeflower-state/workspace/x.csv", snakemake.output[0])\n');
  mkdirSync(join(pipeline, 'env'), { recursive: true });
  writeFileSync(join(pipeline, 'env', 'requirements.lock'), 'numpy==2.3.0\n-e /codeflower-state/env/src/storyteller\n');
  const manifest = join(pipeline, 'codeflower-repro.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8') + 'environment:\n  python: env/requirements.lock\n');
  const result = run('check', pipeline, '--no-dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /example\.py:2: \/codeflower-state exists only on this machine/);
  assert.match(result.stdout, /numpy has no hash/);
  assert.match(result.stdout, /local or editable install/);
  assert.match(result.stdout, /expected\/checksums\.tsv is missing or empty/);
});

test('data add records URL and checksum; fetch downloads and checks', { skip }, async (t) => {
  const { dir, env } = setup(t);
  const body = 'cell,type\nAAAC,T\n';
  const server = createServer((request, response) => response.end(body));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/cells.csv`;
  // Asynchronously, so the server above keeps answering.
  const run = (...args) => new Promise((resolve) => {
    const child = spawnAsync(python, ['-I', repro, ...args], env, dir);
    child.then(resolve);
  });
  const pipeline = join(dir, 'demo');
  assert.equal((await run('init', pipeline)).status, 0);
  const added = await run('data', 'add', pipeline, 'data/raw/cells.csv', '--url', url, '--download');
  assert.equal(added.status, 0, added.stderr);
  const listed = readFileSync(join(pipeline, 'data', 'manifest.tsv'), 'utf8');
  assert.match(listed, new RegExp(`data/raw/cells.csv\\t${url.replace(/[.]/g, '\\.')}\\t${createHash('sha256').update(body).digest('hex')}\\t${body.length}`));
  const elsewhere = join(dir, 'downloads');
  const fetched = await run('data', 'fetch', pipeline, '--data', elsewhere);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.equal(readFileSync(join(elsewhere, 'data', 'raw', 'cells.csv'), 'utf8'), body);
  const bad = await run('data', 'add', pipeline, '../outside.csv', '--url', url);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be relative and start with data\//);
});

async function spawnAsync(command, args, env, cwd) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('inputs without a URL are bundled; pack --bundle-data bundles the others too', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = writePipeline(run, dir);
  mkdirSync(join(pipeline, 'data', 'raw'), { recursive: true });
  writeFileSync(join(pipeline, 'data', 'raw', 'samples.csv'), 'sample,group\nA,ctrl\n');
  writeFileSync(join(pipeline, 'data', 'raw', 'counts.csv'), 'gene,A\nCD3E,4\n');
  const bundled = run('data', 'add', pipeline, 'data/raw/samples.csv');
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.match(bundled.stdout, /bundled in the archive/);
  assert.equal(run('data', 'add', pipeline, 'data/raw/counts.csv', '--url', 'https://zenodo.org/records/1/files/counts.csv').status, 0);
  assert.match(readFileSync(join(pipeline, 'data', 'manifest.tsv'), 'utf8'), /data\/raw\/samples\.csv\t\t[0-9a-f]{64}\t/);
  assert.equal(run('freeze', pipeline).status, 0);
  const checked = run('check', pipeline);
  assert.equal(checked.status, 0, checked.stdout);

  const list = (folder) => spawnSync('tar', ['tzf', join(dir, folder, 'demo.tar.gz')], { encoding: 'utf8' }).stdout;
  const plain = run('pack', pipeline, '--out', join(dir, 'plain'));
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /Inputs: 1 bundled .*, 1 downloaded/);
  assert.match(list('plain'), /demo\/data\/raw\/samples\.csv/);
  assert.doesNotMatch(list('plain'), /counts\.csv/);

  const all = run('pack', pipeline, '--out', join(dir, 'all'), '--bundle-data');
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.match(all.stdout, /Inputs: 2 bundled .*, 0 downloaded/);
  assert.match(list('all'), /demo\/data\/raw\/counts\.csv/);

  // The unpacked archive checks and runs without downloading anything.
  const unpacked = join(dir, 'unpacked');
  mkdirSync(unpacked);
  spawnSync('tar', ['xzf', join(dir, 'all', 'demo.tar.gz'), '-C', unpacked]);
  const packedCheck = run('check', join(unpacked, 'demo'), '--packed');
  assert.equal(packedCheck.status, 0, packedCheck.stdout);
});

test('a pipeline folder packs again after changes', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = writePipeline(run, dir);
  assert.equal(run('freeze', pipeline).status, 0);
  assert.equal(run('pack', pipeline, '--out', join(dir, 'a')).status, 0);
  appendFileSync(join(pipeline, 'workflow', 'config.yaml'), 'extra: 1\n');
  assert.equal(run('freeze', pipeline).status, 0);
  const again = run('pack', pipeline, '--out', join(dir, 'b'));
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test('a slimmed bundled input records its source; prepare scripts may name local data', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = writePipeline(run, dir);
  mkdirSync(join(pipeline, 'data', 'raw'), { recursive: true });
  writeFileSync(join(pipeline, 'data', 'raw', 'counts.csv'), 'gene,A\nCD3E,4\n');
  mkdirSync(join(pipeline, 'workflow', 'prepare'));
  writeFileSync(join(pipeline, 'workflow', 'prepare', 'slim_input.py'),
    'import anndata\nadata = anndata.read_h5ad("/data/input/study/full.h5ad")\n');
  const added = run('data', 'add', pipeline, 'data/raw/counts.csv', '--source', 'raw counts of /data/input/study/full.h5ad by workflow/prepare/slim_input.py');
  assert.equal(added.status, 0, added.stderr);
  assert.match(readFileSync(join(pipeline, 'data', 'manifest.tsv'), 'utf8'), /^path\turl\tsha256\tsize\tsource\n.*\traw counts of .*workflow\/prepare\/slim_input\.py\n$/s);
  assert.equal(run('freeze', pipeline).status, 0);
  const checked = run('check', pipeline);
  assert.equal(checked.status, 0, checked.stdout);
  assert.doesNotMatch(checked.stdout, /slim_input/);

  // A large bundled input gets a warning, from check and from pack.
  writeFileSync(join(pipeline, 'data', 'raw', 'big.bin'), Buffer.alloc(101 * 1024 * 1024));
  assert.equal(run('data', 'add', pipeline, 'data/raw/big.bin').status, 0);
  const warned = run('check', pipeline, '--no-dry-run');
  assert.match(warned.stdout, /big\.bin is bundled at 101 MB: bundle only what the pipeline reads/);
  const packed = run('pack', pipeline, '--out', join(dir, 'out'), '--no-dry-run');
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  assert.match(packed.stdout, /bundled data\/raw\/big\.bin: 101\.0 MB  <- large/);
  assert.match(packed.stdout, /bundled data\/raw\/counts\.csv: 0\.0 MB\n/);
});

test('test reruns a packed archive in a new environment and compares it', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = writePipeline(run, dir);
  assert.equal(run('freeze', pipeline).status, 0);
  assert.equal(run('pack', pipeline, '--out', join(dir, 'out')).status, 0);
  const archive = join(dir, 'out', 'demo.tar.gz');
  const passed = run('test', archive, '--workdir', join(dir, 'tests'));
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /Passed: 3 of 3 results match/);
  assert.deepEqual(readdirSync(join(dir, 'tests')), [], 'the test folder is removed');

  // An archive changed after packing fails before it runs.
  const unpacked = join(dir, 'unpacked');
  mkdirSync(unpacked);
  spawnSync('tar', ['xzf', archive, '-C', unpacked]);
  appendFileSync(join(unpacked, 'demo', 'workflow', 'config.yaml'), 'extra: 1\n');
  const tampered = join(dir, 'tampered.tar.gz');
  spawnSync('tar', ['czf', tampered, '-C', unpacked, 'demo'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const failed = run('test', tampered, '--workdir', join(dir, 'tests'));
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /config\.yaml changed after packing/);
});

test('check warns about randomness without a seed', { skip }, (t) => {
  const { dir, run } = setup(t);
  const pipeline = join(dir, 'demo');
  assert.equal(run('init', pipeline).status, 0);
  const scripts = join(pipeline, 'workflow', 'scripts');
  writeFileSync(join(scripts, 'a.py'), 'import numpy as np\nx = np.random.rand(3)\n');
  writeFileSync(join(scripts, 'b.py'), 'from sklearn.cluster import KMeans\nKMeans(3, random_state=None)\n');
  writeFileSync(join(scripts, 'c.R'), 'x <- sample(1:10)\n');
  writeFileSync(join(scripts, 'd.py'), 'import numpy as np\nrng = np.random.default_rng(snakemake.params.seed)\nrng.random(3)\n');
  writeFileSync(join(scripts, 'e.R'), 'set.seed(snakemake@params$seed)\nx <- sample(1:10)\n');
  const result = run('check', pipeline, '--no-dry-run');
  assert.match(result.stdout, /a\.py uses randomness but sets no seed/);
  assert.match(result.stdout, /b\.py: random_state=None draws a new seed/);
  assert.match(result.stdout, /c\.R uses randomness but sets no seed/);
  assert.doesNotMatch(result.stdout, /[de]\.(py|R) uses randomness/);
  assert.match(readFileSync(join(pipeline, 'README.md'), 'utf8'), /## Determinism/);
});
