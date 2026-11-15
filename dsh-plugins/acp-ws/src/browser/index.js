// The chats' browsers (one Chromium per chat, its profile in the project
// state), the proxy through which the agent's playwright-cli reaches its
// chat's browser, and who controls each: the agent, or a window the user took
// it over in.
import { randomBytes } from 'node:crypto';
import { access, constants, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createChatBrowser } from './browser.js';

const IDLE_MS = 15 * 60_000;
const IDLE_CHECK_MS = 60_000;
const SAFE_KEY = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_CDP_MESSAGE = 64 * 1024 * 1024;

export class BrowserError extends Error {}

// While the browser bundle installs, a command waits this long before it answers that it is still going.
const INSTALL_WAIT_MS = 100_000;

/**
 * `directory` holds each chat's profile; `onChange(key)` when a browser's
 * state changes, `onFrame(viewer, frame)` to send a frame to a window.
 * Chromium comes from `bundle` (bundle.js), installed on first use, unless
 * `binary` names one (development, tests).
 */
export function createBrowsers({
  binary,
  bundle,
  installWaitMs = INSTALL_WAIT_MS,
  directory,
  environment = process.env,
  log = () => {},
  onChange = () => {},
  onFrame = () => {},
  idleMs = IDLE_MS,
  now = Date.now
}) {
  // Key -> { browser, chat: { agent, sessionId }, controller, handoff, used }.
  const entries = new Map();
  const token = randomBytes(24).toString('hex');
  let proxy;
  let closing = false;

  const entryOf = (key) => {
    const entry = entries.get(key);
    if (!entry) throw new BrowserError('This chat has no browser');
    return entry;
  };

  const changed = (key) => {
    if (!closing) onChange(key);
  };

  // ---- the proxy for playwright-cli ----

  // ws://127.0.0.1:PORT/TOKEN/KEY: on loopback, and only with the token, as
  // other users on a shared node can reach the sandbox's loopback.
  const startProxy = async () => {
    const server = createServer((request, response) => {
      const key = keyOfPath(request.url);
      if (!key || !entries.get(key)?.browser.running) {
        response.writeHead(404).end();
        return;
      }
      // What a client that connects with an http:// address asks first.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Browser: 'Chrome/Headless', 'Protocol-Version': '1.3', webSocketDebuggerUrl: urlOf(key) }));
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CDP_MESSAGE });
    server.on('upgrade', (request, socket, head) => {
      const key = keyOfPath(request.url);
      const entry = key && entries.get(key);
      if (!entry?.browser.running) {
        socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
        return;
      }
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        let link;
        try {
          link = entry.browser.attachClient({
            send: (message) => webSocket.readyState === webSocket.OPEN && webSocket.send(JSON.stringify(message)),
            close: () => webSocket.close(1000, 'Replaced')
          });
        } catch {
          webSocket.close(1011, 'The browser is not running');
          return;
        }
        changed(key);
        webSocket.on('message', (data, isBinary) => {
          if (isBinary) return;
          entry.used = now();
          let message;
          try {
            message = JSON.parse(data.toString());
          } catch {
            return;
          }
          link.receive(message);
        });
        webSocket.once('close', () => {
          link.detach();
          changed(key);
        });
        webSocket.on('error', () => {});
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return { server, sockets, port: server.address().port };
  };

  const keyOfPath = (url) => {
    const path = (url ?? '').split('?')[0].split('/').filter(Boolean);
    if (path[0] !== token || !SAFE_KEY.test(path[1] ?? '')) return undefined;
    // /TOKEN/KEY, or /TOKEN/KEY/json/version[/] for an http:// address.
    if (path.length === 2 || (path.length === 4 && path[2] === 'json' && path[3] === 'version')) return path[1];
    return undefined;
  };
  const urlOf = (key) => `ws://127.0.0.1:${proxy.port}/${token}/${key}`;

  // ---- idle browsers stop ----

  const idleTimer = setInterval(() => {
    for (const [key, entry] of entries) {
      const { browser } = entry;
      if (!browser.running || browser.watched || entry.handoff || entry.controller) continue;
      if (now() - entry.used < idleMs) continue;
      log(`Browser of ${key} stops: unused for ${Math.round(idleMs / 60_000)} minutes`);
      void browser.stop();
    }
  }, IDLE_CHECK_MS);
  idleTimer.unref?.();

  const entryFor = (key, chat) => {
    let entry = entries.get(key);
    if (!entry) {
      const held = () => Boolean(entries.get(key)?.controller || entries.get(key)?.handoff);
      entry = {
        chat,
        controller: undefined,
        handoff: undefined,
        used: now(),
        browser: createChatBrowser({
          key,
          binary: binary ?? bundle?.binary,
          profile: join(directory, key),
          environment,
          log,
          onChange: () => changed(key),
          onFrame,
          held
        })
      };
      entries.set(key, entry);
    }
    entry.chat = chat ?? entry.chat;
    return entry;
  };

  return {
    /** Whether this sandbox has a browser to run, installed or to install. */
    async available() {
      if (binary) {
        return access(binary, constants.X_OK).then(
          () => true,
          () => false
        );
      }
      return Boolean(bundle?.supported);
    },

    /** playwright-cli of the bundle; undefined with a `binary` of its own. */
    get cli() {
      return binary ? undefined : bundle?.cli;
    },

    /** The bundle's state: installed, missing, installing (with progress), unsupported. */
    async bundleStatus() {
      if (binary) return { state: 'installed' };
      return bundle ? bundle.status() : { state: 'unsupported' };
    },

    /**
     * Installs the browser bundle if it is not (`from`: an archive in the
     * sandbox instead of the download). Throws while it still goes on after
     * a while, saying how far it got.
     */
    async install({ from, waitMs = installWaitMs } = {}) {
      if (binary) return;
      if (!bundle) throw new BrowserError('This sandbox has no browser (its image has no browser bundle)');
      if (!bundle.supported) throw new BrowserError(`The browser bundle has no build for this machine (${process.arch})`);
      const result = await bundle.ensure({ from, waitMs });
      if (result.installing) {
        throw new BrowserError(
          `Installing the browser (once per project): ${bundle.describeProgress(result)} so far. Run the command again in a minute.`
        );
      }
    },

    /**
     * The chat's browser for its agent, started if it does not run:
     * `{ cdp, attached }`, cdp being what playwright-cli attaches to.
     */
    async open(chat) {
      if (closing) throw new BrowserError('The worker is stopping');
      if (!SAFE_KEY.test(chat?.key ?? '')) throw new BrowserError('Not a chat');
      if (!(await this.available())) throw new BrowserError('This sandbox has no browser (its image has no Chromium)');
      await this.install();
      const entry = entryFor(chat.key, { agent: chat.agent, sessionId: chat.sessionId });
      entry.used = now();
      proxy ??= await startProxy();
      await entry.browser.start();
      return { cdp: urlOf(chat.key), attached: entry.browser.attached };
    },

    /** The chat's browser as windows see it, for `viewer` (whether it controls it). */
    describe(key, viewer) {
      const entry = entries.get(key);
      if (!entry) return { key, running: false, tabs: [], url: '', title: '' };
      return {
        ...entry.browser.describe(),
        agent: entry.chat?.agent,
        attached: entry.browser.attached,
        controlled: Boolean(entry.controller),
        ...(viewer && entry.controller === viewer ? { yours: true } : {}),
        ...(entry.handoff ? { handoff: entry.handoff } : {})
      };
    },

    /** The chats that have a browser (running or not), by key. */
    keys() {
      return [...entries.keys()];
    },

    /** The chat a browser is of: `{ agent, sessionId }`. */
    chatOf(key) {
      return entries.get(key)?.chat;
    },

    /** Whether the user controls the chat's browser (so the agent waits). */
    controlled(key) {
      const entry = entries.get(key);
      return Boolean(entry?.controller || entry?.handoff);
    },

    // ---- the agent asks the user to take over ----

    handoff(key, reason) {
      const entry = entryOf(key);
      entry.handoff = { reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : 'The agent needs you in the browser', at: new Date(now()).toISOString() };
      changed(key);
    },

    /** The user is done: control goes back to the agent. Returns the chat, or undefined if no handoff waited. */
    handBack(key) {
      const entry = entryOf(key);
      const waited = Boolean(entry.handoff);
      entry.handoff = undefined;
      entry.controller = undefined;
      entry.used = now();
      changed(key);
      return waited ? entry.chat : undefined;
    },

    // ---- windows ----

    control(key, viewer, take) {
      const entry = entryOf(key);
      if (take) entry.controller = viewer;
      else if (entry.controller === viewer) entry.controller = undefined;
      changed(key);
    },

    /** The window must control the browser for this. */
    controlling(key, viewer) {
      const entry = entryOf(key);
      if (entry.controller !== viewer) throw new BrowserError('Take control of the browser first');
      entry.used = now();
      return entry.browser;
    },

    async watch(key, viewer, options) {
      const entry = entryOf(key);
      if (!entry.browser.running) throw new BrowserError('The browser is not running');
      await entry.browser.watch(viewer, options);
    },

    async unwatch(key, viewer) {
      await entries.get(key)?.browser.unwatch(viewer);
    },

    ack(key, viewer, frameId) {
      entries.get(key)?.browser.ack(viewer, frameId);
    },

    browserOf(key) {
      return entryOf(key).browser;
    },

    /** A window went: it watches nothing and controls nothing. */
    detachViewer(viewer) {
      for (const [key, entry] of entries) {
        void entry.browser.unwatch(viewer);
        if (entry.controller === viewer) {
          entry.controller = undefined;
          changed(key);
        }
      }
    },

    async stop(key) {
      await entries.get(key)?.browser.stop();
    },

    /** The chat is deleted: its browser stops and its profile goes. */
    async remove(key) {
      const entry = entries.get(key);
      entries.delete(key);
      await entry?.browser.stop();
      if (SAFE_KEY.test(key)) await rm(join(directory, key), { recursive: true, force: true });
    },

    async closeAll() {
      closing = true;
      clearInterval(idleTimer);
      await Promise.all([...entries.values()].map((entry) => entry.browser.stop()));
      if (proxy) {
        for (const client of proxy.sockets.clients) client.terminate();
        proxy.sockets.close();
        await new Promise((resolve) => proxy.server.close(resolve));
      }
    }
  };
}
