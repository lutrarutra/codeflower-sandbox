import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { createActivity } from '../src/activity.js';
import { createAgents } from '../src/agents.js';
import { inputCommands, navigableUrl } from '../src/browser/browser.js';
import { chromiumArguments } from '../src/browser/chromium.js';
import { createMux } from '../src/browser/mux.js';
import { startBridge } from '../src/server.js';
import { sessionKey } from '../src/sessions.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-acp.js', import.meta.url));
const fakeChromium = fileURLToPath(new URL('../fixtures/fake-chromium.js', import.meta.url));
const browserCommand = fileURLToPath(new URL('../../../bin/codeflower-browser', import.meta.url));
const token = 'k'.repeat(43);

test('turns the view\'s events into CDP input and drops what is not one', () => {
  const commands = inputCommands([
    { type: 'mouse', action: 'down', x: 10.5, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 },
    { type: 'mouse', action: 'fly', x: 1, y: 1 },
    { type: 'wheel', x: 1, y: 2, deltaY: 120 },
    { type: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' },
    { type: 'key', action: 'down', key: 'Enter', code: 'Enter', keyCode: 13 },
    { type: 'key', action: 'up', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' },
    { type: 'text', text: 'pässword' },
    { type: 'text', text: '' },
    null,
    'click'
  ]);
  assert.deepEqual(
    commands.map(([method, params]) => [method, params.type ?? params.text]),
    [
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseWheel'],
      ['Input.dispatchKeyEvent', 'keyDown'],
      ['Input.dispatchKeyEvent', 'rawKeyDown'],
      ['Input.dispatchKeyEvent', 'keyUp'],
      ['Input.insertText', 'pässword']
    ]
  );
  assert.equal(commands[0][1].button, 'left');
  assert.equal(commands[0][1].modifiers, 2);
  assert.equal(commands[2][1].text, 'a');
  // Only a key going down types.
  assert.equal(commands[4][1].text, undefined);
});

test('the address bar goes to web pages only', () => {
  assert.equal(navigableUrl('example.org/a'), 'https://example.org/a');
  assert.equal(navigableUrl('localhost:8050'), 'http://localhost:8050/');
  assert.equal(navigableUrl('http://127.0.0.1:3838/app'), 'http://127.0.0.1:3838/app');
  assert.equal(navigableUrl('about:blank'), 'about:blank');
  assert.equal(navigableUrl('javascript:alert(1)'), undefined);
  assert.equal(navigableUrl('file:///codeflower-state/run'), undefined);
  assert.equal(navigableUrl('  '), undefined);
});

test('starts Chromium on a pipe, with the sandbox\'s proxy and no DevTools port', () => {
  const args = chromiumArguments({ profile: '/state/browser/claude-1', proxy: 'http://127.0.0.1:3128' });
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(!args.some((arg) => arg.startsWith('--remote-debugging-port')));
  assert.ok(args.includes('--user-data-dir=/state/browser/claude-1'));
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:3128'));
  assert.ok(args.includes('--proxy-bypass-list=localhost;127.0.0.1;[::1]'));
  assert.ok(!chromiumArguments({ profile: '/p' }).some((arg) => arg.startsWith('--proxy-server')));
});

test('the mux keeps the bridge\'s and the client\'s ids and sessions apart', async () => {
  const toChromium = [];
  const followed = [];
  const mux = createMux((message) => toChromium.push(message) > 0, { onClientTab: (targetId) => followed.push(targetId) });
  const bridgeEvents = [];
  mux.listen((message) => bridgeEvents.push(message));

  // The bridge's own browser session.
  const attached = mux.call('Target.attachToBrowserTarget');
  mux.receive({ id: toChromium.at(-1).id, result: { sessionId: 'own' } });
  assert.deepEqual(await attached, { sessionId: 'own' });

  const fromChromium = [];
  const link = mux.attach({ send: (message) => fromChromium.push(message), close() {} });
  // The client's id 1 goes out under another id and comes back as 1.
  link.receive({ id: 1, method: 'Browser.getVersion', params: {} });
  const sent = toChromium.at(-1);
  assert.equal(sent.method, 'Browser.getVersion');
  assert.notEqual(sent.id, 1);
  mux.receive({ id: sent.id, result: { product: 'x' } });
  assert.deepEqual(fromChromium.at(-1), { id: 1, result: { product: 'x' } });

  // Closing the browser is refused; the bridge's sessions are not the client's.
  link.receive({ id: 2, method: 'Browser.close' });
  assert.deepEqual(fromChromium.at(-1), { id: 2, result: {} });
  link.receive({ id: 3, method: 'Page.enable', sessionId: 'own' });
  assert.equal(fromChromium.at(-1).error.message, 'Session not found');

  // Events: the bridge's sessions to the bridge, the rest to the client.
  mux.receive({ method: 'Target.targetCreated', sessionId: 'own', params: { targetInfo: { targetId: 'p' } } });
  mux.receive({ method: 'Target.attachedToTarget', params: { sessionId: 'theirs', targetInfo: { targetId: 'p', type: 'page' } } });
  assert.equal(bridgeEvents.length, 1);
  assert.equal(fromChromium.at(-1).method, 'Target.attachedToTarget');

  // While the user has the browser, the client may look but not act.
  let held = false;
  const guarded = createMux((message) => toChromium.push(message) > 0, { held: () => held });
  const guardedReplies = [];
  const guardedLink = guarded.attach({ send: (message) => guardedReplies.push(message), close() {} });
  held = true;
  const sentBefore = toChromium.length;
  guardedLink.receive({ id: 7, method: 'Input.dispatchMouseEvent', sessionId: 's', params: {} });
  guardedLink.receive({ id: 8, method: 'Page.navigate', sessionId: 's', params: { url: 'https://example.org' } });
  assert.deepEqual(guardedReplies.map((message) => [message.id, message.error?.message]), [
    [7, 'The user controls this browser now; wait until they hand it back'],
    [8, 'The user controls this browser now; wait until they hand it back']
  ]);
  guardedLink.receive({ id: 9, method: 'Runtime.evaluate', sessionId: 's', params: {} });
  assert.equal(toChromium.length, sentBefore + 1, 'reading the page still goes');
  held = false;
  guardedLink.receive({ id: 10, method: 'Input.insertText', sessionId: 's', params: { text: 'x' } });
  assert.equal(toChromium.at(-1).method, 'Input.insertText');

  // Typing in a tab makes it the one shown; reading it does not.
  link.receive({ id: 4, method: 'Runtime.evaluate', sessionId: 'theirs', params: {} });
  link.receive({ id: 5, method: 'Input.insertText', sessionId: 'theirs', params: { text: 'x' } });
  assert.deepEqual(followed, ['p']);

  // When the client goes, what it attached is let go and nothing waits for it.
  const before = toChromium.length;
  link.detach();
  const released = toChromium.slice(before);
  assert.ok(released.some((message) => message.method === 'Target.setAutoAttach' && message.params.waitForDebuggerOnStart === false));
  assert.ok(released.some((message) => message.method === 'Target.detachFromTarget' && message.params.sessionId === 'theirs'));
  assert.equal(mux.attached, false);
});

test('a handoff makes the chat wait for the user', () => {
  const activity = createActivity();
  activity.handoff('browser:s1', 's1');
  assert.deepEqual(activity.snapshot().chats, [{ sessionId: 's1', state: 'waiting', waitingFor: 'browser', turn: false }]);
  activity.answered('browser:s1');
  assert.deepEqual(activity.snapshot().chats, []);
});

// ---- through the bridge ----

function track(socket) {
  socket.inbox = [];
  socket.waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = socket.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) socket.inbox.push(message);
    else socket.waiters.splice(index, 1)[0].resolve(message);
  });
  return socket;
}

function receive(socket, predicate) {
  const index = socket.inbox.findIndex(predicate);
  if (index !== -1) return Promise.resolve(socket.inbox.splice(index, 1)[0]);
  return new Promise((resolve) => socket.waiters.push({ predicate, resolve }));
}

let nextId = 1;
async function call(socket, method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const reply = await receive(socket, (message) => message.id === id && message.method === undefined);
  return reply;
}

async function open(address, agent) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/acp${agent ? `?agent=${agent}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
  await once(socket, 'open');
  return track(socket);
}

async function startBrowserBridge(t, { browserBinary = fakeChromium } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-browser-'));
  const sessionsDirectory = join(directory, 'state', 'sessions');
  const workspace = join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const environment = { ...process.env, CODEFLOWER_TOKEN: token, CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  await mkdir(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  const agents = createAgents({ nodePath: process.execPath, launch: { claude: fakeAgent }, environment });
  const browserSocket = join(directory, 'browser.sock');
  const bridge = await startBridge({
    host: '127.0.0.1',
    advertiseHost: 'localhost',
    token,
    connectionFile: join(directory, 'instance.json'),
    instanceId: 'instance-test',
    sessionsDirectory,
    workspace,
    agents: { claude: agents.claude },
    environment,
    browserSocket,
    browserBinary,
    showSocket: join(directory, 'show.sock'),
    log: (message) => process.env.BRIDGE_DEBUG && console.error(message)
  });
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  // The agent's commands: codeflower-browser with what the agent exports.
  const browser = (sessionId, ...args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [browserCommand, ...args],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CODEFLOWER_BROWSER_SOCKET: browserSocket,
            CODEFLOWER_AGENT_NAME: 'claude',
            ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}),
            // No playwright-cli in tests: a stand-in that prints its arguments.
            CODEFLOWER_PLAYWRIGHT_CLI: join(directory, 'playwright-cli')
          }
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
      );
    });
  await writeFile(join(directory, 'playwright-cli'), '#!/bin/sh\necho "playwright-cli $PLAYWRIGHT_CLI_SESSION $*"\n', { mode: 0o755 });
  return { bridge, directory, browser };
}

test('gives the agent its chat\'s browser, which windows watch and the user takes over', async (t) => {
  const { bridge, directory, browser } = await startBrowserBridge(t);
  const chat = await open(bridge.address, 'claude');
  const window = await open(bridge.address);
  t.after(() => {
    chat.close();
    window.close();
  });
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(chat, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const key = sessionKey('claude', sessionId);

  // No chat named and none working: the bridge cannot tell whose browser it is.
  assert.match((await browser(undefined, 'snapshot')).stderr, /No chat is working/);
  // Commands of its own and other sessions are refused.
  assert.match((await browser(sessionId, 'attach')).stderr, /runs attach itself/);
  assert.match((await browser(sessionId, '-s=other', 'snapshot')).stderr, /leave out -s/);

  // The first command starts the browser and attaches playwright-cli once.
  const snapshot = await browser(sessionId, 'snapshot');
  assert.equal(snapshot.code, 0, snapshot.stderr);
  const lines = snapshot.stdout.trim().split('\n');
  assert.equal(lines.at(-1), `playwright-cli cf-${key} snapshot`);
  const started = await receive(window, (message) => message.method === '_codeflower/browser/changed' && message.params.browser.running);
  assert.equal(started.params.browser.key, key);
  assert.ok((await stat(join(directory, 'state', 'browser', key))).isDirectory(), 'the profile is in the project state');

  // The window watches: frames come one at a time, the next after an ack.
  const listed = (await call(window, '_codeflower/browser/list')).result;
  assert.equal(listed.available, true);
  assert.deepEqual(listed.browsers.map((each) => each.key), [key]);
  await call(window, '_codeflower/browser/watch', { key });
  const first = await receive(window, (message) => message.method === '_codeflower/browser/frame');
  assert.equal(first.params.key, key);
  assert.match(Buffer.from(first.params.data, 'base64').toString(), /^frame-\d+ about:blank/);
  assert.equal(first.params.metadata.deviceWidth, 1280);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(window.inbox.filter((message) => message.method === '_codeflower/browser/frame').length, 0, 'no frame before the ack');
  await call(window, '_codeflower/browser/ack', { key, frameId: first.params.frameId });
  const second = await receive(window, (message) => message.method === '_codeflower/browser/frame');
  assert.ok(second.params.frameId > first.params.frameId);

  // Input only from the window that controls the browser.
  assert.match((await call(window, '_codeflower/browser/input', { key, events: [{ type: 'text', text: 'x' }] })).error.message, /Take control/);
  const taken = (await call(window, '_codeflower/browser/control', { key, take: true })).result.browser;
  assert.equal(taken.yours, true);
  // While the user has it, the agent waits.
  assert.match((await browser(sessionId, 'click', 'e3')).stderr, /The user controls/);
  await call(window, '_codeflower/browser/input', { key, events: [{ type: 'text', text: 'hunter' }, { type: 'key', action: 'down', key: '2', code: 'Digit2', keyCode: 50, text: '2' }] });
  await call(window, '_codeflower/browser/navigate', { key, action: 'goto', url: 'localhost:8050/alert' });
  const dialog = await receive(window, (message) => message.method === '_codeflower/browser/changed' && message.params.browser.dialog);
  assert.equal(dialog.params.browser.dialog.message, 'Hello');
  assert.equal(dialog.params.browser.url, 'http://localhost:8050/alert');
  await call(window, '_codeflower/browser/dialog', { key, accept: true });

  // What reached the page, seen through the agent's way in (the CDP proxy).
  const { cdp } = await askBridge(join(directory, 'browser.sock'), { action: 'status', agent: 'claude', sessionId }).then(() =>
    askBridge(join(directory, 'browser.sock'), { action: 'open', agent: 'claude', sessionId }).catch((error) => ({ error }))
  );
  assert.equal(cdp, undefined, 'no address for the agent while the user has the browser');
  await call(window, '_codeflower/browser/handBack', { key });
  const opened = await askBridge(join(directory, 'browser.sock'), { action: 'open', agent: 'claude', sessionId });
  const proxy = track(new WebSocket(opened.cdp));
  await once(proxy, 'open');
  proxy.send(JSON.stringify({ id: 1, method: 'Fake.typed' }));
  const typed = await receive(proxy, (message) => message.id === 1);
  assert.equal(typed.result.typed, 'hunter2');
  // The agent's client may not close the browser.
  proxy.send(JSON.stringify({ id: 2, method: 'Browser.close' }));
  assert.deepEqual((await receive(proxy, (message) => message.id === 2)).result, {});
  proxy.send(JSON.stringify({ id: 3, method: 'Browser.getVersion' }));
  assert.equal((await receive(proxy, (message) => message.id === 3)).result.product, 'FakeChromium/1.0');
  proxy.close();
  // Without the token there is no way in.
  const stranger = new WebSocket(opened.cdp.replace(/\/[0-9a-f]{48}\//, `/${'0'.repeat(48)}/`));
  const [, refused] = await once(stranger, 'unexpected-response');
  assert.equal(refused.statusCode, 404);
});

test('a handoff waits for the user, and the chat hears when they hand the browser back', async (t) => {
  const { bridge, browser } = await startBrowserBridge(t);
  const chat = await open(bridge.address, 'claude');
  const window = await open(bridge.address);
  t.after(() => {
    chat.close();
    window.close();
  });
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(chat, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  const key = sessionKey('claude', sessionId);

  assert.match((await browser(sessionId, 'handoff')).stderr, /Say what the user should do/);
  const handed = await browser(sessionId, 'handoff', 'Log in to the LIMS');
  assert.equal(handed.code, 0, handed.stderr);
  assert.match(handed.stdout, /End your turn now/);
  const changed = await receive(window, (message) => message.method === '_codeflower/browser/changed' && message.params.browser.handoff);
  assert.equal(changed.params.browser.handoff.reason, 'Log in to the LIMS');
  const waiting = (await call(window, '_codeflower/activity')).result.chats;
  assert.deepEqual(waiting.map(({ key: chatKey, state, waitingFor }) => ({ chatKey, state, waitingFor })), [{ chatKey: key, state: 'waiting', waitingFor: 'browser' }]);
  assert.match((await browser(sessionId, 'status')).stdout, /Handed to the user: Log in to the LIMS/);
  assert.match((await browser(sessionId, 'snapshot')).stderr, /The user controls/);

  await call(window, '_codeflower/browser/control', { key, take: true });
  await call(window, '_codeflower/browser/handBack', { key, note: 'Logged in as alice' });
  const prompted = await receive(chat, (message) => message.method === '_codeflower/prompted');
  assert.match(prompted.params.prompt[0].text, /The user handed the browser back: "Logged in as alice"/);
  assert.deepEqual((await call(window, '_codeflower/activity')).result.chats.filter((each) => each.waitingFor === 'browser'), []);
  const back = (await call(window, '_codeflower/browser/list')).result.browsers[0];
  assert.equal(back.controlled, false);
  assert.equal(back.handoff, undefined);

  assert.match((await browser(sessionId, 'close')).stdout, /Closed this chat's browser/);
  await receive(window, (message) => message.method === '_codeflower/browser/changed' && !message.params.browser.running);
});

test('says so when the sandbox has no browser', async (t) => {
  const { bridge, browser } = await startBrowserBridge(t, { browserBinary: '/nonexistent/chromium' });
  const chat = await open(bridge.address, 'claude');
  t.after(() => chat.close());
  await call(chat, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const sessionId = (await call(chat, 'session/new', { cwd: '/workspace', mcpServers: [] })).result.sessionId;
  assert.match((await browser(sessionId, 'snapshot')).stderr, /This sandbox has no browser/);
});

function askBridge(socketPath, request) {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ createConnection }) => {
      const socket = createConnection(socketPath);
      let reply = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk) => (reply += chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        const result = JSON.parse(reply);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      });
    });
  });
}
