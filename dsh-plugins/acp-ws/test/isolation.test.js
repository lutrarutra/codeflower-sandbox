import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAgents } from '../src/agents.js';
import { startEgressForwarder } from '../src/egress.js';
import { agentEnvironment, startBridge } from '../src/server.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const token = 'k'.repeat(43);

// Socket paths are limited to about 100 bytes, so not under the long tmpdir on macOS.
async function socketDirectory(t) {
  const directory = await mkdtemp('/tmp/cf-acp-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('an isolated bridge listens on the socket and advertises the app port', async (t) => {
  const directory = await socketDirectory(t);
  const socket = join(directory, 'bridge.sock');
  const agents = createAgents({
    nodePath: process.execPath,
    dshBin: fakeAgent,
    claudeAcpBin: fakeAgent,
    codexAcpBin: fakeAgent,
    environment: process.env
  });
  const bridge = await startBridge({
    listenSocket: socket,
    port: 7781,
    advertiseHost: '127.0.0.1',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-test',
    sessionsDirectory: join(directory, 'sessions'),
    agentName: 'claude',
    agent: agents.claude,
    showSocket: join(directory, 'show.sock'),
    log: () => {}
  });
  t.after(() => bridge.close());

  assert.equal(bridge.address.port, 7781);
  const written = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'));
  assert.equal(written.url, `codeflower://127.0.0.1:7781?token=${token}`);

  const status = await new Promise((resolve, reject) => {
    request({ socketPath: socket, path: '/status', headers: { authorization: `Bearer ${token}` } }, resolve)
      .on('error', reject)
      .end();
  });
  assert.equal(status.statusCode, 200);
  status.resume();
});

test('the egress forwarder passes connections to the app socket', async (t) => {
  const directory = await socketDirectory(t);
  const socket = join(directory, 'egress.sock');
  const app = createServer((connection) => connection.pipe(connection));
  app.listen(socket);
  await once(app, 'listening');
  t.after(() => app.close());

  const forwarder = await startEgressForwarder(socket, { port: 0 });
  t.after(() => forwarder.close());
  const client = createConnection({ host: '127.0.0.1', port: forwarder.port });
  client.end('CONNECT pypi.org:443 HTTP/1.1\r\n\r\n');
  let echoed = '';
  for await (const chunk of client) echoed += chunk;
  assert.equal(echoed, 'CONNECT pypi.org:443 HTTP/1.1\r\n\r\n');
});

test('the egress forwarder closes clients when the app is gone', async (t) => {
  const directory = await socketDirectory(t);
  const forwarder = await startEgressForwarder(join(directory, 'missing.sock'), { port: 0 });
  t.after(() => forwarder.close());
  const client = createConnection({ host: '127.0.0.1', port: forwarder.port });
  client.on('error', () => {});
  await once(client, 'close');
});

test('the agent keeps the proxy settings but not the socket paths', () => {
  const environment = agentEnvironment({
    HTTPS_PROXY: 'http://127.0.0.1:3128',
    CODEFLOWER_NETWORK: 'isolated',
    CODEFLOWER_ENVIRONMENT_FILE: '/codeflower-state/run/environment-worker.md',
    CODEFLOWER_MOUNTS: '[{"target":"/data/input","readOnly":true}]',
    CODEFLOWER_LISTEN_SOCKET: '/codeflower-net/bridge.sock',
    CODEFLOWER_EGRESS_SOCKET: '/codeflower-net/egress.sock'
  });
  assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:3128');
  assert.equal(environment.CODEFLOWER_NETWORK, 'isolated');
  assert.equal(environment.CODEFLOWER_ENVIRONMENT_FILE, '/codeflower-state/run/environment-worker.md');
  assert.equal(environment.CODEFLOWER_MOUNTS, undefined);
  assert.equal(environment.CODEFLOWER_LISTEN_SOCKET, undefined);
  assert.equal(environment.CODEFLOWER_EGRESS_SOCKET, undefined);
});
