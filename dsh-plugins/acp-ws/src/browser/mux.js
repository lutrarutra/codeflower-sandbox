// Shares one Chromium's CDP pipe between the bridge (screencast, the user's
// input) and one outside client (the agent's playwright-cli, through the
// proxy). Ids are rewritten so the two never collide. The bridge works only
// in sessions of its own, from Target.attachToBrowserTarget and
// Target.attachToTarget: events of those come to the bridge, every other
// event goes to the client, so neither sees what the other turned on.

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'failed'}`);
    this.code = error?.code;
  }
}

// What the client may not do to the browser the bridge keeps.
const REFUSED = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess']);
const ATTACHING = new Set(['Target.attachToTarget', 'Target.attachToBrowserTarget']);
// What the client does in a tab that makes it the one the user should see.
const FOLLOWED = /^(Input\.|Page\.(navigate|reload|navigateToHistoryEntry|bringToFront)$)/;

// What the client may not do while the user has the browser: act on the page
// (reading it, e.g. a snapshot, still works).
const ACTING = /^(Input\.|Page\.(navigate|reload|navigateToHistoryEntry)$|Target\.(createTarget|closeTarget|activateTarget)$)/;
export const HELD_MESSAGE = 'The user controls this browser now; wait until they hand it back';

/**
 * `onClientTab(targetId)`: the client acted in that tab (typed, clicked,
 * navigated, selected it). `held()`: the user has the browser, so the client
 * may only look.
 */
export function createMux(send, { onClientTab = () => {}, held = () => false } = {}) {
  let nextId = 1;
  // Pipe id -> { method, resolve, reject } (the bridge's) or { client, id } (the client's).
  const pending = new Map();
  const ownSessions = new Set();
  const listeners = new Set();
  // The one outside client: { send(message), close() }, and the sessions it
  // attached, with the tab each is of.
  let client;
  let clientSessions = new Map();

  const toClient = (message) => {
    if (!client) return;
    if (message.method === 'Target.attachedToTarget' && typeof message.params?.sessionId === 'string') {
      const info = message.params.targetInfo;
      clientSessions.set(message.params.sessionId, info?.type === 'page' ? info.targetId : undefined);
    }
    if (message.method === 'Target.detachedFromTarget') clientSessions.delete(message.params?.sessionId);
    client.send(message);
  };

  return {
    /** A message from Chromium. */
    receive(message) {
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (entry.client) {
          if (entry.client === client) client.send({ ...message, id: entry.id });
          return;
        }
        if (message.error) {
          entry.reject(new CdpError(entry.method, message.error));
          return;
        }
        if (ATTACHING.has(entry.method) && typeof message.result?.sessionId === 'string') ownSessions.add(message.result.sessionId);
        entry.resolve(message.result ?? {});
        return;
      }
      if (typeof message.sessionId === 'string' && ownSessions.has(message.sessionId)) {
        if (message.method === 'Target.detachedFromTarget') ownSessions.delete(message.params?.sessionId);
        for (const listener of listeners) listener(message);
        return;
      }
      toClient(message);
    },

    /** The bridge's own command; resolves with its result. */
    call(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        if (!send({ id, method, params, ...(sessionId ? { sessionId } : {}) })) {
          pending.delete(id);
          reject(new CdpError(method, { message: 'the browser is not running' }));
        }
      });
    },

    /** Events of the bridge's own sessions. */
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get attached() {
      return Boolean(client);
    },

    /**
     * The outside client, which replaces any earlier one. Returns what its
     * messages go through, and `detach` for when it leaves.
     */
    attach(next) {
      const previous = client;
      const previousSessions = clientSessions;
      client = next;
      clientSessions = new Map();
      if (previous) {
        previous.close();
        this.released(previousSessions);
      }
      return {
        receive: (message) => {
          if (client !== next || typeof message !== 'object' || message === null || message.id === undefined) return;
          const reply = (body) => next.send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), ...body });
          if (typeof message.method !== 'string') return reply({ error: { code: -32600, message: 'Invalid request' } });
          if (REFUSED.has(message.method)) return reply({ result: {} });
          if (typeof message.sessionId === 'string' && ownSessions.has(message.sessionId)) {
            return reply({ error: { code: -32001, message: 'Session not found' } });
          }
          if (ACTING.test(message.method) && held()) return reply({ error: { code: -32000, message: HELD_MESSAGE } });
          const tab = typeof message.sessionId === 'string' ? clientSessions.get(message.sessionId) : undefined;
          if (tab && FOLLOWED.test(message.method)) onClientTab(tab);
          const id = nextId++;
          pending.set(id, { client: next, id: message.id });
          if (!send({ ...message, id })) {
            pending.delete(id);
            reply({ error: { code: -32000, message: 'The browser is not running' } });
          }
        },
        detach: () => {
          if (client !== next) return;
          client = undefined;
          const sessions = clientSessions;
          clientSessions = new Map();
          this.released(sessions);
        }
      };
    },

    // A client left: what it attached and asked for goes, so the browser does
    // not wait for it (Playwright pauses new targets for its debugger).
    released(sessions) {
      const ignore = () => {};
      void this.call('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(ignore);
      void this.call('Target.setDiscoverTargets', { discover: false }).catch(ignore);
      for (const sessionId of sessions.keys()) void this.call('Target.detachFromTarget', { sessionId }).catch(ignore);
    },

    /** Everything waiting fails: the browser stopped. */
    fail(reason = 'the browser stopped') {
      for (const [id, entry] of pending) {
        pending.delete(id);
        if (entry.client) {
          if (entry.client === client) client.send({ id: entry.id, error: { code: -32000, message: reason } });
        } else {
          entry.reject(new CdpError(entry.method, { message: reason }));
        }
      }
      ownSessions.clear();
      client?.close();
      client = undefined;
      clientSessions = new Map();
    }
  };
}
