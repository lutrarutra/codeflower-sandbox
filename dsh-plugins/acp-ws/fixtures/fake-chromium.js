#!/usr/bin/env node
// A stand-in for Chromium with --remote-debugging-pipe: CDP on fd 3 (in) and
// fd 4 (out), NUL-delimited. Enough of it for the bridge's browser: targets,
// a screencast that waits for acks, input, navigation and a dialog. `Fake.*`
// methods let a test see what reached the page.
import { createReadStream, createWriteStream } from 'node:fs';

const input = createReadStream(null, { fd: 3 });
const output = createWriteStream(null, { fd: 4 });
const send = (message) => output.write(`${JSON.stringify(message)}\0`);
const args = process.argv.slice(2);
if (!args.includes('--remote-debugging-pipe') || !args.some((arg) => arg.startsWith('--user-data-dir='))) process.exit(3);

const pages = new Map([['page-1', { targetId: 'page-1', type: 'page', url: 'about:blank', title: '' }]]);
const sessions = new Map();
let nextSession = 1;
let browserSession;
const events = [];
let typed = '';
let frame = 0;
// Page session -> whether a frame waits for its ack.
const casting = new Map();

const pageOf = (sessionId) => pages.get(sessions.get(sessionId));
const emitFrame = (sessionId) => {
  if (!casting.has(sessionId) || casting.get(sessionId)) return;
  casting.set(sessionId, true);
  frame += 1;
  send({
    method: 'Page.screencastFrame',
    sessionId,
    params: {
      data: Buffer.from(`frame-${frame} ${pageOf(sessionId)?.url}`).toString('base64'),
      sessionId: frame,
      metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 800, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: frame }
    }
  });
};
// The page repaints now and then, like a real one with a cursor blinking.
setInterval(() => {
  for (const sessionId of casting.keys()) emitFrame(sessionId);
}, 20);

const handle = ({ id, method, params = {}, sessionId }) => {
  const reply = (result = {}) => send({ id, ...(sessionId ? { sessionId } : {}), result });
  switch (method) {
    case 'Target.attachToBrowserTarget':
      browserSession = `session-${nextSession++}`;
      return reply({ sessionId: browserSession });
    case 'Target.setDiscoverTargets':
      reply();
      if (params.discover && sessionId === browserSession) {
        for (const page of pages.values()) send({ method: 'Target.targetCreated', sessionId, params: { targetInfo: page } });
      }
      return;
    case 'Target.attachToTarget': {
      if (!pages.has(params.targetId)) return send({ id, sessionId, error: { code: -32602, message: 'No target with given id found' } });
      const child = `session-${nextSession++}`;
      sessions.set(child, params.targetId);
      send({ method: 'Target.attachedToTarget', sessionId, params: { sessionId: child, targetInfo: pages.get(params.targetId), waitingForDebugger: false } });
      return reply({ sessionId: child });
    }
    case 'Target.detachFromTarget':
      casting.delete(params.sessionId);
      sessions.delete(params.sessionId);
      return reply();
    case 'Target.createTarget': {
      const targetId = `page-${pages.size + 1}`;
      const page = { targetId, type: 'page', url: params.url ?? 'about:blank', title: '' };
      pages.set(targetId, page);
      if (browserSession) send({ method: 'Target.targetCreated', sessionId: browserSession, params: { targetInfo: page } });
      return reply({ targetId });
    }
    case 'Page.startScreencast':
      casting.set(sessionId, false);
      reply();
      return emitFrame(sessionId);
    case 'Page.screencastFrameAck':
      if (casting.has(sessionId)) casting.set(sessionId, false);
      return reply();
    case 'Page.stopScreencast':
      casting.delete(sessionId);
      return reply();
    case 'Page.navigate': {
      const page = pageOf(sessionId);
      if (!page) return reply();
      page.url = params.url;
      page.title = params.url;
      send({ method: 'Target.targetInfoChanged', sessionId: browserSession, params: { targetInfo: page } });
      if (params.url.includes('alert')) send({ method: 'Page.javascriptDialogOpening', sessionId, params: { type: 'alert', message: 'Hello', defaultPrompt: '' } });
      return reply({ frameId: 'frame' });
    }
    case 'Page.handleJavaScriptDialog':
      events.push({ method, params });
      send({ method: 'Page.javascriptDialogClosed', sessionId, params: { result: params.accept } });
      return reply();
    case 'Input.insertText':
      typed += params.text;
      events.push({ method, params });
      return reply();
    case 'Input.dispatchKeyEvent':
      if (params.text) typed += params.text;
      events.push({ method, params });
      return reply();
    case 'Input.dispatchMouseEvent':
      events.push({ method, params });
      return reply();
    case 'Browser.getVersion':
      return reply({ product: 'FakeChromium/1.0', protocolVersion: '1.3' });
    case 'Browser.close':
      // The bridge must never pass this on.
      process.exit(9);
    case 'Fake.typed':
      return reply({ typed, events });
    default:
      return reply();
  }
};

let pending = '';
input.setEncoding('utf8');
input.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\0')) !== -1) {
    const text = pending.slice(0, end);
    pending = pending.slice(end + 1);
    handle(JSON.parse(text));
  }
});
input.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
