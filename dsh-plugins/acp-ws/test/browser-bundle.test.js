import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createAgents } from '../src/agents.js';
import { createBundle, readManifest } from '../src/browser/bundle.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeChromium = fileURLToPath(new URL('../fixtures/fake-chromium.js', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const browserCommand = fileURLToPath(new URL('../../../bin/codeflower-browser', import.meta.url));
const token = 'k'.repeat(43);

// A bundle as build.mjs makes it, with the fake Chromium and a playwright-cli that prints its arguments.
async function makeBundle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root');
  await mkdir(join(root, 'chromium'), { recursive: true });
  await copyFile(fakeChromium, join(root, 'chromium', 'chrome-headless-shell'));
  execFileSync('chmod', ['+x', join(root, 'chromium', 'chrome-headless-shell')]);
  const cliFolder = join(root, 'cli', 'node_modules', '@playwright', 'cli');
  await mkdir(cliFolder, { recursive: true });
  await writeFile(join(cliFolder, 'playwright-cli.js'), "console.log(`playwright-cli ${process.env.PLAYWRIGHT_CLI_SESSION} ${process.argv.slice(2).join(' ')}`);\n");
  const archive = join(directory, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', root, '.']);
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;
  let delayMs = 0;
  const server = createServer((request, response) => {
    downloads++;
    setTimeout(() => {
      response.writeHead(200, { 'content-length': bytes.length });
      response.end(bytes);
    }, delayMs);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/codeflower-browser-test.tar.gz`;
  const manifest = {
    version: '0.0.1-1.0',
    binary: 'chromium/chrome-headless-shell',
    cli: 'cli/node_modules/@playwright/cli/playwright-cli.js',
    files: { [process.arch]: { url, sha256, size: bytes.length } }
  };
  const manifestPath = join(directory, 'bundle.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return {
    directory,
    archive,
    manifest,
    manifestPath,
    downloads: () => downloads,
    slow(ms) {
      delayMs = ms;
    }
  };
}

test('installs the pinned bundle once, checked against its hash', async (t) => {
  const bundleFiles = await makeBundle(t);
  assert.deepEqual(await readManifest(bundleFiles.manifestPath), bundleFiles.manifest);
  assert.equal(await readManifest(join(bundleFiles.directory, 'none.json')), undefined);
  const directory = join(bundleFiles.directory, 'state');
  const bundle = createBundle({ manifest: bundleFiles.manifest, directory });
  assert.equal(bundle.supported, true);
  assert.deepEqual(await bundle.status(), { state: 'missing' });

  // Two commands at once download it once.
  const [first, second] = await Promise.all([bundle.ensure(), bundle.ensure()]);
  assert.deepEqual([first, second], [{ installed: true }, { installed: true }]);
  assert.equal(bundleFiles.downloads(), 1);
  assert.ok((await stat(bundle.binary)).mode & 0o100, 'Chromium is executable');
  assert.ok(bundle.binary.startsWith(join(directory, '0.0.1-1.0-linux-')));
  assert.deepEqual(await bundle.status(), { state: 'installed' });
  await bundle.ensure();
  assert.equal(bundleFiles.downloads(), 1, 'installed: no second download');

  // A bundle that is not the pinned one is not installed.
  const other = createBundle({
    manifest: { ...bundleFiles.manifest, version: '0.0.2-1.0', files: { [process.arch]: { ...bundleFiles.manifest.files[process.arch], sha256: '0'.repeat(64) } } },
    directory
  });
  await assert.rejects(other.ensure(), /does not match the image's/);
  assert.equal(await other.installed(), false);
  assert.match((await other.status()).error, /does not match/);

  // An architecture without a build.
  assert.equal(createBundle({ manifest: bundleFiles.manifest, directory, arch: 'mips' }).supported, false);
});

test('installs from an archive in the sandbox, and says how far a slow download got', async (t) => {
  const bundleFiles = await makeBundle(t);
  const fromFile = createBundle({ manifest: bundleFiles.manifest, directory: join(bundleFiles.directory, 'offline') });
  await assert.rejects(fromFile.ensure({ from: join(bundleFiles.directory, 'missing.tar.gz') }), /No such file/);
  assert.deepEqual(await fromFile.ensure({ from: bundleFiles.archive }), { installed: true });
  assert.equal(bundleFiles.downloads(), 0);

  bundleFiles.slow(400);
  const slow = createBundle({ manifest: bundleFiles.manifest, directory: join(bundleFiles.directory, 'slow') });
  const waiting = await slow.ensure({ waitMs: 50 });
  assert.equal(waiting.installing, true);
  assert.equal((await slow.status()).state, 'installing');
  assert.equal(slow.describeProgress({ received: 41 * 2 ** 20, total: 114 * 2 ** 20 }), '41 MB of 114 MB');
  assert.deepEqual(await slow.ensure(), { installed: true });
});

test('codeflower-browser installs the bundle on its first command and runs its playwright-cli', async (t) => {
  const bundleFiles = await makeBundle(t);
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-browser-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  delete environment.CODEFLOWER_BROWSER_BIN;
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const browserSocket = join(directory, 'browser.sock');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'bundle-test',
    sessionsDirectory: join(directory, 'state', 'sessions'),
    workspace: directory,
    agents: { claude: agents.claude },
    environment,
    browserSocket,
    browserManifest: bundleFiles.manifestPath,
    showSocket: join(directory, 'show.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(() => bridge.close());
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/acp?agent=claude`, { headers: { authorization: `Bearer ${token}` } });
  await once(socket, 'open');
  t.after(() => socket.close());
  const replies = new Map();
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      replies.set(id, resolve);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(2, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const browser = (...args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [browserCommand, ...args],
        { cwd: directory, env: { ...process.env, CODEFLOWER_BROWSER_SOCKET: browserSocket, CODEFLOWER_AGENT_NAME: 'claude', CLAUDE_CODE_SESSION_ID: sessionId } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
    });

  const listed = (await call(3, '_codeflower/browser/list', {})).result;
  assert.equal(listed.available, true);
  assert.deepEqual(listed.bundle, { state: 'missing' });
  const snapshot = await browser('snapshot');
  assert.equal(snapshot.code, 0, snapshot.stderr);
  assert.equal(snapshot.stdout.trim().split('\n').at(-1), `playwright-cli cf-${sessionKey('claude', sessionId)} snapshot`);
  assert.equal(bundleFiles.downloads(), 1);
  assert.deepEqual((await call(4, '_codeflower/browser/list', {})).result.bundle, { state: 'installed' });
  const installed = await browser('install');
  assert.match(installed.stdout, /installed for this project/);
  assert.equal(bundleFiles.downloads(), 1);
});
