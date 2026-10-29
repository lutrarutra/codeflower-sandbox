import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const doctor = fileURLToPath(new URL('../bin/codeflower-doctor', import.meta.url));

test('startup facts and live diagnostics are specific to the worker', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot = join(dir, 'environment.md');
  writeFileSync(join(dir, 'nvidia-smi'), '#!/bin/sh\necho "Example GPU, 1024 MiB"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'codeflower-network'), '#!/bin/sh\necho "Current allowlist: pypi.org"\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    CODEFLOWER_AGENT: 'codex',
    CODEFLOWER_ENGINE: 'docker',
    CODEFLOWER_NETWORK: 'isolated',
    CODEFLOWER_MOUNTS: JSON.stringify([
      { target: '/data/input/example', source: '/private/host/path', readOnly: true },
      { target: '/data/output/results', source: '/private/results', readOnly: false }
    ]),
    CODEFLOWER_ENVIRONMENT_FILE: snapshot
  };
  execFileSync(process.execPath, [doctor, '--write-startup', snapshot], { env });
  const facts = readFileSync(snapshot, 'utf8');
  assert.match(facts, /Agent: codex/);
  assert.match(facts, /Engine: docker/);
  assert.match(facts, /"\/data\/input\/example": read-only/);
  assert.match(facts, /"\/data\/output\/results": read-write/);
  assert.doesNotMatch(facts, /\/private\//);
  assert.match(facts, /NVIDIA GPU query: Example GPU, 1024 MiB/);
  const live = execFileSync(process.execPath, [doctor], { env, encoding: 'utf8' });
  assert.match(live, /## Current resources/);
  assert.match(live, /Current allowlist: pypi\.org/);
});

test('missing metadata and failed live checks are surfaced', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot = join(dir, 'environment.md');
  writeFileSync(join(dir, 'codeflower-network'), '#!/bin/sh\necho "proxy unavailable" >&2\nexit 1\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    CODEFLOWER_NETWORK: 'isolated',
    CODEFLOWER_MOUNTS: '{invalid',
    CODEFLOWER_ENVIRONMENT_FILE: snapshot
  };
  execFileSync(process.execPath, [doctor, '--write-startup', snapshot], { env });
  assert.match(readFileSync(snapshot, 'utf8'), /Mount metadata unavailable:/);
  const result = spawnSync(process.execPath, [doctor], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot retrieve allowlist: proxy unavailable/);
  const missing = spawnSync(process.execPath, [doctor], {
    env: { ...env, CODEFLOWER_ENVIRONMENT_FILE: join(dir, 'missing') }, encoding: 'utf8'
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read startup facts/);
});
