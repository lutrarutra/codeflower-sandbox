import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// A fake /proc and /sys with files at paths relative to the root.
function fakeRoot(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-doctor-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function startup(env) {
  const snapshot = join(env.CODEFLOWER_DOCTOR_ROOT, 'environment.md');
  execFileSync(process.execPath, [doctor, '--write-startup', snapshot], { env: { ...process.env, ...env } });
  return readFileSync(snapshot, 'utf8');
}

test('the tightest cgroup limit above the process is reported, as under Apptainer', (t) => {
  const job = 'sys/fs/cgroup/system.slice/slurmstepd.scope/job_7';
  const root = fakeRoot(t, {
    'proc/self/cgroup': '0::/system.slice/slurmstepd.scope/job_7/step_0/user/task_0\n',
    'sys/fs/cgroup/cpu.max': 'max 100000\n',
    [`${job}/memory.max`]: `${8 * 1024 ** 3}\n`,
    [`${job}/cpu.max`]: '400000 100000\n',
    [`${job}/step_0/memory.max`]: 'max\n',
    [`${job}/step_0/user/task_0/memory.max`]: 'max\n',
    [`${job}/step_0/user/task_0/memory.current`]: `${1024 ** 3}\n`
  });
  const facts = startup({ CODEFLOWER_DOCTOR_ROOT: root });
  assert.match(facts, /cgroup CPU limit: 4\.00 CPUs \(set on \/system\.slice\/slurmstepd\.scope\/job_7\)/);
  assert.match(facts, /cgroup memory limit: 8\.00 GiB \(set on \/system\.slice\/slurmstepd\.scope\/job_7\), 1\.00 GiB in use/);
});

test('cgroup v1 limits are read per controller', (t) => {
  const root = fakeRoot(t, {
    'proc/self/cgroup': '4:memory:/slurm/uid_1/job_9\n3:cpu,cpuacct:/slurm/uid_1/job_9\n',
    'sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
    'sys/fs/cgroup/memory/slurm/uid_1/job_9/memory.limit_in_bytes': `${2 * 1024 ** 3}\n`,
    'sys/fs/cgroup/cpu,cpuacct/slurm/uid_1/cpu.cfs_quota_us': '200000\n',
    'sys/fs/cgroup/cpu,cpuacct/slurm/uid_1/cpu.cfs_period_us': '100000\n',
    'sys/fs/cgroup/cpu,cpuacct/slurm/uid_1/job_9/cpu.cfs_quota_us': '-1\n'
  });
  const facts = startup({ CODEFLOWER_DOCTOR_ROOT: root });
  assert.match(facts, /cgroup CPU limit: 2\.00 CPUs \(set on \/slurm\/uid_1\)/);
  assert.match(facts, /cgroup memory limit: 2\.00 GiB \(set on \/slurm\/uid_1\/job_9\)/);
});

test('the allocation the launcher found is reported with the time left', (t) => {
  const root = fakeRoot(t, { 'proc/self/cgroup': '0::/\n' });
  const end = new Date(Date.now() + (2 * 60 + 30.5) * 60000).toISOString();
  const facts = startup({
    CODEFLOWER_DOCTOR_ROOT: root,
    CODEFLOWER_ALLOCATION_SOURCE: 'Slurm job 7, --memory',
    CODEFLOWER_ALLOCATION_CPUS: '8',
    CODEFLOWER_ALLOCATION_MEMORY: String(16 * 1024 ** 3),
    CODEFLOWER_ALLOCATION_GPUS: '2',
    CODEFLOWER_ALLOCATION_END: end
  });
  assert.match(facts, /Source: Slurm job 7, --memory/);
  assert.match(facts, /CPUs: 8\n- Memory: 16\.00 GiB\n- GPUs: 2/);
  assert.match(facts, /Job ends: .*\(2 h 30 min left\)/);
  assert.match(facts, /cgroup CPU limit: none found/);
  assert.match(startup({ CODEFLOWER_DOCTOR_ROOT: root }), /Allocation\n- None reported/);
});
