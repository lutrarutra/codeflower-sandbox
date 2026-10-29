import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const inventory = fileURLToPath(new URL('../bin/codeflower-inventory', import.meta.url));
const parquet = fileURLToPath(new URL('./fixtures/inventory.parquet', import.meta.url));

// Without h5py or pyarrow, as in a new project.
const run = (...args) => execFileSync('python3', ['-I', inventory, ...args], { encoding: 'utf8' });

function npy(shape, descr) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  header = header.padEnd(118 - 1) + '\n';
  const length = Buffer.alloc(2);
  length.writeUInt16LE(header.length);
  return Buffer.concat([Buffer.from('\x93NUMPY\x01\x00', 'latin1'), length, Buffer.from(header, 'latin1')]);
}

test('describes formats, shapes and columns from the start of each file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const study = join(dir, 'study42');
  const write = (path, content) => {
    mkdirSync(join(study, path, '..'), { recursive: true });
    writeFileSync(join(study, path), content);
  };
  write('meta.csv', 'sample,age,score\na,30,0.1\nb,41,0.5\nc,52,0.9\n');
  write('meta.tsv.gz', gzipSync('sample\tage\nx\t1\n'));
  copyFileSync(parquet, join(study, 'counts.parquet'));
  write('emb.npy', npy([10, 3], '<f4'));
  write('info.json', JSON.stringify({ study: 'x', samples: [1, 2] }));
  write('calls.vcf', '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1\tS2\n');
  write('pbmc.h5ad', Buffer.from('\x89HDF\r\n\x1a\n', 'latin1'));
  write('broken.parquet', 'not parquet');
  // A 10x folder, and AnnData in Zarr (format 2), described without libraries.
  write('filtered/matrix.mtx.gz', gzipSync('%%MatrixMarket matrix coordinate integer general\n%\n100 30 5\n'));
  write('filtered/barcodes.tsv.gz', gzipSync('AAAC-1\n'));
  write('pbmc.zarr/.zattrs', JSON.stringify({ 'encoding-type': 'anndata' }));
  write('pbmc.zarr/X/.zattrs', JSON.stringify({ 'encoding-type': 'csr_matrix', shape: [50, 20] }));
  write('pbmc.zarr/obs/.zattrs', JSON.stringify({ 'column-order': ['cell_type', 'n_genes'] }));
  write('pbmc.zarr/var/.zattrs', JSON.stringify({ 'column-order': ['symbol'] }));
  write('pbmc.zarr/layers/counts/.zattrs', '{}');
  // Many files of one kind are summarised, with examples.
  for (let index = 0; index < 20; index++) write(`fastq/S${String(index).padStart(2, '0')}_R1.fastq.gz`, 'x');

  const output = join(dir, 'run', 'inventory.md');
  run('--write', output, study);
  const text = readFileSync(output, 'utf8');
  for (const line of [
    '- `meta.csv` 44 B: CSV, 3 columns: sample (text), age (int), score (float); 3 rows',
    'TSV, 2 columns: sample (text), age (int); 1 rows',
    'Parquet, 4 columns: gene (string), count (int64), nested (group), tags (group); 2 rows',
    'NumPy array <f4 (10, 3)',
    'JSON object, keys: study, samples',
    'VCF (VCFv4.2), 2 samples: S1, S2',
    'HDF5 (install h5py to see inside)',
    '`broken.parquet` 11 B: PARQUET, could not read it',
    '- `filtered/`: 10x Genomics matrix folder: 100 features × 30 barcodes, 5 nonzero',
    '- `pbmc.zarr/`: AnnData (Zarr); 50 observations × 20 variables; obs: cell_type, n_genes; var: symbol; layers: counts',
    '- `fastq/`: 20 files: 20 .fastq.gz (20 B)',
    '  - e.g. `fastq/S00_R1.fastq.gz` 1 B: FASTQ reads (gzip)'
  ]) {
    assert.ok(text.includes(line), `missing ${JSON.stringify(line)} in\n${text}`);
  }
  assert.ok(!text.includes('S02_R1'), 'only two examples of a kind are described');
});

test('says when nothing is mounted, and lists files without describing them when out of time', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(run(join(dir, 'missing')), /does not exist/);
  writeFileSync(join(dir, 'a.csv'), 'x,y\n1,2\n');
  const text = run('--time-limit', '0', dir);
  assert.match(text, /- `a\.csv` 8 B\n/);
  assert.match(text, /1 files were listed but not described/);
});
