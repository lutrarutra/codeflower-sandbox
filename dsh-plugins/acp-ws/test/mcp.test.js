import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { describeLeftOut, failedMcpServers, mcpServersFor, parseMcpServers, withMcpServers } from '../src/mcp.js';

const configured = [
  { name: 'files', command: 'files-mcp', args: ['server.js'], env: [{ name: 'TOKEN', value: 'secret' }] },
  { name: 'local', command: './tools/mcp' },
  { name: 'gone', command: 'no-such-mcp-server' },
  { type: 'http', name: 'docs', url: 'https://mcp.example.org/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
  { type: 'sse', name: 'events', url: 'https://mcp.example.org/sse' }
];

test('reads the servers the app passes, in ACP shape', () => {
  assert.deepEqual(parseMcpServers(undefined), []);
  const servers = parseMcpServers(JSON.stringify(configured));
  assert.deepEqual(servers[0], configured[0]);
  // args and env are required by ACP, so they are always there.
  assert.deepEqual(servers[1], { name: 'local', command: './tools/mcp', args: [], env: [] });
  assert.deepEqual(servers[4], { type: 'sse', name: 'events', url: 'https://mcp.example.org/sse', headers: [] });
});

test('refuses servers the agents would refuse', () => {
  const bad = (servers, pattern) => assert.throws(() => parseMcpServers(JSON.stringify(servers)), pattern);
  bad({}, /JSON list/);
  bad([{ name: 'has space', command: 'x' }], /names are 1 to 32/);
  bad([{ name: 'a'.repeat(33), command: 'x' }], /names are 1 to 32/);
  bad([{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }], /Two MCP servers are named a/);
  bad([{ name: 'a' }], /needs a command/);
  bad([{ name: 'a', type: 'http', url: 'ftp://x' }], /http or https url/);
  bad([{ name: 'a', type: 'websocket', url: 'https://x' }], /unknown type/);
  bad([{ name: 'a', command: 'x', args: [1] }], /args must be strings/);
  bad([{ name: 'a', command: 'x', env: { A: 'b' } }], /env must be a list/);
});

test('gives an agent the transports it supports, with commands found in PATH', (t) => {
  const servers = parseMcpServers(JSON.stringify(configured));
  const bin = mkdtempSync(join(tmpdir(), 'codeflower-mcp-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'files-mcp'), '#!/bin/sh\n');
  chmodSync(join(bin, 'files-mcp'), 0o755);
  // Not executable: not a command.
  writeFileSync(join(bin, 'no-such-mcp-server'), '');
  const path = ['/nonexistent', bin].join(delimiter);
  const initialized = { agentCapabilities: { mcpCapabilities: { http: true, sse: false } } };
  const chosen = mcpServersFor(servers, initialized, { path, workspace: '/workspace' });
  assert.deepEqual(
    chosen.servers.map((server) => server.name),
    ['files', 'local', 'docs']
  );
  assert.equal(chosen.servers[0].command, join(bin, 'files-mcp'));
  assert.equal(chosen.servers[1].command, '/workspace/tools/mcp');
  assert.equal(
    describeLeftOut(chosen.skipped),
    'gone (no-such-mcp-server is not in the sandbox), events (the agent does not support sse servers)'
  );

  // An agent that names no remote transports gets stdio servers only.
  assert.deepEqual(
    mcpServersFor(servers, {}, { path, workspace: '/workspace' }).servers.map((server) => server.name),
    ['files', 'local']
  );
});

test("keeps a window's own servers and adds the configured ones it does not name", () => {
  const own = { name: 'files', command: '/bin/own', args: [], env: [] };
  const params = withMcpServers({ cwd: '/w', mcpServers: [own] }, [
    { name: 'files', command: '/bin/configured', args: [], env: [] },
    { name: 'docs', type: 'http', url: 'https://x', headers: [] }
  ]);
  assert.deepEqual(params.mcpServers.map((server) => server.command ?? server.url), ['/bin/own', 'https://x']);
  assert.deepEqual(withMcpServers({ cwd: '/w' }, []).mcpServers, []);
});

test('finds the server a failed session start names, as dsh reports it', () => {
  const given = [{ name: 'docs' }, { name: 'files' }];
  const dsh = (name) => ({
    code: -32603,
    message: 'Internal error',
    data: { details: `mcp-client(${name}): initial connection or tool synchronization failed` }
  });
  assert.deepEqual(failedMcpServers(dsh('files'), given), ['files']);
  // A server the window gave itself: its error stands.
  assert.deepEqual(failedMcpServers(dsh('mine'), given), []);
  // About MCP without a name: all the bridge added are left out.
  assert.deepEqual(failedMcpServers({ message: 'MCP startup failed' }, given), ['docs', 'files']);
  // Anything else, or nothing added: no retry.
  assert.deepEqual(failedMcpServers({ code: -32000, message: 'Authentication required' }, given), []);
  assert.deepEqual(failedMcpServers({ message: 'mcpServers[0].command must be an absolute path' }, given), []);
  assert.deepEqual(failedMcpServers(dsh('files'), []), []);
});
