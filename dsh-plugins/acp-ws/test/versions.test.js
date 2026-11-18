import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pyprojectVersion, readVersions } from '../src/versions.js';

async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

test('readVersions reports the app, image, page, storyteller and agents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, 'node_modules');
  await writeJson(join(modules, '@anthropic-ai/claude-agent-sdk/package.json'), { version: '0.3.310', claudeCodeVersion: '2.1.310' });
  await writeJson(join(modules, '@openai/codex/package.json'), { version: '0.164.0' });
  await writeJson(join(modules, 'opencode-linux-arm64/package.json'), { version: '1.19.5' });
  await writeJson(join(root, 'page/version.json'), { ui: '0.33.0' });
  await mkdir(join(root, 'storyteller'));
  await writeFile(join(root, 'storyteller/pyproject.toml'), '[build-system]\nversion = "9"\n\n[project]\nname = "storyteller"\nversion = "0.6.3"\n');

  const versions = await readVersions({
    environment: {
      CODEFLOWER_APP_VERSION: 'v0.40.0',
      CODEFLOWER_IMAGE_VERSION: '0.33.0',
      CODEFLOWER_IMAGE_REF: 'ghcr.io/lutrarutra/codeflower-sandbox:0.33.0'
    },
    runtimeModules: modules,
    pageDirectory: join(root, 'page'),
    storytellerDirectory: join(root, 'storyteller')
  });
  assert.deepEqual(versions, {
    app: 'v0.40.0',
    image: '0.33.0',
    imageRef: 'ghcr.io/lutrarutra/codeflower-sandbox:0.33.0',
    page: '0.33.0',
    storyteller: '0.6.3',
    // Claude Code's own release, not the SDK's; dsh is not installed.
    agents: { claude: '2.1.310', codex: '0.164.0', opencode: '1.19.5' }
  });
});

test('readVersions leaves out what nothing tells', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versions = await readVersions({
    environment: {},
    runtimeModules: join(root, 'missing'),
    pageDirectory: join(root, 'missing'),
    storytellerDirectory: join(root, 'missing')
  });
  assert.deepEqual(versions, {});
});

test('pyprojectVersion reads the [project] table only', () => {
  assert.equal(pyprojectVersion('[tool.x]\nversion = "1"\n[project]\nversion = \'2.0\'\n'), '2.0');
  assert.equal(pyprojectVersion('[tool.x]\nversion = "1"\n'), undefined);
});
