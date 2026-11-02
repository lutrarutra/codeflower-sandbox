import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

import { createAgents, loadRegistry } from '../src/agents.js';
import { createParser } from '../src/agents/codex/events.js';

async function codexAgent(modules = '/opt/codeflower/runtime/node_modules') {
  const agents = (await loadRegistry()).filter(({ descriptor }) => descriptor.id === 'codex');
  return createAgents({ nodePath: 'node', modules, environment: {}, agents }).codex;
}

test('runs a shared app-server that its adapter and its terminal UI both join', async (t) => {
  const codex = await codexAgent();
  await assert.rejects(codex.tuiCommand({ sessionId: 'thread-1' }), /not running/);
  const { command, ready } = await codex.companion();
  const socket = command.at(-1).replace('unix://', '');
  assert.deepEqual(command, ['node', '/opt/codeflower/runtime/node_modules/@openai/codex/bin/codex.js', 'app-server', '--listen', `unix://${socket}`]);
  // The adapter runs the proxy as `codex`, which joins that app-server.
  assert.match(codex.env.CODEX_PATH, /agents\/codex\/proxy\.js$/);
  assert.equal(codex.env.CODEFLOWER_CODEX_SOCKET, socket);
  assert.equal(codex.env.NO_BROWSER, '1');
  assert.deepEqual(await codex.tuiCommand({ sessionId: 'thread-1' }), [
    'node',
    '/opt/codeflower/runtime/node_modules/@openai/codex/bin/codex.js',
    '-c',
    'check_for_update_on_startup=false',
    '--remote',
    `unix://${socket}`,
    'resume',
    'thread-1'
  ]);
  // Ready once the app-server listens.
  const server = createServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(socket, resolve));
  await ready();
});

test('has no terminal UI where Codex is not installed (tests, a fake agent)', async () => {
  const codex = await codexAgent(null);
  assert.equal(codex.companion, undefined);
  assert.equal(codex.tuiCommand, undefined);
  assert.equal(codex.watch, undefined);
});

test("reads the user's message and the turns from the app-server's notifications", () => {
  const events = [];
  const parse = createParser((event) => events.push(event));
  parse(JSON.stringify({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } }));
  parse(JSON.stringify({ method: 'item/started', params: { threadId: 't1', turnId: 'u1', item: { type: 'userMessage', id: 'i1', content: [{ type: 'text', text: 'hello', text_elements: [] }, { type: 'image', url: 'x' }] } } }));
  parse(JSON.stringify({ method: 'item/started', params: { threadId: 't1', turnId: 'u1', item: { type: 'agentMessage', id: 'i2', text: 'hi' } } }));
  parse(JSON.stringify({ id: 'cf-watch-2', result: { thread: {} } }));
  parse(JSON.stringify({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1' } } }));
  parse('not json');
  assert.deepEqual(events, [
    { type: 'busy', sessionId: 't1' },
    { type: 'prompt', sessionId: 't1', prompt: [{ type: 'text', text: 'hello' }] },
    { type: 'idle', sessionId: 't1' }
  ]);
});
