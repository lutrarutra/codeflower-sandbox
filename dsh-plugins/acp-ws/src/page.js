// The chat page, served by the worker itself (`codeflower interactive
// --server`): one link opens this sandbox's chats in a browser, like
// Jupyter's. The page is codeflower-ui's, built into the image; the worker
// answers the part of the app's page API that one sandbox needs, in the same
// shapes (codeflower-ui's src/web/lib/api.ts), so the page works the same as
// in the app, in its single-sandbox mode.
//
// The link carries the worker's token as `?key=`, which the page keeps in its
// own storage and sends as a bearer token, as with the app's client; the
// chat's WebSocket, which cannot send headers, opens with a one-time ticket
// from POST /api/ticket. Not a cookie: browsers send cookies to every port of
// a host, so any other server on it would receive the token. Whoever has it
// controls the agent, as with the codeflower:// line. Requests must name this
// worker's host (no DNS rebinding), and the WebSocket must come from the page.
//
// It is plain HTTP: on a shared network, put it behind a TLS reverse proxy
// (or ssh -L), with --host 127.0.0.1.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, normalize, sep } from 'node:path';

export const PAGE_DIRECTORY = '/opt/codeflower/page';
// The page's one sandbox.
export const WORKER_ID = 'local';
// How long a WebSocket ticket works; it works once.
const TICKET_MS = 30_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// As the app's client serves the page (app/internal/client/server.go, guard).
const PAGE_POLICY =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

// The frame an interactive report runs in, and its policy: keep both in step
// with app/internal/client/frame.go.
const REPORT_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src blob:";
const FRAME_DOCUMENT = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function load(event) {
  var message = event.data;
  if (event.source !== parent || !message || message.type !== 'cf-load' || typeof message.html !== 'string') return;
  removeEventListener('message', load);
  document.open();
  document.write(message.html);
  document.close();
});
parent.postMessage({ type: 'cf-frame-ready' }, '*');
</script>`;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** The host name in a Host header, without its port. */
function hostName(header) {
  if (typeof header !== 'string' || !header) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(header);
  if (bracketed) return bracketed[1].toLowerCase();
  return header.replace(/:\d+$/, '').toLowerCase();
}

function bearer(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;
}

function sendJson(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('request too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/**
 * The page's routes. `matches(token)` checks a token in constant time; the
 * others give what the page shows: `status()` as GET /status does,
 * `sessions()`, `describe()` (the mounts), and `quit` (see the bridge).
 */
export function createPage({
  directory = PAGE_DIRECTORY,
  advertiseHost,
  matches,
  agentName,
  agentLabel,
  version,
  startedAt,
  status,
  sessions,
  describe,
  // The codeflower:// line, for VS Code beside the page; its token is the page's key.
  workerUrl = () => undefined,
  quit
}) {
  const allowedHost = (request) => {
    const name = hostName(request.headers.host);
    return name !== undefined && (name === hostName(advertiseHost) || name === advertiseHost.toLowerCase() || LOOPBACK.has(name));
  };
  const signedIn = (request) => matches(bearer(request));
  /** The chat WebSocket's tickets not used yet, by expiry. */
  const tickets = new Map();
  const newTicket = () => {
    const now = Date.now();
    for (const [ticket, expires] of tickets) if (expires <= now) tickets.delete(ticket);
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticket, now + TICKET_MS);
    return ticket;
  };
  const takeTicket = (ticket) => {
    const expires = typeof ticket === 'string' ? tickets.get(ticket) : undefined;
    if (expires === undefined) return false;
    tickets.delete(ticket);
    return expires > Date.now();
  };

  const worker = async () => {
    const [activity, described = {}] = await Promise.all([status(), describe()]);
    const mounts = Array.isArray(described.mounts) ? described.mounts : [];
    const sources = (prefix) =>
      mounts.filter((mount) => typeof mount?.target === 'string' && mount.target.startsWith(prefix)).map((mount) => mount.source ?? mount.target);
    const quitting = quit.plan().quitting;
    return {
      id: WORKER_ID,
      source: 'started',
      kind: 'worker',
      engine: described.engine ?? '',
      project: described.stateDirectory ? basename(described.stateDirectory) : '',
      state: described.stateDirectory ?? '',
      inputs: sources('/data/input/'),
      outputs: sources('/data/output/'),
      code: sources('/data/code/'),
      skills: sources('/data/skills/'),
      started: startedAt,
      agent: agentName,
      label: agentLabel,
      status: 'ready',
      url: workerUrl() ?? '',
      exitCode: 0,
      log: [],
      activity,
      relays: activity.clients ?? 0,
      ...(quitting ? { quitting: quitting.workers[WORKER_ID] } : {})
    };
  };

  const system = () => ({
    version: version ?? '',
    system: 'sandbox',
    home: '',
    projects: '',
    engines: [],
    engine: '',
    guide: { system: '', options: [] },
    agents: [],
    settings: {},
    configSkills: [],
    isolation: {},
    capabilities: { connect: false, start: false, connectOnly: true, single: true }
  });

  async function serveFile(response, pathname) {
    const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[/\\]+/, '');
    const file = join(directory, relative);
    if (relative.startsWith('..') || !file.startsWith(directory + sep)) return false;
    let content;
    try {
      content = await readFile(file);
    } catch {
      return false;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy': PAGE_POLICY,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff'
    });
    response.end(content);
    return true;
  }

  return {
    /** Answers a page request; false for paths that are not the page's. */
    async handle(request, response, url) {
      const { pathname } = url;
      const api = pathname.startsWith('/api/');
      if (!api && pathname !== '/frame' && request.method !== 'GET') return false;
      if (!allowedHost(request)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('wrong host\n');
        return true;
      }
      if (pathname === '/frame' && request.method === 'GET') {
        // No cookie needed: the sandboxed frame has none, and the document holds nothing.
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `${REPORT_POLICY}; frame-ancestors 'self'`,
          'x-content-type-options': 'nosniff'
        });
        response.end(FRAME_DOCUMENT);
        return true;
      }
      // The link: the page takes its key out of the address itself. Another
      // sandbox's (or an old) link says so at once.
      const key = url.searchParams.get('key');
      if (pathname === '/' && key && !matches(key)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('This link is not this sandbox\'s: open the one it printed.\n');
        return true;
      }
      // The page's own files hold nothing: only the API needs the key.
      if (api && !signedIn(request)) {
        sendJson(response, 403, { error: 'Open this sandbox with the link it printed when it started.' });
        return true;
      }
      if (!api) {
        if (await serveFile(response, pathname)) return true;
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
        return true;
      }
      if (request.method !== 'GET' && request.headers['content-type'] !== 'application/json') {
        sendJson(response, 415, { error: 'expected JSON' });
        return true;
      }
      try {
        if (request.method === 'POST' && pathname === '/api/ticket') return sendJson(response, 200, { ticket: newTicket() }), true;
        if (request.method === 'GET' && pathname === '/api/system') return sendJson(response, 200, system()), true;
        if (request.method === 'GET' && pathname === '/api/workers') return sendJson(response, 200, [await worker()]), true;
        if (request.method === 'GET' && pathname === `/api/workers/${WORKER_ID}/sessions`) {
          return sendJson(response, 200, { sessions: await sessions() }), true;
        }
        if (pathname === '/api/quit') {
          if (request.method === 'GET') return sendJson(response, 200, quit.plan()), true;
          if (request.method === 'POST') {
            const body = JSON.parse((await readBody(request)) || '{}');
            return sendJson(response, 200, quit.begin(body?.wrapUp !== false)), true;
          }
          if (request.method === 'DELETE') return sendJson(response, 200, quit.cancel()), true;
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return true;
      }
      sendJson(response, 404, { error: 'not found' });
      return true;
    },

    /** The page's WebSocket to the agent: a ticket, from the page itself. */
    upgrade(request, pathname) {
      if (pathname !== `/api/workers/${WORKER_ID}/acp`) return undefined;
      if (!allowedHost(request)) return 403;
      const origin = request.headers.origin;
      let originHost;
      try {
        originHost = origin ? new URL(origin).host : undefined;
      } catch {}
      if (originHost === undefined || originHost !== request.headers.host) return 403;
      let ticket;
      try {
        ticket = new URL(request.url, 'http://localhost').searchParams.get('ticket');
      } catch {}
      return takeTicket(ticket) ? 200 : 401;
    }
  };
}
