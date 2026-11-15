// One chat's browser as windows see it: its tabs, a screencast of the shown
// tab to each window that watches, and the user's input when they control it.
// The agent drives the same browser through the mux's outside client.
import { launchChromium } from './chromium.js';
import { createMux } from './mux.js';

const DEFAULT_SCREENCAST = { quality: 60, maxWidth: 1280, maxHeight: 800 };
// A window that does not answer a frame this long gets the next one anyway.
const ACK_TIMEOUT_MS = 5000;
const MAX_TEXT = 10_000;
const MAX_URL = 8000;
const BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);
const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };

// A command that waits on the page (a navigation behind a dialog) answers the window this soon.
const CALL_TIMEOUT_MS = 10_000;

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const integer = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);
const text = (value, max = MAX_TEXT) => (typeof value === 'string' ? value.slice(0, max) : undefined);

// The command's result, or that the page did not answer in time.
function within(promise, ms = CALL_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The page did not answer in time')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/** CDP input commands for the user's events (from the browser view), in order; bad events are dropped. */
export function inputCommands(events) {
  const commands = [];
  for (const event of Array.isArray(events) ? events.slice(0, 200) : []) {
    if (typeof event !== 'object' || event === null) continue;
    const modifiers = integer(event.modifiers, 0, 15, 0);
    if (event.type === 'mouse' && MOUSE_TYPES[event.action]) {
      commands.push([
        'Input.dispatchMouseEvent',
        {
          type: MOUSE_TYPES[event.action],
          x: finite(event.x),
          y: finite(event.y),
          button: BUTTONS.has(event.button) ? event.button : 'none',
          buttons: integer(event.buttons, 0, 31, 0),
          clickCount: integer(event.clickCount, 0, 3, 0),
          modifiers
        }
      ]);
    } else if (event.type === 'wheel') {
      commands.push([
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: finite(event.x), y: finite(event.y), deltaX: finite(event.deltaX), deltaY: finite(event.deltaY), modifiers }
      ]);
    } else if (event.type === 'key' && (event.action === 'down' || event.action === 'up')) {
      const key = text(event.key, 32);
      if (!key) continue;
      const typed = event.action === 'down' ? text(event.text, 8) : undefined;
      const keyCode = integer(event.keyCode, 0, 255, 0);
      commands.push([
        'Input.dispatchKeyEvent',
        {
          // A key that types something is keyDown with its text, others rawKeyDown.
          type: event.action === 'up' ? 'keyUp' : typed ? 'keyDown' : 'rawKeyDown',
          key,
          code: text(event.code, 32) ?? '',
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
          location: integer(event.location, 0, 3, 0),
          modifiers,
          ...(typed ? { text: typed, unmodifiedText: typed } : {})
        }
      ]);
    } else if (event.type === 'text') {
      const typed = text(event.text);
      if (typed) commands.push(['Input.insertText', { text: typed }]);
    }
  }
  return commands;
}

/** Where the view's address bar may go: web pages and about:blank. */
export function navigableUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL) return undefined;
  let candidate = value.trim();
  // A scheme only when it is one (localhost:8050 is a host and port).
  if (!/^([a-z][a-z0-9+.-]*:\/\/|(about|javascript|data|file|blob|view-source|chrome|mailto):)/i.test(candidate)) {
    candidate = `${/^(localhost|127\.|\[::1\])/i.test(candidate) ? 'http' : 'https'}://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank') return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * A chat's browser. `onChange` when what windows show of it changes (tabs,
 * address, dialog, running), `onFrame(viewer, frame)` to send a frame.
 */
export function createChatBrowser({ key, binary, profile, environment, log = () => {}, onChange = () => {}, onFrame = () => {}, held = () => false }) {
  let chromium;
  let mux;
  let starting;
  let browserSession;
  // Page targets by id, in the order they opened, and the one shown.
  const tabs = new Map();
  let selected;
  // The shown tab's session of the bridge's own, and whether it casts.
  let page;
  let casting = false;
  let dialog;
  // Viewer -> { sent, inFlight, timer, options }.
  const viewers = new Map();
  let latest;
  let frameCount = 0;
  // Tab changes one after another.
  let switching = Promise.resolve();

  const describeTab = (tab) => ({ targetId: tab.targetId, url: tab.url, title: tab.title });

  const sendFrame = (viewer, state) => {
    if (!latest || state.inFlight !== undefined || state.sent >= latest.frameId) return;
    state.sent = latest.frameId;
    state.inFlight = latest.frameId;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.inFlight = undefined;
      sendFrame(viewer, state);
    }, ACK_TIMEOUT_MS);
    state.timer.unref?.();
    onFrame(viewer, { key, frameId: latest.frameId, data: latest.data, metadata: latest.metadata });
  };

  const screencastOptions = () => {
    const options = { ...DEFAULT_SCREENCAST };
    for (const state of viewers.values()) {
      options.maxWidth = Math.max(options.maxWidth, state.options.maxWidth ?? 0);
      options.maxHeight = Math.max(options.maxHeight, state.options.maxHeight ?? 0);
      if (state.options.quality) options.quality = state.options.quality;
    }
    return options;
  };

  const startCasting = async () => {
    if (!page || casting || !viewers.size) return;
    casting = true;
    await mux.call('Page.startScreencast', { format: 'jpeg', everyNthFrame: 1, ...screencastOptions() }, page.sessionId);
  };

  const stopCasting = async () => {
    if (!page || !casting) return;
    casting = false;
    await mux.call('Page.stopScreencast', {}, page.sessionId).catch(() => {});
  };

  // Shows another tab: the bridge's session moves to it.
  const show = (targetId) => {
    switching = switching.then(async () => {
      if (!mux || page?.targetId === targetId) return;
      if (page) {
        const old = page;
        page = undefined;
        casting = false;
        await mux.call('Target.detachFromTarget', { sessionId: old.sessionId }, browserSession).catch(() => {});
      }
      selected = targetId;
      dialog = undefined;
      onChange();
      if (!targetId || !tabs.has(targetId)) return;
      const { sessionId } = await mux.call('Target.attachToTarget', { targetId, flatten: true }, browserSession);
      page = { targetId, sessionId };
      await mux.call('Page.enable', {}, sessionId);
      await startCasting();
    }).catch((error) => log(`Browser of ${key}: could not show a tab: ${error.message}`));
    return switching;
  };

  const onEvent = (message) => {
    const { method, params = {}, sessionId } = message;
    if (sessionId === browserSession) {
      const info = params.targetInfo;
      if (method === 'Target.targetCreated' && info?.type === 'page') {
        tabs.set(info.targetId, { targetId: info.targetId, url: info.url, title: info.title });
        // The newest tab is the one the agent works in, mostly.
        void show(info.targetId);
        onChange();
      } else if (method === 'Target.targetInfoChanged' && tabs.has(info?.targetId)) {
        tabs.set(info.targetId, { targetId: info.targetId, url: info.url, title: info.title });
        onChange();
      } else if (method === 'Target.targetDestroyed' && tabs.delete(params.targetId)) {
        if (selected === params.targetId) {
          if (page?.targetId === params.targetId) {
            page = undefined;
            casting = false;
          }
          void show([...tabs.keys()].at(-1));
        }
        onChange();
      }
      return;
    }
    if (!page || sessionId !== page.sessionId) return;
    if (method === 'Page.screencastFrame') {
      void mux.call('Page.screencastFrameAck', { sessionId: params.sessionId }, page.sessionId).catch(() => {});
      latest = { frameId: ++frameCount, data: params.data, metadata: params.metadata };
      for (const [viewer, state] of viewers) sendFrame(viewer, state);
    } else if (method === 'Page.javascriptDialogOpening') {
      dialog = { type: params.type, message: text(params.message, 2000) ?? '', defaultPrompt: text(params.defaultPrompt, 2000) };
      onChange();
    } else if (method === 'Page.javascriptDialogClosed') {
      dialog = undefined;
      onChange();
    }
  };

  const reset = () => {
    chromium = undefined;
    mux = undefined;
    browserSession = undefined;
    page = undefined;
    casting = false;
    dialog = undefined;
    selected = undefined;
    tabs.clear();
    latest = undefined;
    switching = Promise.resolve();
  };

  const requirePage = () => {
    if (!page) throw new Error('The browser shows no tab');
    return page;
  };

  return {
    key,

    get running() {
      return Boolean(chromium?.running);
    },

    /** Whether the agent's playwright-cli is connected. */
    get attached() {
      return Boolean(mux?.attached);
    },

    /** Starts Chromium if it does not run. */
    start() {
      if (chromium?.running) return Promise.resolve();
      starting ??= (async () => {
        const startedMux = createMux((message) => chromium?.send(message) ?? false, {
          // While the user has the browser, the agent's client only looks.
          held,
          // The view shows the tab the agent works in.
          onClientTab: (targetId) => {
            if (targetId !== selected && tabs.has(targetId)) void show(targetId);
          }
        });
        mux = startedMux;
        chromium = await launchChromium({
          binary,
          profile,
          environment,
          onMessage: (message) => startedMux.receive(message),
          onExit: ({ code, signal, error, stderr }) => {
            if (mux !== startedMux) return;
            startedMux.fail();
            reset();
            const why = error?.message ?? (signal ? `signal ${signal}` : `code ${code}`);
            log(`Browser of ${key} stopped (${why})${stderr ? `: ${stderr.split('\n').at(-1)}` : ''}`);
            onChange();
          }
        });
        mux.listen(onEvent);
        ({ sessionId: browserSession } = await mux.call('Target.attachToBrowserTarget'));
        await mux.call('Target.setDiscoverTargets', { discover: true }, browserSession);
        log(`Browser of ${key} started (pid ${chromium.pid})`);
        onChange();
      })()
        .catch(async (error) => {
          await chromium?.stop();
          reset();
          throw error;
        })
        .finally(() => {
          starting = undefined;
        });
      return starting;
    },

    async stop() {
      for (const state of viewers.values()) clearTimeout(state.timer);
      const running = chromium;
      mux?.fail();
      reset();
      await running?.stop();
      onChange();
    },

    /** The agent's playwright-cli, through the proxy: `{ send, close }`. */
    attachClient(client) {
      if (!mux) throw new Error('The browser is not running');
      return mux.attach(client);
    },

    describe() {
      const shown = tabs.get(selected);
      return {
        key,
        running: this.running,
        tabs: [...tabs.values()].map(describeTab),
        ...(selected ? { selected } : {}),
        url: shown?.url ?? '',
        title: shown?.title ?? '',
        ...(dialog ? { dialog } : {})
      };
    },

    // ---- windows ----

    async watch(viewer, options = {}) {
      const state = viewers.get(viewer) ?? { sent: 0 };
      state.options = {
        quality: integer(options.quality, 10, 100, undefined),
        maxWidth: integer(options.maxWidth, 100, 4096, undefined),
        maxHeight: integer(options.maxHeight, 100, 4096, undefined)
      };
      viewers.set(viewer, state);
      // The latest frame at once, so the view is not empty while the page is still.
      state.sent = 0;
      state.inFlight = undefined;
      sendFrame(viewer, state);
      await switching;
      await startCasting();
    },

    async unwatch(viewer) {
      const state = viewers.get(viewer);
      if (!state) return;
      clearTimeout(state.timer);
      viewers.delete(viewer);
      if (!viewers.size) await stopCasting();
    },

    get watched() {
      return viewers.size > 0;
    },

    ack(viewer, frameId) {
      const state = viewers.get(viewer);
      if (!state || state.inFlight !== frameId) return;
      clearTimeout(state.timer);
      state.inFlight = undefined;
      sendFrame(viewer, state);
    },

    async selectTab(targetId) {
      if (!tabs.has(targetId)) throw new Error('No such tab');
      await show(targetId);
    },

    // Sent in order without waiting for each: Chromium answers a click only
    // once its handlers ran, which an alert() it opens holds up.
    input(events) {
      const { sessionId } = requirePage();
      for (const [method, params] of inputCommands(events)) {
        void mux.call(method, params, sessionId).catch((error) => log(`Browser of ${key}: ${error.message}`));
      }
    },

    async navigate(action, url) {
      const { sessionId } = requirePage();
      const call = (method, params) => within(mux.call(method, params, sessionId));
      if (action === 'goto') {
        const href = navigableUrl(url);
        if (!href) throw new Error('Not a web address');
        await call('Page.navigate', { url: href });
      } else if (action === 'reload') {
        await call('Page.reload', {});
      } else if (action === 'back' || action === 'forward') {
        const { currentIndex, entries } = await call('Page.getNavigationHistory', {});
        const entry = entries[currentIndex + (action === 'back' ? -1 : 1)];
        if (entry) await call('Page.navigateToHistoryEntry', { entryId: entry.id });
      } else {
        throw new Error('Unknown navigation');
      }
    },

    async answerDialog(accept, promptText) {
      const { sessionId } = requirePage();
      await within(mux.call('Page.handleJavaScriptDialog', { accept: accept === true, ...(typeof promptText === 'string' ? { promptText: promptText.slice(0, MAX_TEXT) } : {}) }, sessionId));
      dialog = undefined;
      onChange();
    }
  };
}
