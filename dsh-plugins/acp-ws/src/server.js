import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { X509Certificate, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';
import { createActivity, scopedActivity, unscope } from './activity.js';
import { createChatTerminals, terminalSize } from './chat-terminals.js';
import { hookSettings, tailTranscript, transcriptPath } from './agents/claude/mirror.js';
import { createSessionInfo } from './session-info.js';
import { CREDENTIAL_VARIABLES, InvalidRequest, terminalAuthCommand } from './agents.js';
import { readCodexLimits } from './codex-limits.js';
import { listDirectory, readClientFile, resolveFile, saveReportComments, startShowServer, writeClientFile } from './files.js';
import { createPage } from './page.js';
import {
  LeaseError,
  createSessionStore,
  deleteSession,
  listSessions,
  listSubagents,
  parentKeyOf,
  readTranscript,
  readTranscriptPage,
  renameSession,
  sessionKey,
  writeJsonAtomically
} from './sessions.js';
import { createDownloads } from './downloads.js';
import { createThumbnails } from './thumbnails.js';
import { DID_NOT_START, addedMcpServers, claudeMcpConfig, describeLeftOut, failedMcpServers, mcpServersFor, withMcpServers } from './mcp.js';
import { DEFAULT_UPLOAD_MAX_BYTES, createUploads } from './uploads.js';
import { createUsage, dshTokens } from './usage.js';
import { createSubagentSettings, mergeMeta, settingsEffects } from './subagents/settings.js';
import { createSubagentTracker } from './subagents/tracker.js';

const CONNECTION_PATH = '/acp';
const STATUS_PATH = '/status';
// The app's client asks chats to wrap up here before it stops the sandbox.
const WRAP_UP_PATH = '/wrap-up';
// The app lists the chats here without opening a window.
const SESSIONS_PATH = '/sessions';
const MAX_WRAP_UP_BODY = 4096;
// A window that misses two pings in a row is gone, e.g. a laptop that went to sleep.
const PING_MS = 30_000;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const CONTROL_PREFIX = '_codeflower/';
const LEASE_CONFLICT = -32010;
const MAX_TERMINAL_INPUT = 64 * 1024;
// The user's shells (the page's Terminal) running at once.
const MAX_SHELL_TERMINALS = 8;
// Shell commands the user runs from the chat (`!command`).
const MAX_SHELL_COMMAND = 16 * 1024;
const MAX_SHELL_RECORD = 64 * 1024;
const SHELL_TIMEOUT_MS = 15 * 60 * 1000;
// Usage notifications to the window, at most this often.
const USAGE_NOTIFY_MS = 1000;
// How often a separate app-server may read Codex's rate limits.
const LIMITS_INTERVAL_MS = 60_000;
// Chats are asked to wrap up this long before the batch job ends.
const WRAP_UP_LEAD_MS = 15 * 60_000;
// How long a cancelled turn may take to end before the wrap-up gives up on it.
const WRAP_UP_CANCEL_MS = 30_000;
// How often a run's prompt, waiting for the agent's sign-in, checks for it.
const SIGN_IN_POLL_MS = 2000;
// setTimeout waits at most about 24 days; longer waits are made of several.
const MAX_TIMER_MS = 2 ** 31 - 1;
const SESSION_STARTS = ['session/new', 'session/resume', 'session/load'];
// How long a turn the agent's terminal UI started is held open after the
// agent says it ended, for its last updates over ACP.
const TERMINAL_TURN_SETTLE_MS = 500;
// Between a prompt pasted into a terminal UI and its Enter.
const PASTE_ENTER_MS = 150;
// ACP steering: a message for the turn the agent is working on (Claude Code, Codex).
const STEER_METHOD = '_session/steering';
// A subagent's summary goes to its parent's windows at most this often.
const SUBAGENT_NOTIFY_MS = 1000;
// Changes of the agents' states go to the windows at most this often.
const AGENTS_NOTIFY_MS = 100;

/**
 * The line users paste into VS Code; the token travels in it like Jupyter's,
 * and with TLS the certificate's fingerprint, which clients pin.
 */
export function connectionUrl(host, port, token, fingerprint) {
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `codeflower://${address}:${port}?token=${encodeURIComponent(token)}${fingerprint ? `&fp=${fingerprint}` : ''}`;
}

/**
 * A certificate's fingerprint (PEM in): SHA-256 of its DER, unpadded
 * base64url, as the app (internal/sandbox/tls.go) and every client write it.
 */
export function certificateFingerprint(certificate) {
  return createHash('sha256').update(new X509Certificate(certificate).raw).digest('base64url');
}

// The code flower app's usual port on the user's computer (DefaultPort in
// the app's client).
const CLIENT_PORT = 7720;

/** A link that opens the app's page and offers to add this worker; the line stays in the fragment, which is never sent. */
export function clientLink(workerLine) {
  return `http://127.0.0.1:${CLIENT_PORT}/#add=${encodeURIComponent(workerLine)}`;
}

/** A link that opens the worker in VS Code's extension, as the app's VSCodeLink does. */
export function vscodeLink(workerLine) {
  return `vscode://codeflower.codeflower/connect?address=${encodeURIComponent(workerLine)}`;
}

/** The chat page the worker serves (`--server`), with its key; like Jupyter's link. */
export function pageLink(host, port, token) {
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${address}:${port}/?key=${encodeURIComponent(token)}`;
}

function constantTimeTokenMatch(received, expected) {
  if (typeof received !== 'string') {
    return false;
  }

  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function rejectUpgrade(socket, status, reason) {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

function protocolObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestKey(id) {
  return JSON.stringify(id);
}

async function writeConnectionFile(connectionFile, metadata) {
  const directory = dirname(connectionFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = join(
    directory,
    `.${basename(connectionFile)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(temporaryFile, `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600
    });
    await rename(temporaryFile, connectionFile);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
}

export function agentEnvironment(environment, harnessEnvironment = {}) {
  const result = { ...environment };
  delete result.CODEFLOWER_TOKEN;
  delete result.CODEFLOWER_TLS_CERT;
  delete result.CODEFLOWER_TLS_KEY;
  delete result.CODEFLOWER_CONNECTION_FILE;
  delete result.CODEFLOWER_LISTEN_HOST;
  delete result.CODEFLOWER_ADVERTISE_HOST;
  delete result.CODEFLOWER_PORT;
  delete result.CODEFLOWER_LISTEN_SOCKET;
  delete result.CODEFLOWER_EGRESS_SOCKET;
  delete result.CODEFLOWER_APP_PID;
  delete result.CODEFLOWER_INSTANCE_ID;
  delete result.CODEFLOWER_SLURM_JOB_ID;
  delete result.CODEFLOWER_SESSIONS_DIR;
  delete result.CODEFLOWER_RUN_DIR;
  delete result.CODEFLOWER_AGENT;
  delete result.CODEFLOWER_HOST_STATE;
  delete result.CODEFLOWER_HOST_IMAGE;
  delete result.CODEFLOWER_ENGINE;
  delete result.CODEFLOWER_MOUNTS;
  delete result.CODEFLOWER_TASK_ATTEMPT_FILE;
  delete result.CODEFLOWER_TASK_INTERACTIVE;
  delete result.CODEFLOWER_INITIAL_PROMPT_FILE;
  delete result.CODEFLOWER_MCP_SERVERS;
  delete result.CODEFLOWER_PLUGINS;
  delete result.CODEFLOWER_PLUGINS_FETCH;
  for (const name of CREDENTIAL_VARIABLES) {
    delete result[name];
  }
  return { ...result, ...harnessEnvironment };
}

export function endChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.stdin.end();
  const terminateTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }, 2000);
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 5000);
  terminateTimer.unref();
  killTimer.unref();
  child.once('close', () => {
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
  });
}

// Records the ACP traffic of one connection into the project's session store
// and enforces session leases. All store operations run in one queue so the
// transcript keeps protocol order.
export function createRecorder(store, log) {
  const clientRequests = new Map();
  const permissionRequests = new Map();
  const questionRequests = new Map();
  let queue = Promise.resolve();
  let pending = 0;

  const run = (task) => {
    pending += 1;
    queue = queue.then(task).catch((error) => {
      if (error instanceof LeaseError) {
        log(`Session lease conflict: ${error.message}`);
      } else {
        log(`Could not record session: ${error.message}`);
      }
    }).finally(() => {
      pending -= 1;
    });
    return queue;
  };

  return {
    // Returns a JSON-RPC error response when the client may not proceed.
    async admitClientMessage(message) {
      if (
        message.id !== undefined &&
        (message.method === 'session/resume' || message.method === 'session/load')
      ) {
        await queue;
        const sessionId = message.params?.sessionId;
        if (typeof sessionId === 'string' && !store.isOpen(sessionId)) {
          const holder = await store.foreignLease(sessionId);
          if (holder) {
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: LEASE_CONFLICT,
                message: 'Session is open on another worker',
                data: { instanceId: holder.instanceId, heartbeatAt: holder.heartbeatAt }
              }
            };
          }
        }
      }
      return undefined;
    },

    fromClient(message) {
      if (message.method !== undefined && message.id !== undefined) {
        clientRequests.set(requestKey(message.id), message);
      }
      if (message.method === 'session/prompt') {
        const sessionId = message.params?.sessionId;
        run(() => store.record(sessionId, { kind: 'prompt', prompt: message.params?.prompt ?? [] }));
        return;
      }
      if (message.method === undefined && message.id !== undefined) {
        const sessionId = permissionRequests.get(requestKey(message.id));
        if (sessionId !== undefined) {
          permissionRequests.delete(requestKey(message.id));
          run(() =>
            store.record(sessionId, {
              kind: 'permission_outcome',
              outcome: message.result?.outcome ?? null
            })
          );
        }
        const questionSessionId = questionRequests.get(requestKey(message.id));
        if (questionSessionId !== undefined) {
          questionRequests.delete(requestKey(message.id));
          run(() =>
            store.record(questionSessionId, {
              kind: 'question_outcome',
              action: message.result?.action ?? 'cancel',
              content: message.result?.content ?? null
            })
          );
        }
      }
    },

    // `turn`: what a finished prompt added to the session's usage.
    fromAgent(message, turn) {
      if (message.method === undefined && message.id !== undefined) {
        const request = clientRequests.get(requestKey(message.id));
        clientRequests.delete(requestKey(message.id));
        if (!request || message.error) {
          return;
        }
        if (request.method === 'session/new' && typeof message.result?.sessionId === 'string') {
          const sessionId = message.result.sessionId;
          run(() => store.open(sessionId, { cwd: request.params?.cwd }));
        } else if (request.method === 'session/resume' || request.method === 'session/load') {
          const sessionId = request.params?.sessionId;
          if (typeof sessionId === 'string') {
            run(() => store.open(sessionId, { cwd: request.params?.cwd }));
          }
        } else if (request.method === STEER_METHOD && message.result?.outcome === 'injected') {
          const sessionId = request.params?.sessionId;
          run(() => store.record(sessionId, { kind: 'prompt', prompt: request.params?.prompt ?? [] }));
        } else if (request.method === 'session/prompt') {
          const sessionId = request.params?.sessionId;
          run(() =>
            store.record(sessionId, {
              kind: 'turn_end',
              stopReason: message.result?.stopReason ?? null,
              ...turn
            })
          );
        }
        return;
      }
      if (message.method === 'session/update') {
        const sessionId = message.params?.sessionId;
        run(() => store.record(sessionId, { kind: 'update', update: message.params?.update }));
        return;
      }
      // A question for the user (a form elicitation, e.g. AskUserQuestion).
      if (
        message.method === 'elicitation/create' &&
        message.id !== undefined &&
        message.params?.mode !== 'url' &&
        typeof message.params?.sessionId === 'string'
      ) {
        const sessionId = message.params.sessionId;
        questionRequests.set(requestKey(message.id), sessionId);
        run(() =>
          store.record(sessionId, {
            kind: 'question',
            message: message.params.message ?? '',
            requestedSchema: message.params.requestedSchema ?? {},
            ...(typeof message.params.toolCallId === 'string' ? { toolCallId: message.params.toolCallId } : {})
          })
        );
        return;
      }
      if (message.method === 'session/request_permission' && message.id !== undefined) {
        const sessionId = message.params?.sessionId;
        permissionRequests.set(requestKey(message.id), sessionId);
        run(() =>
          store.record(sessionId, {
            kind: 'permission',
            toolCall: message.params?.toolCall ?? null,
            options: message.params?.options ?? []
          })
        );
      }
    },

    /** Waits for recording to catch up, e.g. a session that was just created. */
    async isOpen(sessionId) {
      await queue;
      return store.isOpen(sessionId);
    },

    /** Entries the bridge itself produces, e.g. the user's shell commands. */
    record(sessionId, entry) {
      return run(() => store.record(sessionId, entry));
    },

    /** Records a subagent's chat from now on, if its parent's is recorded. */
    openChild(sessionId, parentId) {
      return run(() => store.openChild(sessionId, parentId));
    },

    setSubagent(sessionId, summary) {
      return run(() => store.setSubagent(sessionId, summary));
    },

    /** Whether recorded messages are still on their way into the store. */
    get busy() {
      return pending > 0;
    },

    idle() {
      return queue;
    },

    entryCount(sessionId) {
      return store.entryCount(sessionId);
    },

    /** Waits until the transcripts hold everything relayed so far. */
    async flush() {
      while (pending > 0) await queue;
      await store.flush();
    },

    close(sessionId) {
      return run(() => store.close(sessionId));
    },

    closeAll() {
      return run(() => store.closeAll());
    }
  };
}

export async function startBridge(options) {
  const {
    host = '0.0.0.0',
    port = 0,
    // A network-isolated sandbox listens on a Unix socket the app
    // forwards to; port is then the app's.
    listenSocket,
    advertiseHost = host,
    token,
    // { cert, key } (PEM): the bridge serves TLS with the certificate the app
    // made for this run, whose fingerprint its line carries. Without it
    // (the page, served with --server, is plain HTTP) it serves HTTP.
    tls,
    connectionFile,
    appPid = process.pid,
    instanceId = randomUUID(),
    slurmJobId,
    // The agents the worker runs, by name (agents.js createAgents); each
    // starts when its first window connects.
    agents = {},
    // The run's task (`codeflower run`), and the agent it is for.
    initialPrompt,
    initialPromptAgent,
    sessionsDirectory,
    // When the batch job ends (ms since the epoch), and what chats with a turn
    // running are told some minutes before ({{end}}, {{minutes}}).
    allocationEnd,
    actions = [],
    wrapUpTemplate,
    wrapUpLeadMs = WRAP_UP_LEAD_MS,
    signInPollMs = SIGN_IN_POLL_MS,
    // What chats are told when the client that started the sandbox quits
    // ({{minutes}}: at most how long it waits for them).
    wrapUpQuitTemplate,
    describe = async () => ({}),
    ptyHelper,
    // MCP servers from the app's config, given to every session (mcp.js).
    mcpServers = [],
    // Each agent's own plugins (plugins.js), by name, turned on before every start of it.
    plugins = {},
    environment: workerEnvironment = process.env,
    workspace = workerEnvironment.CODEFLOWER_WORKSPACE ?? process.cwd(),
    // `codeflower-show` reaches the bridge here; a local path, as sockets on
    // network filesystems do not work.
    showSocket = join(tmpdir(), `codeflower-show-${instanceId}.sock`),
    // Claude Code's hooks in its terminal UI reach the bridge here
    // (codeflower-hook), while a chat is handed over to it.
    hookSocket = join(tmpdir(), `codeflower-hook-${instanceId}.sock`),
    hookCommand = '/opt/codeflower/bin/codeflower-hook',
    // The project state: only its workspace may be shown or read.
    privateDirectory = sessionsDirectory ? dirname(sessionsDirectory) : undefined,
    // Read-write mounts (/data/output/NAME, /data/code/NAME), where reports may also take comments.
    writableFolders = [],
    // Files attached to chat messages, at most this large (the app sets it).
    uploadMaxBytes = Number(workerEnvironment.CODEFLOWER_UPLOAD_MAX) || DEFAULT_UPLOAD_MAX_BYTES,
    log = (message) => process.stderr.write(`${message}\n`),
    // The chat page, served on the bridge's own port (`--server`): false, or
    // { directory, version }. onQuit stops the worker when the page quits.
    page: pageOptions = false,
    onQuit = () => {}
  } = options;

  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error('CODEFLOWER_TOKEN must contain at least 32 bytes');
  }
  if (!connectionFile) {
    throw new Error('CODEFLOWER_CONNECTION_FILE is required');
  }
  const agentNames = Object.keys(agents);
  if (!agentNames.length || agentNames.some((name) => typeof agents[name]?.command !== 'function')) {
    throw new Error('An agent is required');
  }
  if (initialPrompt !== undefined && (typeof initialPrompt !== 'string' || !initialPrompt.trim())) {
    throw new Error('The initial prompt must be a non-empty string');
  }
  const promptAgent = initialPromptAgent ?? (agentNames.length === 1 ? agentNames[0] : undefined);
  if (initialPrompt !== undefined && !agents[promptAgent]) {
    throw new Error('The initial prompt needs one of the agents: CODEFLOWER_INITIAL_PROMPT_AGENT');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('CODEFLOWER_PORT must be an integer between 0 and 65535');
  }

  const environment = { ...workerEnvironment, CODEFLOWER_SHOW_SOCKET: showSocket };
  const fileOptions = { workspace, privateDirectory, writableFolders };
  const uploads = createUploads({ workspace, fileOptions, maxBytes: uploadMaxBytes, log });
  const downloads = createDownloads({ fileOptions, log });
  const thumbnails = createThumbnails({
    directory: sessionsDirectory ? join(dirname(sessionsDirectory), 'thumbnails') : undefined,
    fileOptions,
    log
  });
  await uploads.removeLeftovers();

  // Connected windows, oldest first. Each is one agent's (`/acp?agent=NAME`),
  // or the worker's own (`/acp`), which asks only `_codeflower/*`.
  const clients = new Set();
  const allClients = clients;
  let nextClient = 1;
  // The window that sent the latest prompt, which gets the files the agent shows.
  let lastPrompter;
  let closing = false;
  const shells = new Map();
  // The latest wrap-up's reason, how many chats it and earlier ones asked,
  // and the chats whose wrap-up has not ended yet, by session key.
  let wrapUpReason;
  let wrapUpAsked = 0;
  const wrappingUp = new Set();

  const broadcast = (message) => {
    for (const target of clients) target.send(message);
  };
  // The agent's own terminal UI on chats (`codeflower attach`): one per chat at
  // most, kept while no window watches it. Every window hears what runs where.
  const chatTerminals = createChatTerminals({
    ptyHelper,
    log,
    onChange: () => broadcast({ jsonrpc: '2.0', method: '_codeflower/terminal/changed', params: { terminals: chatTerminals.list() } })
  });
  // The newest window with chats (`codeflower attach` has only terminals).
  const newestClient = () => [...clients].filter((target) => target.acp).at(-1);
  // Which chats work or wait, the worker's: each agent's view keeps its ids
  // apart (scopedActivity).
  const activity = createActivity(() =>
    broadcast({ jsonrpc: '2.0', method: '_codeflower/activity', params: activitySnapshot() })
  );
  const workerActivity = activity;

  function activitySnapshot() {
    const { chats, working, waiting, ended, turns } = activity.snapshot();
    const keyed = ({ sessionId, ...chat }) => ({ key: sessionKey(...unscope(sessionId)), ...chat });
    return { chats: chats.map(keyed), working, waiting, ended: ended.map(keyed), turns };
  }

  // The agents, by name (createRuntime), and the one a chat's key is of.
  const runtimes = new Map();
  const runtimeOfKey = (key) =>
    typeof key === 'string' ? [...runtimes.values()].find((runtime) => key.startsWith(`${runtime.name}-`)) : undefined;
  // What the windows show of the agents (_codeflower/agents), sent to all of
  // them again when it changes: an agent starts or stops, or signs in.
  const describeAgents = () => Promise.all([...runtimes.values()].map((runtime) => runtime.describe()));
  let agentsTimer;
  const agentsChanged = () => {
    agentsTimer ??= setTimeout(() => {
      agentsTimer = undefined;
      if (closing) return;
      void describeAgents().then((agents) => broadcast({ jsonrpc: '2.0', method: '_codeflower/agents', params: { agents } }));
    }, AGENTS_NOTIFY_MS);
  };

  async function statusSnapshot() {
    const snapshot = activitySnapshot();
    const titles = new Map();
    if ((snapshot.chats.length || snapshot.ended.length) && sessionsDirectory) {
      await Promise.all([...runtimes.values()].map((runtime) => runtime.flush()));
      for (const session of await listSessions(sessionsDirectory).catch(() => [])) titles.set(session.key, session.title);
    }
    const titled = (chat) => ({ ...chat, title: titles.get(chat.key) ?? 'Untitled session' });
    // A window connects to the worker, and to each agent it uses: its own connection counts it.
    const windows = [...clients].filter((target) => target.agentName === undefined).length;
    return {
      connected: clients.size > 0,
      clients: windows,
      // Windows attach side by side instead of taking the worker over.
      multiClient: true,
      running: [...runtimes.values()].some((runtime) => runtime.host),
      // Each agent's: whether it runs, and its account and totals; per chat
      // only in the window.
      agents: [...runtimes.values()].map((runtime) => ({ id: runtime.name, running: Boolean(runtime.host), usage: runtime.account() })),
      working: snapshot.working,
      waiting: snapshot.waiting,
      chats: snapshot.chats.map(titled),
      ended: snapshot.ended.map(titled),
      turns: snapshot.turns,
      ...(wrapUpReason
        ? { wrapUp: { reason: wrapUpReason, state: wrappingUp.size ? 'running' : 'done', chats: wrapUpAsked } }
        : {})
    };
  }

  // POST /wrap-up {reason: "quit", minutes}: answers how many chats were asked
  // and wraps them up in the background; /status says when they are done.
  const wrapUpRequest = (request, response) => {
    const reply = (code, body) => {
      response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_WRAP_UP_BODY) tooLarge = true;
    });
    request.on('end', () => {
      if (tooLarge) return reply(413, { error: 'request too large' });
      let params;
      try {
        params = JSON.parse(body || '{}');
      } catch {
        return reply(400, { error: 'invalid JSON' });
      }
      const minutes = params?.minutes;
      if (params?.reason !== 'quit' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
        return reply(400, { error: 'expected {"reason": "quit", "minutes": N}' });
      }
      if (!wrapUpQuitTemplate) return reply(501, { error: 'this worker cannot wrap up chats on request' });
      if (closing) return reply(503, { error: 'the worker is stopping' });
      const { chats, done } = wrapUpChats('quit', Math.round(minutes));
      void done.catch((error) => log(`Could not wrap up: ${error.message}`));
      reply(202, { chats });
    });
  };

  // Every agent's recorded chats, as _codeflower/sessions/list and GET /sessions list them.
  const allSessions = async () => {
    const sessions = sessionsDirectory ? await listSessions(sessionsDirectory) : [];
    return sessions
      .filter((session) => runtimes.has(session.harness))
      .map((session) => {
        const terminal = chatTerminals.byKey(session.key);
        return terminal ? { ...session, terminal: chatTerminals.describe(terminal) } : session;
      });
  };

  const bearer = (request) => {
    const authorization = request.headers.authorization;
    return typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
  };

  // Quitting from the page: the chats wrap up, then the worker stops.
  let pageQuit;
  // The address once the bridge listens, for the page.
  let listening;
  const QUIT_MINUTES = 10;
  const quitPlan = () => {
    const { working } = activity.snapshot();
    return {
      sandboxes: 1,
      working,
      busy: working > 0 ? 1 : 0,
      elsewhere: 0,
      minutes: QUIT_MINUTES,
      ...(pageQuit ? { quitting: pageQuit } : {}),
      stopping: closing || pageQuit?.workers.local === 'stopping'
    };
  };
  const quitNow = () => {
    if (pageQuit) pageQuit.workers.local = 'stopping';
    else pageQuit = { started: new Date().toISOString(), deadline: new Date().toISOString(), workers: { local: 'stopping' } };
    log('The page quit: stopping the worker');
    setImmediate(onQuit);
  };
  const page =
    pageOptions &&
    createPage({
      directory: pageOptions.directory,
      version: pageOptions.version,
      advertiseHost,
      matches: (candidate) => constantTimeTokenMatch(candidate, token),
      startedAt: new Date().toISOString(),
      status: statusSnapshot,
      sessions: allSessions,
      describe,
      workerUrl: () => listening?.url,
      quit: {
        plan: quitPlan,
        begin(wrapUp) {
          if (closing || pageQuit) return quitPlan();
          if (!wrapUp || !wrapUpQuitTemplate || !activity.snapshot().working) {
            quitNow();
            return quitPlan();
          }
          const started = Date.now();
          const current = {
            started: new Date(started).toISOString(),
            deadline: new Date(started + QUIT_MINUTES * 60_000).toISOString(),
            workers: { local: 'wrapping up' }
          };
          pageQuit = current;
          const { done } = wrapUpChats('quit', QUIT_MINUTES);
          const timer = setTimeout(() => pageQuit === current && quitNow(), QUIT_MINUTES * 60_000);
          void done
            .catch((error) => log(`Could not wrap up: ${error.message}`))
            .finally(() => {
              clearTimeout(timer);
              if (pageQuit === current) quitNow();
            });
          return quitPlan();
        },
        cancel() {
          // The chats finish their wrap-up; the worker keeps running.
          if (pageQuit?.workers.local !== 'stopping') pageQuit = undefined;
          return quitPlan();
        }
      }
    });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const fingerprint = tls ? certificateFingerprint(tls.cert) : undefined;
  const serve = (handler) => (tls ? createTlsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.3' }, handler) : createServer(handler));
  const server = serve((request, response) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {}
    const pathname = url?.pathname;
    // What the app shows about the worker: counts and chat titles only.
    if (request.method === 'GET' && pathname === STATUS_PATH) {
      if (!constantTimeTokenMatch(bearer(request), token)) {
        response.writeHead(401, { connection: 'close' });
        response.end();
        return;
      }
      void statusSnapshot().then((status) => {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(status));
      });
      return;
    }
    if (request.method === 'GET' && pathname === SESSIONS_PATH) {
      if (!constantTimeTokenMatch(bearer(request), token)) {
        response.writeHead(401, { connection: 'close' });
        response.end();
        return;
      }
      allSessions().then(
        (sessions) => {
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ sessions }));
        },
        (error) => {
          log(`Could not list the sessions: ${error.message}`);
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'could not list the sessions' }));
        }
      );
      return;
    }
    if (request.method === 'POST' && pathname === WRAP_UP_PATH) {
      if (!constantTimeTokenMatch(bearer(request), token)) {
        response.writeHead(401, { connection: 'close' });
        response.end();
        return;
      }
      wrapUpRequest(request, response);
      return;
    }
    const notFound = () => {
      response.writeHead(404, { connection: 'close' });
      response.end();
    };
    if (!page || !url) return notFound();
    page.handle(request, response, url).then(
      (handled) => handled || notFound(),
      (error) => {
        log(`The page could not answer ${pathname}: ${error.message}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    );
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const { pathname } = url;

    // The page's WebSocket, authorized by its ticket.
    const fromPage = page ? page.upgrade(request, pathname) : undefined;
    if (fromPage === 403) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (fromPage === 401) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (fromPage === undefined && pathname !== CONNECTION_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (fromPage === undefined && !constantTimeTokenMatch(bearer(request), token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (closing) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    // The agent the window speaks to; without one, the worker's own window.
    const agentName = url.searchParams.get('agent');
    const runtime = agentName === null ? undefined : runtimes.get(agentName);
    if (agentName !== null && !runtime) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit('connection', webSocket, request, runtime);
    });
  });

  // `_codeflower/terminal/start` with kind "shell": the user's own shell in
  // the workspace (the page's Terminal), with what the user's `!command`s
  // get: the project's environment, without the worker's token. It is kept
  // like a chat's terminal, so a window can leave it and come back.
  const startShellTerminal = (params, client) => {
    if (!Array.isArray(ptyHelper) || ptyHelper.length === 0) throw new InvalidRequest('This worker cannot open terminals');
    if (chatTerminals.count('shell') >= MAX_SHELL_TERMINALS) {
      throw new InvalidRequest(`At most ${MAX_SHELL_TERMINALS} terminals can run at once: close one first`);
    }
    const size = terminalSize(params);
    const terminal = chatTerminals.start({
      kind: 'shell',
      key: `shell:${randomUUID()}`,
      command: ['bash', '-l'],
      env: agentEnvironment(environment),
      cwd: workspace,
      size
    });
    chatTerminals.attach(terminal, client, { size });
    return { terminalId: terminal.id };
  };

  // ---- links to what the agent shows, for terminals ----

  // Where the user's browser opens a file of this worker, as `codeflower
  // attach` found it: the app's page with the sandbox's file route, e.g.
  // http://127.0.0.1:7720/#/file/local-1a2b3c4d/, to which the bridge adds
  // the file's path. Per chat terminal, and the latest for the worker.
  let latestLinkBase;
  const rememberLinkBase = (terminal, linkBase) => {
    if (typeof linkBase !== 'string' || linkBase.length > 2000 || !/^https?:\/\//.test(linkBase)) return;
    terminal.linkBase = linkBase;
    latestLinkBase = linkBase;
  };

  // The chat a show is for: the only one working (the agent calls
  // codeflower-show in a turn), if exactly one is.
  const showingChat = () => {
    const working = activity.snapshot().chats.filter((chat) => chat.state === 'working');
    return working.length === 1 ? sessionKey(...unscope(working[0].sessionId)) : undefined;
  };

  // Links that open the files in the user's browser, none without a base.
  // They hold no secret: the agent sees them in its tool's output.
  const fileLinks = (files) => {
    const chat = showingChat();
    const base = (chat && chatTerminals.byKey(chat)?.linkBase) || latestLinkBase;
    if (!base) return [];
    const query = chat ? `?chat=${encodeURIComponent(chat)}` : '';
    return files.map((file) => ({ path: file.path, url: `${base}${encodeURIComponent(file.path)}${query}` }));
  };

  // ---- the job's end ----

  // The sandbox stops when the batch job does, and work not saved by then is
  // lost. Some minutes before, chats with a turn running are stopped and asked
  // to write up what they have, whether or not a window is connected.
  let wrapUpTimer;
  const scheduleWrapUp = () => {
    if (!Number.isFinite(allocationEnd) || !wrapUpTemplate) return;
    const wait = allocationEnd - wrapUpLeadMs - Date.now();
    wrapUpTimer = setTimeout(
      () =>
        wait > MAX_TIMER_MS
          ? scheduleWrapUp()
          : void wrapUpChats('time').done.catch((error) => log(`Could not wrap up: ${error.message}`)),
      Math.min(Math.max(0, wait), MAX_TIMER_MS)
    );
    wrapUpTimer.unref();
  };

  // time: the batch job ends ({{end}}, {{minutes}} until then); quit: the
  // client that started the sandbox quits and waits at most {{minutes}}.
  const wrapUpNotice = (reason, minutes) => {
    if (reason === 'quit') return { reason, minutes };
    return {
      reason,
      end: new Date(allocationEnd).toISOString(),
      minutes: Math.max(0, Math.round((allocationEnd - Date.now()) / 60_000))
    };
  };

  // Asks the chats with a turn running or a request waiting, of every agent,
  // and not already wrapping up, to wrap up; returns how many, and a promise
  // of their end.
  const wrapUpChats = (reason, minutes) => {
    const template = reason === 'quit' ? wrapUpQuitTemplate : wrapUpTemplate;
    const chats = closing
      ? []
      : [...runtimes.values()]
          .flatMap((runtime) =>
            runtime.wrapUpCandidates().map((sessionId) => ({ runtime, sessionId, key: sessionKey(runtime.name, sessionId) }))
          )
          .filter(({ key }) => !wrappingUp.has(key));
    const notice = wrapUpNotice(reason, minutes);
    log(
      reason === 'quit'
        ? `The client is quitting; asking ${chats.length} working chat(s) to wrap up`
        : `The job ends at ${notice.end}; asking ${chats.length} working chat(s) to wrap up`
    );
    wrapUpReason = reason;
    wrapUpAsked += chats.length;
    for (const { key } of chats) wrappingUp.add(key);
    broadcast({ jsonrpc: '2.0', method: '_codeflower/wrapUp', params: { ...notice, chats: chats.length } });
    const done = Promise.all(
      chats.map(({ runtime, sessionId, key }) => runtime.wrapUp(sessionId, notice, template).finally(() => wrappingUp.delete(key)))
    );
    return { chats: chats.length, done };
  };

  // A permission request or question goes to each window once, after it has
  // opened that chat.
  const deliver = (target, key, message) => {
    if (target.delivered.has(key)) return;
    target.delivered.add(key);
    target.send(message);
  };

  const withMultiClient = (result) => ({
    ...result,
    _meta: {
      ...(protocolObject(result._meta) ? result._meta : {}),
      'codeflower/multiClient': true,
      // Windows may attach files to messages (`_codeflower/files/upload`).
      'codeflower/uploads': uploads.capability,
      // ...and send files to folders and save files and folders (`_codeflower/files/download`).
      'codeflower/files': { upload: { ...uploads.capability, folders: true }, download: downloads.capability }
    }
  });

  // The bridge told the windows of the message itself (`_codeflower/prompted`).
  const withPrompted = (result) => ({
    ...result,
    _meta: { ...(protocolObject(result._meta) ? result._meta : {}), 'codeflower/prompted': true }
  });


  // ---- the agents ----

  // Everything of one agent: its process, which its first window starts, its
  // chats' records, usage, subagents and plugins. Its windows connect with
  // `/acp?agent=NAME`, and nothing of one agent reaches another's windows.
  async function createRuntime(agentName, agent, plugins) {
    // This agent's windows.
    const clients = new Set();
    const activity = scopedActivity(workerActivity, agentName);
    // To this agent's windows, and to the worker's own (the sandbox's Manage
    // view), which tell the agents apart by `agent`.
    const notify = (message) => {
      const tagged = { ...message, params: { ...message.params, agent: agentName } };
      for (const target of allClients) if (target.agentName === undefined || target.agentName === agentName) target.send(tagged);
    };

    // One store and recorder for the agent: sessions stay open, and their
    // leases fresh, while no window is connected.
    const store = sessionsDirectory
      ? createSessionStore({ directory: sessionsDirectory, instanceId, harness: agentName, log })
      : undefined;
    const recorder = store ? createRecorder(store, log) : undefined;
    const sessionInfo = createSessionInfo({ directory: workerEnvironment.CODEFLOWER_SESSION_INFO_DIR, agent: agent.label, log });
    // How the agent shows its subagents (subagents/adapters.js), and their
    // default model and effort in this project.
    const subagentAdapter = agent.subagents;
    const subagentSettings = subagentAdapter
      ? await createSubagentSettings({ file: privateDirectory ? join(privateDirectory, 'subagents', `${agentName}.json`) : undefined, log })
      : undefined;
    const subagentEffects = () =>
      subagentSettings
        ? settingsEffects(subagentAdapter.spec.settings, subagentSettings.get(), { ...environment, ...agent.env })
        : { sessionMeta: {}, env: {} };
    // The settings the running agent started with, for those it reads at start.
    let startedSubagentEnv = {};

    // The agent runs from the first connection until the worker stops; windows
    // (VS Code, the app's page) attach to it side by side and may come and go.
    let agentHost;
    let agentStarting;

    // The windows list the plugins again (_codeflower/plugins/list).
    const stopPluginNotices = plugins?.onChange?.(() =>
      notify({ jsonrpc: '2.0', method: '_codeflower/plugins/changed', params: {} })
    );
    // To the windows that opened the chat.
    const toSession = (sessionId, message, except) => {
      for (const target of clients) {
        if (target !== except && target.sessions.has(sessionId)) target.send(message);
      }
    };
    // The newest window with chats (`codeflower attach` has only terminals).
    const newestClient = () => [...clients].filter((target) => target.acp).at(-1);
    const closeClients = (host, code, reason) => {
      for (const target of clients) if (!host || target.agent === host) target.close(code, reason);
    };

    // ---- usage: token counts, cost, and the login's quota ----

    // The quota outlives the worker in the project, so the next worker of the
    // same login shows it before its first turn.
    const usageFile = privateDirectory ? join(privateDirectory, 'usage', `${agentName}.json`) : undefined;
    let savedUsage;
    try {
      if (usageFile) savedUsage = JSON.parse(await readFile(usageFile, 'utf8'));
    } catch {}
    let usageTimer;
    let saveTimer;
    let saving = Promise.resolve();
    const saveUsage = () => {
      if (!usageFile) return saving;
      saving = saving
        .then(() => writeJsonAtomically(usageFile, usage.saved()))
        .catch((error) => log(`Could not save the usage: ${error.message}`));
      return saving;
    };
    const usage = createUsage({
      costEstimate: agent.costEstimate === true,
      saved: savedUsage,
      onChange() {
        usageTimer ??= setTimeout(() => {
          usageTimer = undefined;
          notify({ jsonrpc: '2.0', method: '_codeflower/usage', params: usageSnapshot() });
        }, USAGE_NOTIFY_MS);
      },
      onAccountChange() {
        saveTimer ??= setTimeout(() => {
          saveTimer = undefined;
          void saveUsage();
        }, USAGE_NOTIFY_MS);
      }
    });
    void agent.authKind?.().then((kind) => usage.guessAuth(kind), () => {});

    const usageSnapshot = () => usage.snapshot((sessionId) => sessionKey(agentName, sessionId));

    // The login's limits, read beside the agent: Codex's from a separate
    // app-server, Claude's as its `/usage` reads them. When a window asks for
    // the usage (opening or focusing a chat) and after Codex's turns, whose
    // limits come no other way; at most once a minute, with the last read made
    // when the minute is over.
    const readLimits = agent.limitsCommand
      ? () =>
          readCodexLimits(agent.limitsCommand(), agentEnvironment(environment, agent.env)).then((response) =>
            usage.codexRateLimits(response)
          )
      : agent.readUsage
        ? () => agent.readUsage().then((response) => usage.claudeUsage(response))
        : undefined;
    let limitsReading;
    let limitsReadAt = 0;
    let limitsTimer;
    const refreshLimits = () => {
      if (!readLimits || usage.authKind === 'api_key' || limitsReading || closing) return;
      const wait = limitsReadAt + LIMITS_INTERVAL_MS - Date.now();
      if (wait > 0) {
        limitsTimer ??= setTimeout(() => {
          limitsTimer = undefined;
          refreshLimits();
        }, wait);
        return;
      }
      limitsReadAt = Date.now();
      limitsReading = readLimits()
        .catch((error) => log(`Could not read ${agent.label ?? agentName}'s rate limits: ${error.message}`))
        .finally(() => {
          limitsReading = undefined;
        });
    };

    // This agent's recorded chats.
    const ownSessions = async () => (await allSessions()).filter((session) => session.harness === agentName);

    // ---- the agent ----

    const childRunning = (child) => child.exitCode === null && child.signalCode === null;

    const startAgent = async () => {
      // Agents signed in with keys read them only at start.
      const withoutKeys = Boolean(agent.setCredentials) && !(await agent.signedIn());
      const command = await agent.command();
      // dsh's usage plugin reports token counts on a pipe of their own.
      const usageFd = agent.usageFd;
      const pluginEnvironment = (await plugins?.activate()) ?? {};
      // A process the agent works with, started first and ended with it:
      // Codex's shared app-server, which its terminal UI joins too.
      const companion = await startCompanion(pluginEnvironment);
      startedSubagentEnv = subagentEffects().env;
      const child = spawn(command[0], command.slice(1), {
        env: agentEnvironment(environment, {
          ...agent.env,
          ...startedSubagentEnv,
          ...pluginEnvironment,
          ...(usageFd ? { CODEFLOWER_USAGE_FD: String(usageFd) } : {})
        }),
        stdio: usageFd ? ['pipe', 'pipe', 'inherit', ...Array(usageFd - 3).fill('ignore'), 'pipe'] : ['pipe', 'pipe', 'inherit']
      });
      const started = {
        child,
        done: new Promise((resolve) => child.once('close', resolve)),
        authMethods: [],
        // The first initialize's result; later windows get it from here.
        initialized: undefined,
        // Client requests on their way, by the bridge's own id: windows come and
        // go, so their ids could collide.
        requests: new Map(),
        nextRequest: 1,
        // Permission requests and questions nobody answered yet; the first
        // window to answer wins.
        waiting: new Map(),
        // Other requests of the agent's, by the window that has to answer.
        forwarded: new Map(),
        // Each loaded session's modes and settings, for windows that reattach.
        sessions: new Map(),
        // Per loaded session: the configured MCP servers that did not start in it.
        mcpFailed: new Map(),
        // Per session: the prompts waiting for the running turn, and the window
        // that sent the latest one.
        prompts: new Map(),
        prompters: new Map(),
        // Per session: prompts the bridge sent whose user message the agent's
        // own events (watch) have not reported yet; any other is the terminal's.
        ownPrompts: new Map(),
        // Per session: the activity key of a turn the terminal UI started.
        terminalTurns: new Map(),
        // Chats handed over to the agent's own terminal UI (Claude Code), by
        // session: the adapter let go of them, and the bridge follows the
        // terminal (handOver).
        handoffs: new Map(),
        retiring: false,
        withoutKeys,
        // Its chats' subagents (subagents/tracker.js), and the summaries that
        // wait for their parents' windows (subagentChanged).
        subagents: createSubagentTracker({ onChange: (summary) => subagentChanged(started, summary) }),
        subagentTimers: new Map()
      };
      // Canonical subagent updates from outside ACP, if the adapter has them.
      const stopSubagentWatch = subagentAdapter?.watch?.({
        log,
        emit: ({ sessionId, update }) => relayUpdate(started, sessionId, update)
      });
      // The agent's own events, for what ACP leaves out of turns its terminal
      // UI starts (OpenCode).
      // Codex's follows the chats a terminal UI has (follow).
      const watcher = agent.watch?.({ log, emit: (event) => fromBackend(started, event) });
      started.watcher = typeof watcher === 'function' ? { stop: watcher } : watcher;
      started.stopWatching = started.watcher ? () => started.watcher.stop() : undefined;
      let stdoutBuffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        if (Buffer.byteLength(stdoutBuffer) > MAX_PAYLOAD && !stdoutBuffer.includes('\n')) {
          log('ACP child wrote an oversized stdio frame');
          closeClients(started, 1009, 'ACP frame from agent is too large');
          endChild(child);
          return;
        }
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
          const frame = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!frame) continue;
          let message;
          try {
            message = JSON.parse(frame);
            if (!protocolObject(message)) throw new Error('ACP frame must be a JSON object');
          } catch (error) {
            log(`ACP child wrote an invalid stdio frame: ${error.message}`);
            closeClients(started, 1011, 'Invalid ACP frame from agent');
            endChild(child);
            return;
          }
          fromAgent(started, frame, message);
        }
      });
      if (usageFd) {
        child.stdio[usageFd].on('error', () => {});
        createInterface({ input: child.stdio[usageFd] }).on('line', (line) => {
          let report;
          try {
            report = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof report?.sessionId !== 'string') return;
          // A subagent's calls count for the chat that started it.
          const owner =
            !started.sessions.has(report.sessionId) && typeof report.parentSessionId === 'string'
              ? report.parentSessionId
              : report.sessionId;
          usage.reported(owner, dshTokens(report.usage));
        });
      }
      child.once('error', (error) => {
        log(`Could not start ${agentName}: ${error.message}`);
        closeClients(started, 1011, 'Could not start agent');
      });
      child.stdin.on('error', (error) => {
        log(`Could not write to ${agentName}: ${error.message}`);
        closeClients(started, 1011, 'Could not write to agent');
      });
      child.once('close', (code, signal) => {
        started.stopWatching?.();
        if (typeof stopSubagentWatch === 'function') stopSubagentWatch();
        for (const timer of started.subagentTimers.values()) clearTimeout(timer);
        if (companion && companion.exitCode === null && companion.signalCode === null) companion.kill('SIGTERM');
        if (stdoutBuffer.trim()) log('ACP child exited with an incomplete stdio frame');
        if (code !== 0 && code !== null) log(`${agentName} exited with status ${code}`);
        else if (signal) log(`${agentName} exited on signal ${signal}`);
        for (const sessionId of started.prompts.keys()) dropPrompts(started, sessionId);
        for (const request of started.requests.values()) {
          request.reject?.(new Error(`${agentName} exited before answering ${request.method}`));
        }
        started.requests.clear();
        if (agentHost === started) {
          agentHost = undefined;
          activity.clear();
          void recorder?.closeAll();
        }
        closeClients(started, 1011, 'Agent process ended');
        agentsChanged();
      });
      return started;
    };

    const startCompanion = async (pluginEnvironment) => {
      const spec = await agent.companion?.();
      if (!spec) return undefined;
      const companion = spawn(spec.command[0], spec.command.slice(1), {
        env: agentEnvironment(environment, { ...agent.env, ...pluginEnvironment }),
        stdio: ['ignore', 'ignore', 'inherit']
      });
      companion.once('error', (error) => log(`Could not start ${agent.label ?? agentName}'s server: ${error.message}`));
      companion.once('close', (code, signal) => {
        if (!closing && code !== 0 && signal !== 'SIGTERM') log(`${agent.label ?? agentName}'s server exited (${code ?? signal})`);
      });
      try {
        await spec.ready();
      } catch (error) {
        companion.kill('SIGTERM');
        throw error;
      }
      return companion;
    };

    const ensureAgent = async () => {
      // E.g. Claude Code, when the app could not download it.
      if (agent.unavailable) throw new Error(agent.unavailable);
      if (agentHost?.retiring) await agentHost.done;
      if (agentHost) return agentHost;
      agentStarting ??= startAgent()
        .then((started) => {
          agentHost = started;
          agentsChanged();
          return started;
        })
        .finally(() => {
          agentStarting = undefined;
        });
      return agentStarting;
    };

    const writeToAgent = (host, message, webSocket) => {
      if (!childRunning(host.child)) return;
      recorder?.fromClient(message);
      if (!host.child.stdin.write(`${JSON.stringify(message)}\n`) && webSocket) {
        webSocket.pause();
        host.child.stdin.once('drain', () => webSocket.resume());
      }
    };

    const requestAgent = (host, method, params = {}) =>
      new Promise((resolve, reject) => {
        if (!childRunning(host.child)) {
          reject(new Error(`${agentName} exited before ${method}`));
          return;
        }
        const id = `cf-${host.nextRequest++}`;
        const key = requestKey(id);
        const request = { client: null, id, bridgeId: id, key, method, params, resolve, reject };
        if (method === 'initialize') {
          host.initialized = new Promise((initialize) => {
            request.initialized = initialize;
          });
        }
        sendRequest(host, request);
      });

    // Sends a request on to the agent under the bridge's id. A chat's prompts
    // take turns: one sent while a turn runs (two windows at once, a wrap-up)
    // waits for its end. Every window that opened the chat is told when a
    // prompt starts, the one that sent it too, so all show it in one order.
    const sendRequest = (host, request, webSocket) => {
      const { key, method, params } = request;
      const sessionId = params?.sessionId;
      const prompt = method === 'session/prompt' && typeof sessionId === 'string';
      const send = () => {
        host.requests.set(key, request);
        if (watched(host, sessionId) && (prompt || method === STEER_METHOD)) {
          host.ownPrompts.set(sessionId, (host.ownPrompts.get(sessionId) ?? 0) + 1);
        }
        if (prompt) {
          activity.turnStarted(key, sessionId);
          sessionInfo.turn(sessionId, true);
          if (request.client) {
            host.prompters.set(sessionId, request.client);
            lastPrompter = request.client;
          }
          const meta = protocolObject(params._meta) ? { _meta: params._meta } : {};
          toSession(sessionId, {
            jsonrpc: '2.0',
            method: '_codeflower/prompted',
            params: { key: sessionKey(agentName, sessionId), sessionId, prompt: params.prompt ?? [], ...meta }
          });
        }
        writeToAgent(
          host,
          withClientCapabilities(withSessionMeta(withMcp(host, request, { jsonrpc: '2.0', id: request.bridgeId, method, params }))),
          webSocket
        );
      };
      if (!prompt) return send();
      const queue = host.prompts.get(sessionId);
      if (!queue) {
        host.prompts.set(sessionId, []);
        return send();
      }
      queue.push({
        send,
        cancel: () =>
          request.client
            ? request.client.send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' } })
            : request.reject(new Error('The prompt was cancelled before it started'))
      });
    };

    // A chat's turn ended: its next prompt starts.
    const promptEnded = (host, sessionId) => {
      const next = host.prompts.get(sessionId)?.shift();
      if (next) next.send();
      else host.prompts.delete(sessionId);
    };

    // Prompts not started yet are cancelled with the turn.
    const dropPrompts = (host, sessionId) => {
      for (const { cancel } of host.prompts.get(sessionId)?.splice(0) ?? []) cancel();
    };

    // ---- what the agent reports itself, beside ACP ----

    // The agent's own events report this chat: all of them (OpenCode), or those
    // its watcher follows (Codex).
    const watched = (host, sessionId) =>
      typeof sessionId === 'string' && Boolean(host.watcher) && (!host.watcher.follows || host.watcher.follows(sessionId));

    // A prompt the bridge sent showed up as a user message.
    const ownPromptSeen = (host, sessionId) => {
      const count = host.ownPrompts.get(sessionId) ?? 0;
      if (count > 1) host.ownPrompts.set(sessionId, count - 1);
      else host.ownPrompts.delete(sessionId);
      return count > 0;
    };

    // A turn the agent's terminal UI started (OpenCode, where it shares the
    // agent's server): ACP relays the assistant's side, the agent's own events
    // (agent.watch) the rest. The chat's windows show it like their own turns.
    const fromBackend = (host, event) => {
      const sessionId = event?.sessionId;
      if (agentHost !== host || typeof sessionId !== 'string' || !host.sessions.has(sessionId)) return;
      switch (event.type) {
        case 'prompt': {
          if (ownPromptSeen(host, sessionId)) return;
          const prompt = Array.isArray(event.prompt) ? event.prompt : [];
          recorder?.record(sessionId, { kind: 'prompt', prompt });
          toSession(sessionId, {
            jsonrpc: '2.0',
            method: '_codeflower/prompted',
            params: { key: sessionKey(agentName, sessionId), sessionId, prompt, _meta: { 'codeflower/from': 'terminal' } }
          });
          return;
        }
        case 'busy': {
          // A turn the bridge started is tracked by its prompt.
          if (activity.busy(sessionId) || host.terminalTurns.has(sessionId)) return;
          const key = `terminal-${sessionId}`;
          host.terminalTurns.set(sessionId, key);
          activity.turnStarted(key, sessionId);
          sessionInfo.turn(sessionId, true);
          // Prompts from windows wait for its end.
          if (!host.prompts.has(sessionId)) host.prompts.set(sessionId, []);
          return;
        }
        case 'idle': {
          const key = host.terminalTurns.get(sessionId);
          if (key === undefined) return;
          // The agent's events come straight from its server, ahead of the
          // turn's last updates over ACP: the turn ends after those.
          setTimeout(() => {
            if (host.terminalTurns.get(sessionId) !== key) return;
            host.terminalTurns.delete(sessionId);
            activity.turnEnded(key, 'end_turn');
            sessionInfo.turn(sessionId, false);
            recorder?.record(sessionId, { kind: 'turn_end', stopReason: 'end_turn' });
            promptEnded(host, sessionId);
          }, TERMINAL_TURN_SETTLE_MS).unref();
          return;
        }
        case 'permissionReplied':
          settleElsewhere(host, sessionId, event.toolCallId, event.reply === 'reject' ? 'reject' : event.reply === 'always' ? 'allow_always' : 'allow_once');
          return;
      }
    };

    // A permission the user answered elsewhere, in the agent's terminal UI: the
    // agent gets the same answer from the bridge (and ignores it, having it
    // already), so its own queue of requests moves on, and the windows close
    // theirs. `kind`: allow_once, allow_always, reject.
    const settleElsewhere = (host, sessionId, toolCallId, kind) => {
      if (typeof toolCallId !== 'string') return;
      for (const [key, waiting] of host.waiting) {
        const { message } = waiting;
        if (waiting.sessionId !== sessionId || message.method !== 'session/request_permission') continue;
        if (message.params?.toolCall?.toolCallId !== toolCallId) continue;
        const options = Array.isArray(message.params.options) ? message.params.options : [];
        const allow = kind.startsWith('allow');
        const option =
          options.find((candidate) => candidate?.kind === kind) ??
          options.find((candidate) => typeof candidate?.kind === 'string' && candidate.kind.startsWith(allow ? 'allow' : 'reject'));
        const result = option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } };
        settleWaiting(host, key, result);
        writeToAgent(host, { jsonrpc: '2.0', id: message.id, result });
      }
    };

    // ---- chats in the agent's terminal UI ----

    const ensureInitialized = async (host) => {
      if (host.initialized) {
        const result = await host.initialized;
        if (!result) throw new Error('The agent could not be initialized');
        return result;
      }
      return requestAgent(host, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: true },
          elicitation: { url: {}, form: {} },
          _meta: { 'terminal-auth': true }
        },
        clientInfo: { name: 'codeflower-vscode', title: 'code flower', version: '0.0.0' }
      });
    };

    // Loads a recorded chat into the agent, as a window does (ui's acp.ts):
    // resume where the agent offers it, else load.
    const openSession = async (host, sessionId, cwd) => {
      if (host.sessions.has(sessionId)) return;
      const holder = await store?.foreignLease(sessionId);
      if (holder) throw new InvalidRequest('The chat is open on another worker');
      const capabilities = (await ensureInitialized(host))?.agentCapabilities ?? {};
      const params = { sessionId, cwd, mcpServers: [] };
      const resume = Boolean(capabilities.sessionCapabilities?.resume) || !capabilities.loadSession;
      await requestAgent(host, resume ? 'session/resume' : 'session/load', params);
    };

    // `_codeflower/terminal/start` with kind "chat": the agent's own terminal
    // UI on a chat (sessionKey) or on a new one (new), which the window then
    // watches. A chat that already has its terminal is attached to instead.
    const startChatTerminal = async (params, client) => {
      if (!agent.tuiCommand) throw new InvalidRequest(`${agent.label ?? agentName} has no terminal UI in code flower`);
      if (!Array.isArray(ptyHelper) || ptyHelper.length === 0) throw new InvalidRequest('This worker cannot open terminals');
      const size = terminalSize(params);
      const watch = params.watch === true;
      const attached = (terminal) => {
        rememberLinkBase(terminal, params.linkBase);
        chatTerminals.attach(terminal, client, { size, watch });
        return { terminalId: terminal.id, sessionKey: terminal.key, sessionId: terminal.sessionId };
      };
      if (!params.new) {
        const running = typeof params.sessionKey === 'string' ? chatTerminals.byKey(params.sessionKey) : undefined;
        if (running) return attached(running);
      }
      const host = await ensureAgent();
      await ensureInitialized(host);
      let sessionId;
      let cwd = workspace;
      if (params.new) {
        const session = await requestAgent(host, 'session/new', { cwd, mcpServers: [] });
        sessionId = session?.sessionId;
        if (typeof sessionId !== 'string') throw new Error('The agent did not return a session id');
      } else {
        if (typeof params.sessionKey !== 'string' || !params.sessionKey.startsWith(`${agentName}-`)) {
          throw new InvalidRequest('Invalid session key');
        }
        const saved = (await ownSessions()).find((session) => session.key === params.sessionKey);
        if (!saved) throw new InvalidRequest('This worker has no such chat');
        sessionId = saved.nativeSessionId;
        cwd = saved.cwd ?? workspace;
        await openSession(host, sessionId, cwd);
      }
      const key = sessionKey(agentName, sessionId);
      // Another window may have started it meanwhile.
      const running = chatTerminals.byKey(key);
      if (running) return attached(running);
      if (agent.handoff) return attached(await handOver(host, sessionId, key, cwd, size, client));
      // Its turns typed in the terminal reach the windows (Codex follows a chat
      // on request); prompts sent before are not reported.
      if (host.watcher?.follow && !host.watcher.follows(sessionId)) {
        host.watcher.follow(sessionId);
        host.ownPrompts.delete(sessionId);
      }
      const command = await agent.tuiCommand({ sessionId, cwd });
      const terminal = chatTerminals.start({
        key,
        sessionId,
        command,
        env: agentEnvironment(environment, agent.env),
        cwd,
        size
      });
      return attached(terminal);
    };

    // ---- chats handed over to the agent's terminal UI (Claude Code) ----

    // Claude Code cannot share a live session with its adapter: the chat is
    // handed over. The adapter lets go of it (session/close) once its turn is
    // over, Claude Code's terminal UI resumes it, and the bridge follows the
    // terminal: hooks mark the turns, the transcript gives their content, and
    // the windows show it all as before. Prompts from windows are typed into the
    // terminal between turns; permissions are answered there. When the terminal
    // UI quits, the adapter resumes the chat with everything in it.
    const handOver = async (host, sessionId, key, cwd, size, client) => {
      while (activity.busy(sessionId)) {
        if (!allClients.has(client) || closing) throw new InvalidRequest('Gone while the chat was working');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const state = host.sessions.get(sessionId) ?? {};
      const handoff = { sessionId, key, cwd, busy: false, injected: 0, queue: [], current: undefined, turns: 0 };
      host.handoffs.set(sessionId, handoff);
      try {
        await requestAgent(host, 'session/close', { sessionId });
        handoff.tail = await tailTranscript(transcriptPath(agent.home ?? '', cwd, sessionId), (update) => mirror(host, sessionId, update), { log });
        await agent.prepareTui?.({ cwd });
        const mode = state.modes?.currentModeId;
        const mcpConfig = await writeMcpConfig(host, key);
        const command = await agent.tuiCommand({
          sessionId,
          cwd,
          mode,
          mcpConfig,
          settings: hookSettings(hookCommand, agent.tuiSettings)
        });
        const terminal = chatTerminals.start({
          key,
          sessionId,
          command,
          env: agentEnvironment(environment, {
            ...agent.env,
            ...agent.tuiEnv,
            CODEFLOWER_HOOK_SOCKET: hookSocket,
            CODEFLOWER_HOOK_CHAT: sessionId
          }),
          cwd,
          size,
          mode: 'handoff'
        });
        handoff.terminal = terminal;
        terminal.onExit = () => {
          // Prompts from now on wait for the adapter, not for this terminal.
          handoff.terminal = undefined;
          void handBack(host, sessionId).catch((error) => log(`Could not take back ${key}: ${error.message}`));
        };
        log(`${key} is handed over to ${agent.label ?? agentName}'s terminal UI`);
        return terminal;
      } catch (error) {
        await handBack(host, sessionId).catch(() => {});
        throw error;
      }
    };

    // The terminal UI quit (or went to another chat): the adapter takes the
    // chat back, and prompts the windows sent meanwhile go to it.
    const handBack = async (host, sessionId) => {
      const handoff = host.handoffs.get(sessionId);
      if (!handoff) return;
      await handoff.tail?.stop();
      host.handoffs.delete(sessionId);
      if (handoff.busy) endTerminalTurn(handoff, 'cancelled');
      handoff.current?.client?.send({ jsonrpc: '2.0', id: handoff.current.id, result: { stopReason: 'cancelled' } });
      if (agentHost !== host || !childRunning(host.child) || closing) return;
      log(`${handoff.key} is back from the terminal UI`);
      await requestAgent(host, 'session/resume', { sessionId, cwd: handoff.cwd, mcpServers: [] });
      for (const queued of handoff.queue) {
        if (!queued.client || !allClients.has(queued.client)) continue;
        const bridgeId = `cf-${host.nextRequest++}`;
        sendRequest(host, {
          client: queued.client,
          id: queued.id,
          bridgeId,
          key: requestKey(bridgeId),
          method: 'session/prompt',
          params: { sessionId, prompt: queued.prompt }
        });
      }
    };

    // An update of the terminal's chat, from its transcript: recorded and sent
    // to the chat's windows as if the adapter had sent it.
    const mirror = (host, sessionId, update) => {
      if (!host.handoffs.has(sessionId)) return;
      recorder?.record(sessionId, { kind: 'update', update });
      if (update.sessionUpdate === 'tool_call') activity.toolCall(sessionId, update);
      toSession(sessionId, { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    };

    const endTerminalTurn = (handoff, stopReason) => {
      handoff.busy = false;
      if (handoff.permission) activity.answered(handoff.permission);
      handoff.permission = undefined;
      activity.turnEnded(handoff.turnKey, stopReason);
      sessionInfo.turn(handoff.sessionId, false);
      recorder?.record(handoff.sessionId, { kind: 'turn_end', stopReason });
    };

    // Types the next prompt a window sent into the terminal UI, once it is
    // between turns: as a bracketed paste, then Enter. Once the terminal moved
    // to another session, prompts wait for handBack to send them to the adapter.
    const typeNext = (handoff) => {
      if (handoff.left || handoff.busy || handoff.current || !handoff.terminal) return;
      const next = handoff.queue.shift();
      if (!next) return;
      handoff.current = next;
      handoff.injected += 1;
      const text = next.prompt.map((block) => block.text).join('\n\n');
      recorder?.record(handoff.sessionId, { kind: 'prompt', prompt: next.prompt });
      toSession(handoff.sessionId, {
        jsonrpc: '2.0',
        method: '_codeflower/prompted',
        params: { key: handoff.key, sessionId: handoff.sessionId, prompt: next.prompt }
      });
      chatTerminals.write(handoff.terminal, `\x1b[200~${text}\x1b[201~`);
      setTimeout(() => handoff.terminal && chatTerminals.write(handoff.terminal, '\r'), PASTE_ENTER_MS).unref();
    };

    // A window's prompt for a chat in the terminal UI: text only, typed there.
    const promptHandedOver = (host, handoff, client, message) => {
      const prompt = Array.isArray(message.params?.prompt) ? message.params.prompt : [];
      if (!prompt.length || prompt.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
        client.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: `The chat is open in ${agent.label ?? agentName}'s terminal UI, which takes text only; quit it there to send files` }
        });
        return;
      }
      handoff.queue.push({ client, id: message.id, prompt });
      typeNext(handoff);
    };

    // Claude Code's hooks (codeflower-hook), for the chat its terminal UI has.
    const fromHook = (event) => {
      const host = agentHost;
      const handoff = host?.handoffs.get(event?.codeflower_chat);
      if (!handoff || handoff.left) return;
      const { sessionId } = handoff;
      switch (event.hook_event_name) {
        case 'SessionStart':
          // Another session in the same terminal (/resume, /clear): the chat
          // goes back to the windows, the terminal stays with the other one.
          if (event.session_id !== sessionId) {
            handoff.left = true;
            chatTerminals.notify(handoff.terminal, '_codeflower/terminal/left', { sessionKey: handoff.key });
            void handBack(host, sessionId).catch((error) => log(`Could not take back ${handoff.key}: ${error.message}`));
          }
          return;
        case 'UserPromptSubmit': {
          if (handoff.injected > 0) {
            handoff.injected -= 1;
          } else if (typeof event.prompt === 'string') {
            const prompt = [{ type: 'text', text: event.prompt }];
            recorder?.record(sessionId, { kind: 'prompt', prompt });
            toSession(sessionId, {
              jsonrpc: '2.0',
              method: '_codeflower/prompted',
              params: { key: handoff.key, sessionId, prompt, _meta: { 'codeflower/from': 'terminal' } }
            });
          }
          if (!handoff.busy) {
            handoff.busy = true;
            handoff.turnKey = `terminal-${sessionId}-${++handoff.turns}`;
            activity.turnStarted(handoff.turnKey, sessionId);
            sessionInfo.turn(sessionId, true);
          }
          return;
        }
        case 'PermissionRequest':
          // Answered in the terminal; the windows see the chat waits.
          handoff.permission = `terminal-permission-${sessionId}`;
          activity.permission(handoff.permission, sessionId, { kind: event.tool_name === 'ExitPlanMode' ? 'switch_mode' : 'other' });
          return;
        case 'PostToolUse':
        case 'PostToolUseFailure':
          if (handoff.permission) activity.answered(handoff.permission);
          handoff.permission = undefined;
          return;
        case 'Stop':
        case 'StopFailure':
          // Claude Code writes the turn's last lines just after the hook: the
          // turn ends once they are in, unless another started meanwhile.
          {
            const turn = handoff.turns;
            void new Promise((resolve) => setTimeout(resolve, TERMINAL_TURN_SETTLE_MS).unref())
              .then(() => handoff.tail?.flush())
              .then(() => {
                if (!handoff.busy || handoff.turns !== turn) return;
                endTerminalTurn(handoff, event.hook_event_name === 'Stop' ? 'end_turn' : 'error');
                const answered = handoff.current;
                handoff.current = undefined;
                answered?.client?.send({ jsonrpc: '2.0', id: answered.id, result: { stopReason: 'end_turn' } });
                answered?.done?.();
                typeNext(handoff);
              });
          }
          return;
      }
    };

    // The configured MCP servers in Claude Code's own form (--mcp-config), as
    // the adapter gives them to its sessions.
    const writeMcpConfig = async (host, key) => {
      const servers = host.mcpServers ?? [];
      if (!servers.length) return undefined;
      const file = join(tmpdir(), `codeflower-mcp-${instanceId}-${key}.json`);
      await writeFile(file, `${JSON.stringify(claudeMcpConfig(servers))}\n`, { mode: 0o600 });
      return file;
    };

    // A run's prompt waits until the agent is signed in, which a window does,
    // and, for keys, until the agent started without them is restarted.
    const startInitialSession = async () => {
      const signedIn = async () => (agent.signedIn ? agent.signedIn() : true);
      if (!(await signedIn())) log(`The run's task waits until ${agent.label ?? agentName} is signed in: connect and sign in`);
      while (!closing && (!(await signedIn()) || agentHost?.withoutKeys)) {
        await new Promise((resolve) => setTimeout(resolve, signInPollMs).unref());
      }
      if (closing) return;
      const host = await ensureAgent();
      await ensureInitialized(host);
      const session = await requestAgent(host, 'session/new', { cwd: workspace, mcpServers: [] });
      if (typeof session?.sessionId !== 'string') {
        throw new Error('The agent did not return a session id');
      }
      await requestAgent(host, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: initialPrompt.trim() }]
      });
    };

    const wrapUpChat = async (host, sessionId, notice, template) => {
      const handoff = host.handoffs.get(sessionId);
      if (handoff) return wrapUpInTerminal(handoff, notice, template);
      // As a client cancels: the turn, then the requests it waits on.
      dropPrompts(host, sessionId);
      writeToAgent(host, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      for (const [key, { message, sessionId: owner }] of host.waiting) {
        // Its subagents' too.
        if (owner !== sessionId && !host.subagents.ancestors(owner).includes(sessionId)) continue;
        const result = message.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' };
        settleWaiting(host, key, result);
        writeToAgent(host, { jsonrpc: '2.0', id: message.id, result });
      }
      const deadline = Date.now() + WRAP_UP_CANCEL_MS;
      while (activity.busy(sessionId) && Date.now() < deadline && !closing) await new Promise((resolve) => setTimeout(resolve, 200));
      if (closing || agentHost !== host) return;
      if (activity.busy(sessionId)) {
        log(`A chat did not stop within ${WRAP_UP_CANCEL_MS / 1000} s; it was not asked to wrap up`);
        return;
      }
      const text = template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => String(notice[name] ?? placeholder)).trim();
      // The window shows the prompt, as it did not send it.
      broadcast({
        jsonrpc: '2.0',
        method: '_codeflower/wrapUp',
        params: { ...notice, key: sessionKey(agentName, sessionId), prompt: text }
      });
      await requestAgent(host, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).catch((error) =>
        log(`A chat could not wrap up: ${error.message}`)
      );
    };

    // A chat the terminal UI has wraps up there: Esc stops its turn, and the
    // wrap-up is typed in, as a window's prompt would be.
    const wrapUpInTerminal = async (handoff, notice, template) => {
      for (const queued of handoff.queue.splice(0)) {
        queued.client?.send({ jsonrpc: '2.0', id: queued.id, result: { stopReason: 'cancelled' } });
      }
      if (handoff.terminal) chatTerminals.write(handoff.terminal, '\x1b');
      const deadline = Date.now() + WRAP_UP_CANCEL_MS;
      while (handoff.busy && Date.now() < deadline && !closing) await new Promise((resolve) => setTimeout(resolve, 200));
      if (closing || handoff.busy) {
        if (handoff.busy) log(`A chat did not stop within ${WRAP_UP_CANCEL_MS / 1000} s; it was not asked to wrap up`);
        return;
      }
      const text = template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => String(notice[name] ?? placeholder)).trim();
      broadcast({ jsonrpc: '2.0', method: '_codeflower/wrapUp', params: { ...notice, key: handoff.key, prompt: text } });
      await new Promise((done) => {
        handoff.queue.push({ prompt: [{ type: 'text', text }], done });
        typeNext(handoff);
      });
    };

    // A permission request or question was answered, by a window or by the
    // bridge: it stops waiting, and the other windows that were asked close it.
    // Returns false when it was answered before, e.g. by another window.
    const settleWaiting = (host, key, result, answeredBy) => {
      const waiting = host.waiting.get(key);
      if (!waiting) return false;
      host.waiting.delete(key);
      activity.answered(key);
      const { sessionId } = waiting;
      const params = {
        ...(sessionId !== undefined ? { key: sessionKey(agentName, sessionId), sessionId } : {}),
        requestKey: key,
        result: result ?? null
      };
      for (const target of clients) {
        if (target !== answeredBy && target.delivered.has(key)) {
          target.send({ jsonrpc: '2.0', method: '_codeflower/requestResolved', params });
        }
      }
      return true;
    };

    // On attach: the requests are in the transcript the window loads, so they
    // are marked to be asked, not added to the chat again.
    const deliverWaiting = (host, target, sessionId) => {
      for (const [key, { message, sessionId: owner }] of host.waiting) {
        // Its subagents' too.
        if (owner !== sessionId && !host.subagents.ancestors(owner).includes(sessionId)) continue;
        const params = protocolObject(message.params) ? message.params : {};
        const meta = protocolObject(params._meta) ? params._meta : {};
        deliver(target, key, { ...message, params: { ...params, _meta: { ...meta, 'codeflower/replayed': true } } });
      }
    };

    // Answers an attach (session/new, resume or load) once the transcript holds
    // everything relayed so far, so the window's transcript and its live updates
    // neither overlap nor leave a gap.
    const attachSession = async (host, target, id, sessionId, result) => {
      while (recorder?.busy) await recorder.idle();
      if (!allClients.has(target) || !host.sessions.has(sessionId)) {
        target.send({ jsonrpc: '2.0', id, result });
        return;
      }
      target.sessions.add(sessionId);
      const leftOut = mcpLeftOut(host, sessionId);
      target.send({
        jsonrpc: '2.0',
        id,
        result: {
          ...result,
          _meta: {
            ...(protocolObject(result._meta) ? result._meta : {}),
            'codeflower/transcriptEntries': recorder?.entryCount(sessionId) ?? 0,
            'codeflower/busy': activity.busy(sessionId),
            ...(leftOut.length ? { 'codeflower/mcpLeftOut': leftOut } : {})
          }
        }
      });
      deliverWaiting(host, target, sessionId);
    };

    const rememberSession = (host, sessionId, result) => {
      const { sessionId: _, _meta, ...state } = result;
      host.sessions.set(sessionId, structuredClone(state));
      sessionInfo.settings(sessionId, state);
    };

    // Keeps a loaded session's settings current, so a reattach reports them.
    const trackSettings = (host, sessionId, update) => {
      const state = host.sessions.get(sessionId);
      if (!state || !protocolObject(update)) return;
      if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        state.configOptions = update.configOptions;
      } else if (update.sessionUpdate === 'current_mode_update' && state.modes) {
        state.modes.currentModeId = update.currentModeId;
      }
      sessionInfo.settings(sessionId, state);
    };

    const toSettings = (sessionId, update, except) =>
      toSession(sessionId, { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }, except);

    // A setting that follows another, or a new chat's start, as the agent's
    // index.js says (followSetting, e.g. OpenCode's model for each mode, dsh's
    // last model): asked of the agent like a window's change, whose answer
    // reaches every window.
    const followSetting = async (host, sessionId, configId, value, started = false) => {
      const state = host.sessions.get(sessionId);
      if (!agent.followSetting || !state || (!started && typeof configId !== 'string')) return;
      try {
        const follow = await agent.followSetting({ configId, value, configOptions: state.configOptions ?? [], started });
        if (follow) await requestAgent(host, 'session/set_config_option', { sessionId, configId: follow.configId, value: follow.value });
      } catch (error) {
        log(`Could not apply the setting that follows ${configId}: ${error.message}`);
      }
    };
    // A new chat starts, in a mode if the agent has modes, which settings may follow too.
    const followMode = (host, sessionId) => {
      const mode = (host.sessions.get(sessionId)?.configOptions ?? []).find((option) => option?.category === 'mode');
      return followSetting(host, sessionId, mode?.id, mode?.currentValue, true);
    };

    // The agent answered a client request.
    const settleRequest = (host, request, message) => {
      const { method, params, key } = request;
      if (method === 'session/prompt') {
        activity.turnEnded(key, message.error ? 'error' : (message.result?.stopReason ?? null));
        sessionInfo.turn(params?.sessionId, false);
      }
      const result = message.result;
      if (method === 'initialize') {
        // Remember the sign-in methods the agent offers, so terminal sign-ins
        // can only run commands the agent itself announced.
        if (!message.error) host.authMethods = Array.isArray(result?.authMethods) ? result.authMethods : [];
        if (!message.error) sessionInfo.reported(result?.agentInfo);
        if (!message.error && mcpServers.length) {
          const chosen = mcpServersFor(mcpServers, result, { path: agentEnvironment(environment, agent.env).PATH, workspace });
          host.mcpServers = chosen.servers;
          host.mcpSkipped = chosen.skipped;
          if (chosen.skipped.length) log(`MCP servers left out for ${agent.label ?? agentName}: ${describeLeftOut(chosen.skipped)}`);
        }
        request.initialized(message.error ? undefined : result);
        if (message.error) host.initialized = undefined;
      }
      if (message.error || !protocolObject(result)) return false;
      const sessionId = method === 'session/new' ? result.sessionId : params?.sessionId;
      if (typeof sessionId !== 'string') return false;
      const state = host.sessions.get(sessionId);
      switch (method) {
        case 'session/new':
        case 'session/resume':
        case 'session/load':
          if (request.mcpFailed?.length) host.mcpFailed.set(sessionId, request.mcpFailed);
          else host.mcpFailed.delete(sessionId);
          rememberSession(host, sessionId, result);
          // The session's totals start from those its transcript recorded.
          void (recorder?.isOpen(sessionId) ?? Promise.resolve()).then(() =>
            usage.opened(sessionId, store?.storedUsage(sessionId))
          );
          if (allClients.has(request.client)) {
            void attachSession(host, request.client, request.id, sessionId, result).then(() => {
              if (method === 'session/new') return followMode(host, sessionId);
            });
          } else if (method === 'session/new') {
            void followMode(host, sessionId);
          }
          return true;
        // The agent let go of the chat: the next window or terminal to open it
        // loads it again, instead of attaching to what the agent no longer has.
        case 'session/close':
          // Handed over to the terminal UI: the windows keep the chat open,
          // and the bridge its settings and record, until it comes back.
          if (host.handoffs.has(sessionId)) break;
          host.sessions.delete(sessionId);
          host.mcpFailed.delete(sessionId);
          for (const target of clients) target.sessions.delete(sessionId);
          void recorder?.close(sessionId);
          for (const child of host.subagents.childrenOf(sessionId)) void recorder?.close(child.sessionId);
          break;
        // The other windows with the chat open follow a change of settings.
        case 'session/set_config_option':
          if (state && Array.isArray(result.configOptions)) {
            state.configOptions = result.configOptions;
            sessionInfo.settings(sessionId, state);
            toSettings(sessionId, { sessionUpdate: 'config_option_update', configOptions: result.configOptions }, request.client);
            void followSetting(host, sessionId, params?.configId, params?.value);
          }
          break;
        case 'session/set_mode':
          if (state?.modes) state.modes.currentModeId = params.modeId;
          toSettings(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId }, request.client);
          break;
        case 'session/set_model':
        case 'session/unstable_setSessionModel':
          if (state?.models) state.models.currentModelId = params.modelId;
          if (state) sessionInfo.settings(sessionId, state);
          break;
      }
      return false;
    };

    const fromAgent = (host, frame, message) => {
      // An answer to a client request: back to the window that asked, with its own id.
      if (message.method === undefined && message.id !== undefined) {
        const request = host.requests.get(requestKey(message.id));
        if (!request) {
          log('The agent answered a request nobody sent');
          return;
        }
        host.requests.delete(requestKey(message.id));
        if (message.error && retryWithoutMcp(host, request, message.error)) return;
        const turn = request.method === 'session/prompt' ? endTurn(request, message) : undefined;
        recorder?.fromAgent(message, turn);
        // Attaches answer once the recorder caught up.
        const attached = settleRequest(host, request, message);
        if (message.error) request.reject?.(new Error(message.error.message ?? `${request.method} failed`));
        else request.resolve?.(message.result);
        // A message the turn took in shows in every window, as a prompt does.
        const steered = request.method === STEER_METHOD && message.result?.outcome === 'injected';
        if (request.method === STEER_METHOD && !steered) ownPromptSeen(host, request.params?.sessionId);
        if (steered) {
          const sessionId = request.params.sessionId;
          toSession(sessionId, {
            jsonrpc: '2.0',
            method: '_codeflower/prompted',
            params: { key: sessionKey(agentName, sessionId), sessionId, prompt: request.params.prompt ?? [] }
          });
        }
        if (!attached && allClients.has(request.client)) {
          // Windows that know of it show the others' prompts and settings live.
          const answer =
            request.method === 'initialize' && protocolObject(message.result)
              ? { ...message, result: withMultiClient(message.result) }
              : steered
                ? { ...message, result: withPrompted(message.result) }
                : message;
          request.client.send({ ...answer, id: request.id });
        }
        if (request.method === 'session/prompt' && typeof request.params?.sessionId === 'string') {
          promptEnded(host, request.params.sessionId);
        }
        return;
      }
      const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined;

      if (message.method === 'session/update') {
        let update = message.params?.update;
        // The agent's own corrections (index.js's adjustUpdate, e.g. dsh's
        // failed commands), before anything records or reads the update.
        const adjusted = agent.adjustUpdate?.(update);
        if (adjusted) {
          update = adjusted;
          message = { ...message, params: { ...message.params, update } };
          frame = undefined;
        }
        // In the canonical form of subagents (subagents/adapters.js).
        const translated = sessionId !== undefined ? subagentAdapter?.translate(update, sessionId) : undefined;
        if (translated) {
          for (const item of translated) relayUpdate(host, item.sessionId, item.update);
        } else {
          relayUpdate(host, sessionId, update, frame, message);
        }
        return;
      }
      recorder?.fromAgent(message);

      if (message.id !== undefined) {
        const key = requestKey(message.id);
        if (message.method === 'session/request_permission' || message.method === 'elicitation/create') {
          // It waits for the user, however long they are away, and goes to
          // every window with the chat open; the key lets them tell when
          // another one answered. A subagent's goes to its parents' windows
          // too, which say whose it is.
          const params = protocolObject(message.params) ? message.params : {};
          const meta = protocolObject(params._meta) ? params._meta : {};
          const parents = sessionId !== undefined ? host.subagents.ancestors(sessionId) : [];
          const tagged = {
            ...message,
            params: { ...params, _meta: { ...meta, 'codeflower/requestKey': key, ...(parents.length ? { 'codeflower/parentSessionIds': parents } : {}) } }
          };
          host.waiting.set(key, { message: tagged, sessionId });
          // The chat the user works in waits, not the subagent.
          const chat = parents.at(-1) ?? sessionId;
          if (chat !== undefined && message.method === 'session/request_permission') {
            activity.permission(key, chat, message.params?.toolCall);
          } else if (chat !== undefined && message.params?.mode !== 'url') {
            activity.question(key, chat);
          }
          for (const target of clients) {
            if (sessionId === undefined || target.sessions.has(sessionId) || parents.some((parent) => target.sessions.has(parent))) {
              deliver(target, key, tagged);
            }
          }
          if (chat !== undefined && message.method === 'session/request_permission') {
            void showPlan(host, chat, message.params?.toolCall);
          }
          return;
        }
        // Anything else the agent asks goes to one window: the one whose prompt
        // started the turn, else the newest.
        const prompter = sessionId !== undefined ? host.prompters.get(host.subagents.rootOf(sessionId)) : undefined;
        const target = allClients.has(prompter) ? prompter : newestClient();
        if (target) {
          host.forwarded.set(key, target);
          target.sendFrame(frame);
        } else {
          writeToAgent(host, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `No client is connected for ${message.method}` }
          });
        }
        return;
      }

      // The login behind the agent (Claude Code, Codex).
      if (message.method === '_auth/status_update') {
        usage.auth(message.params?.authStatus);
        agentsChanged();
      }
      // Claude Code's rate limit events, which the bridge asked for (sessionMeta).
      if (message.method === '_claude/sdkMessage' && message.params?.message?.type === 'rate_limit_event') {
        usage.claudeRateLimit(message.params.message.rate_limit_info);
        return;
      }
      for (const target of clients) target.sendFrame(frame);
    };

    // One session update in canonical form: its subagents noted, recorded, and
    // sent to the windows that opened its chat. A subagent's own updates go
    // only to windows that opened the subagent (_codeflower/subagents/open).
    const relayUpdate = (host, sessionId, update, frame, message) => {
      if (sessionId === undefined) return;
      message ??= { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } };
      host.subagents.observe(sessionId, update);
      // Recorded from its first state the parent's record takes (a load's replay is not).
      if (update?.sessionUpdate === 'subagent_update' && typeof update.sessionId === 'string') {
        void recorder?.openChild(update.sessionId, sessionId);
      }
      recorder?.fromAgent(message);
      trackSettings(host, sessionId, update);
      // A subagent's tools and usage are its parent's turn's, shown in its summary.
      if (!host.subagents.isChild(sessionId)) {
        if (update?.sessionUpdate === 'tool_call') activity.toolCall(sessionId, update);
        if (update?.sessionUpdate === 'usage_update') usage.update(sessionId, update);
      }
      // A tool that ran (or failed) while its permission still waited here
      // was answered elsewhere, in the agent's terminal UI.
      if (update?.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
        settleElsewhere(host, sessionId, update.toolCallId, update.status === 'completed' ? 'allow_once' : 'reject');
      }
      frame ??= JSON.stringify(message);
      for (const target of clients) if (target.sessions.has(sessionId)) target.sendFrame(frame);
    };

    // ---- subagents ----

    // A subagent as the windows see it: its summary with its and its parent's keys.
    const publicSubagent = (summary) => ({
      ...summary,
      key: sessionKey(agentName, summary.sessionId),
      parentKey: sessionKey(agentName, summary.parentId)
    });

    // A subagent changed: its summary is kept in its record and goes to the
    // windows of its parent and its own, at most once a second while it runs.
    const subagentChanged = (host, summary) => {
      const childId = summary.sessionId;
      const publish = () => {
        host.subagentTimers.delete(childId);
        const current = host.subagents.summary(childId);
        if (!current) return;
        const subagent = publicSubagent(current);
        void recorder?.setSubagent(childId, subagent);
        const notice = { jsonrpc: '2.0', method: '_codeflower/subagents/changed', params: { parentKey: subagent.parentKey, subagent } };
        for (const target of clients) {
          if (target.subagents && (target.sessions.has(current.parentId) || target.sessions.has(childId))) target.send(notice);
        }
      };
      const running = summary.state === 'running' || summary.state === 'requires_action';
      if (!running) {
        clearTimeout(host.subagentTimers.get(childId));
        publish();
        return;
      }
      if (!host.subagentTimers.has(childId)) host.subagentTimers.set(childId, setTimeout(publish, SUBAGENT_NOTIFY_MS));
    };

    // The subagent settings, and whether the running agent has yet to take
    // those it reads only at start (a restart applies them).
    const subagentSettingsState = () => ({
      settings: subagentSettings.get(),
      features: subagentAdapter.features,
      restartPending: Boolean(agentHost) && JSON.stringify(subagentEffects().env) !== JSON.stringify(startedSubagentEnv)
    });

    // A chat's subagents: those of the running agent, and those recorded before.
    const subagentsOf = async (parentKey) => {
      const live = new Map();
      const host = agentHost;
      // A chat, or a subagent with subagents of its own.
      const parentId = host
        ? ([...host.sessions.keys()].find((sessionId) => sessionKey(agentName, sessionId) === parentKey) ?? liveSubagent(host, parentKey))
        : undefined;
      if (parentId !== undefined) {
        for (const summary of host.subagents.childrenOf(parentId)) live.set(sessionKey(agentName, summary.sessionId), publicSubagent(summary));
      }
      if (sessionsDirectory) {
        await recorder?.flush();
        for (const child of await listSubagents(sessionsDirectory, parentKey)) {
          if (live.has(child.key)) continue;
          const summary = child.summary ?? { sessionId: child.nativeSessionId, state: 'unknown' };
          // Recorded as running by a worker that is gone: it cannot be anymore.
          const gone = !host?.subagents.isChild(child.nativeSessionId) && (summary.state === 'running' || summary.state === 'requires_action');
          live.set(child.key, { ...summary, key: child.key, parentKey, ...(gone ? { state: 'unknown' } : {}) });
        }
      }
      return [...live.values()].sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
    };

    // The native id behind a subagent's key, among the running agent's subagents.
    const liveSubagent = (host, key) => {
      for (const sessionId of host?.sessions.keys() ?? []) {
        const found = findSubagent(host, sessionId, key);
        if (found) return found;
      }
      return undefined;
    };
    const findSubagent = (host, parentId, key) => {
      for (const summary of host.subagents.childrenOf(parentId)) {
        if (sessionKey(agentName, summary.sessionId) === key) return summary.sessionId;
        const nested = findSubagent(host, summary.sessionId, key);
        if (nested) return nested;
      }
      return undefined;
    };

    // A prompt's answer: what the turn added to the session's usage, which a
    // prompt result without counts (dsh) gets from the bridge.
    const endTurn = (request, message) => {
      const sessionId = request.params?.sessionId;
      if (message.error || typeof sessionId !== 'string' || !protocolObject(message.result)) return undefined;
      const turn = usage.turnEnded(sessionId, message.result);
      if (turn?.usage && !protocolObject(message.result.usage)) message.result.usage = turn.usage;
      if (agent.limitsCommand) refreshLimits();
      return turn;
    };

    // What the bridge asks of every session the agent starts, e.g. Claude Code's
    // rate limit events, next to what the window asked.
    // So are the subagent settings the agent takes per session (subagents/settings.js).
    const withSessionMeta = (message) => {
      if (!SESSION_STARTS.includes(message.method) || !protocolObject(message.params)) return message;
      const extra = mergeMeta(agent.sessionMeta, subagentEffects().sessionMeta);
      if (!Object.keys(extra).length) return message;
      return { ...message, params: { ...message.params, _meta: mergeMeta(message.params._meta, extra) } };
    };

    // The agent hears of everything the bridge handles for its windows, e.g.
    // subagents, whichever window or task initialized it first.
    const withClientCapabilities = (message) => {
      if (message.method !== 'initialize' || !subagentAdapter || !protocolObject(message.params)) return message;
      const capabilities = protocolObject(message.params.clientCapabilities) ? message.params.clientCapabilities : {};
      return { ...message, params: { ...message.params, clientCapabilities: mergeMeta(capabilities, subagentAdapter.clientCapabilities) } };
    };

    // The configured MCP servers the agent takes, in every session it starts,
    // next to the window's own; without those that already failed this request.
    const mcpServersOf = (host, request) =>
      (host.mcpServers ?? []).filter((server) => !request.mcpFailed?.includes(server.name));
    const withMcp = (host, request, message) => {
      if (!mcpServers.length || !SESSION_STARTS.includes(message.method) || !protocolObject(message.params)) return message;
      return { ...message, params: withMcpServers(message.params, mcpServersOf(host, request)) };
    };

    // A session start that failed on a configured MCP server (dsh) is sent
    // again without it, so one broken server does not stop every chat. The
    // windows hear which servers the chat is without (mcpLeftOut).
    const retryWithoutMcp = (host, request, error) => {
      if (!SESSION_STARTS.includes(request.method) || !protocolObject(request.params)) return false;
      const failed = failedMcpServers(error, addedMcpServers(request.params, mcpServersOf(host, request)));
      if (!failed.length) return false;
      request.mcpFailed = [...(request.mcpFailed ?? []), ...failed];
      log(`MCP server${failed.length > 1 ? 's' : ''} ${failed.join(', ')} did not start in ${agent.label ?? agentName}; ${request.method} again without`);
      sendRequest(host, request);
      return true;
    };

    // The configured servers a session is without, and why.
    const mcpLeftOut = (host, sessionId) => [
      ...(host.mcpSkipped ?? []),
      ...(host.mcpFailed.get(sessionId) ?? []).map((name) => ({ name, reason: DID_NOT_START }))
    ];

    // A plan to approve (Claude Code's ExitPlanMode, kind switch_mode) is shown
    // like a file from codeflower-show: the user reads and may edit it before
    // answering. Only a file the user may see, i.e. in the workspace.
    async function showPlan(host, sessionId, toolCall) {
      const path = activity.isPlan(sessionId, toolCall) ? toolCall?.rawInput?.planFilePath : undefined;
      if (typeof path !== 'string') return;
      let file;
      try {
        file = await resolveFile(path, fileOptions);
      } catch {
        return;
      }
      const prompter = host.prompters.get(sessionId);
      const target = allClients.has(prompter) && prompter.sessions.has(sessionId)
        ? prompter
        : [...clients].reverse().find((client) => client.sessions.has(sessionId));
      if (target) sendShow(target, [file], { sessionId, message: 'The plan to approve; edit it before you answer to change it' });
    }

    // ---- its windows ----

    // A window of this agent's: it starts the agent, if it is not running yet.
    const connect = async (self) => {
      let host;
      try {
        host = await ensureAgent();
      } catch (error) {
        log(`Could not prepare ${agentName}: ${error.message}`);
        self.close(agent.unavailable ? 4004 : 1011, agent.unavailable ? 'Agent unavailable' : 'Could not start agent');
        return;
      }
      self.agent = host;
      // Sign-in links the agent sent while no window was connected.
      for (const [key, { message, sessionId }] of host.waiting) {
        if (sessionId === undefined) deliver(self, key, message);
      }
    };

    const handleClientMessage = async (self, message) => {
      const host = self.agent;
      if (!host || !childRunning(host.child) || !allClients.has(self)) return;

      // An answer to the agent's request: the first window's is forwarded,
      // later ones (another window, or after the wrap-up) are dropped.
      if (message.method === undefined) {
        if (message.id === undefined) return;
        const key = requestKey(message.id);
        if (settleWaiting(host, key, message.result, self)) {
          writeToAgent(host, message, self.webSocket);
        } else if (host.forwarded.get(key) === self) {
          host.forwarded.delete(key);
          writeToAgent(host, message, self.webSocket);
        }
        return;
      }
      if (message.id === undefined) {
        // Stop in a chat the terminal UI has: Esc there, and the prompts typed
        // next are dropped.
        const handoff = host.handoffs.get(message.params?.sessionId);
        if (handoff && message.method === 'session/cancel') {
          for (const queued of handoff.queue.splice(0)) {
            queued.client?.send({ jsonrpc: '2.0', id: queued.id, result: { stopReason: 'cancelled' } });
          }
          if (handoff.terminal) chatTerminals.write(handoff.terminal, '\x1b');
          return;
        }
        if (handoff) return;
        // Stop also cancels the chat's prompts still waiting for the turn.
        if (message.method === 'session/cancel' && typeof message.params?.sessionId === 'string') {
          dropPrompts(host, message.params.sessionId);
        }
        writeToAgent(host, message, self.webSocket);
        return;
      }

      const respond = (result) => self.send({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') {
        const info = protocolObject(message.params?.clientInfo) ? message.params.clientInfo : {};
        const name = [info.name, info.version].filter((part) => typeof part === 'string').join(' ');
        if (name) log(`Client ${self.id} is ${name.slice(0, 200)}`);
        // A window with chats; `codeflower attach` speaks only the control methods.
        self.acp = true;
        // One that shows subagents in chats of their own; others never get their updates.
        self.subagents = protocolObject(message.params?.clientCapabilities?.subagents);
      }
      if (message.method === 'initialize' && host.initialized) {
        const result = await host.initialized;
        if (result) {
          respond(withMultiClient(result));
          return;
        }
      }
      const sessionId = message.params?.sessionId;
      if (
        (message.method === 'session/resume' || message.method === 'session/load') &&
        typeof sessionId === 'string' &&
        host.sessions.has(sessionId)
      ) {
        // Still loaded in this agent: reattach instead of loading it again.
        await attachSession(host, self, message.id, sessionId, host.sessions.get(sessionId));
        return;
      }
      // A chat the terminal UI has: prompts are typed there, nothing else goes.
      const handoff = host.handoffs.get(sessionId);
      if (handoff) {
        if (message.method === 'session/prompt') {
          promptHandedOver(host, handoff, self, message);
        } else {
          self.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: `The chat is open in ${agent.label ?? agentName}'s terminal UI: change it there, or quit it (~q) to go on here` }
          });
        }
        return;
      }
      if (recorder) {
        const refusal = await recorder.admitClientMessage(message);
        if (refusal) {
          self.send(refusal);
          return;
        }
      }

      // A message for the running turn (ACP steering). Without one the window
      // sends it as a prompt: an agent would start a turn of its own, which
      // the bridge would not track.
      if (message.method === STEER_METHOD && typeof sessionId === 'string') {
        if (!activity.busy(sessionId)) {
          respond({ outcome: 'promptRequired', reason: 'noRunningTurn' });
          return;
        }
        const meta = protocolObject(message.params._meta) ? message.params._meta : {};
        message.params._meta = { ...meta, steering: { ...meta.steering, idleBehavior: 'promptRequired' } };
      }

      const bridgeId = `cf-${host.nextRequest++}`;
      const key = requestKey(bridgeId);
      const request = { client: self, id: message.id, bridgeId, key, method: message.method, params: message.params };
      if (message.method === 'initialize') {
        host.initialized = new Promise((resolve) => (request.initialized = resolve));
      }
      sendRequest(host, request, self.webSocket);
    };

    // ---- sign-in terminals ----

    const terminalCommand = async (self, methodId) => {
      // The worker's own window initialized no agent: the bridge does.
      const host = self.agentName === undefined ? await signInHost() : self.agent;
      const method = (host?.authMethods ?? []).find((candidate) => candidate?.id === methodId);
      if (!method) throw new InvalidRequest(`The agent offers no sign-in method ${String(methodId)}`);
      return terminalAuthCommand(agent, method);
    };

    const startTerminal = async (self, params) => {
      if (!Array.isArray(ptyHelper) || ptyHelper.length === 0) {
        throw new InvalidRequest('This worker cannot open terminals');
      }
      const command = await terminalCommand(self, params.methodId);
      const columns = Number.isInteger(params.columns) ? Math.min(Math.max(params.columns, 20), 500) : 100;
      const rows = Number.isInteger(params.rows) ? Math.min(Math.max(params.rows, 5), 200) : 30;
      const terminalId = randomUUID();
      const terminal = spawn(ptyHelper[0], [...ptyHelper.slice(1), ...command], {
        env: { ...agentEnvironment(environment, agent.env), COLUMNS: String(columns), LINES: String(rows) },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      self.terminals.set(terminalId, terminal);
      const output = (data) =>
        self.send({ jsonrpc: '2.0', method: '_codeflower/terminal/output', params: { terminalId, data } });
      terminal.stdout.setEncoding('utf8');
      terminal.stderr.setEncoding('utf8');
      terminal.stdout.on('data', output);
      terminal.stderr.on('data', output);
      terminal.stdin.on('error', () => {});
      terminal.once('error', (error) => output(`\r\nCould not start the sign-in: ${error.message}\r\n`));
      terminal.once('close', (code, signal) => {
        self.terminals.delete(terminalId);
        // The sign-in may have worked.
        agentsChanged();
        self.send({
          jsonrpc: '2.0',
          method: '_codeflower/terminal/exit',
          params: { terminalId, exitCode: code ?? (signal ? 128 : 1) }
        });
      });
      return { terminalId };
    };

    // ---- the user's shell commands (`!command` in the chat) ----

    // Runs like the agent's own commands: in the workspace, with the project's
    // environment and without the worker's token. Output streams to the
    // connected window; the command and its (capped) output go into the
    // session record, and it keeps running if the window goes away.
    const runShell = async (self, params) => {
      const { sessionId, runId, command } = params;
      if (typeof command !== 'string' || !command.trim() || command.length > MAX_SHELL_COMMAND) {
        throw new InvalidRequest('The command must be a non-empty string');
      }
      if (typeof runId !== 'string' || !runId || shells.has(runId)) throw new InvalidRequest('Invalid runId');
      // Registered before any waiting, so a Stop that arrives early still counts.
      let stopRequested = false;
      shells.set(runId, { stop: () => (stopRequested = true) });
      try {
        if (recorder && !(typeof sessionId === 'string' && (await recorder.isOpen(sessionId)))) {
          throw new InvalidRequest('The session is not open on this worker');
        }
      } catch (error) {
        shells.delete(runId);
        throw error;
      }
      recorder?.record(sessionId, { kind: 'shell', runId, command });
      // The other windows with the chat open show the command as it runs.
      const shellParams = typeof sessionId === 'string' ? { key: sessionKey(agentName, sessionId), sessionId, runId } : undefined;
      if (shellParams) {
        toSession(sessionId, { jsonrpc: '2.0', method: '_codeflower/shell/started', params: { ...shellParams, command } }, self);
      }
      return new Promise((resolve) => {
        const shell = spawn('/bin/sh', ['-c', command], {
          cwd: workspace,
          env: { ...agentEnvironment(environment, agent.env), PAGER: 'cat', GIT_PAGER: 'cat' },
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so Stop ends everything it started.
          detached: true
        });
        let output = '';
        let timedOut = false;
        const stop = () => {
          try {
            process.kill(-shell.pid, 'SIGTERM');
          } catch {}
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, SHELL_TIMEOUT_MS);
        shells.set(runId, { stop });
        if (stopRequested) stop();
        const forward = (data) => {
          if (output.length < MAX_SHELL_RECORD) output += data.slice(0, MAX_SHELL_RECORD - output.length);
          const notice = { jsonrpc: '2.0', method: '_codeflower/shell/output', params: { runId, data } };
          self.send(notice);
          if (shellParams) toSession(sessionId, notice, self);
        };
        shell.stdout.setEncoding('utf8');
        shell.stderr.setEncoding('utf8');
        shell.stdout.on('data', forward);
        shell.stderr.on('data', forward);
        const finish = (exitCode) => {
          clearTimeout(timer);
          shells.delete(runId);
          const result = { exitCode, timedOut, truncated: output.length >= MAX_SHELL_RECORD };
          recorder?.record(sessionId, { kind: 'shell_end', runId, output, ...result });
          if (shellParams) {
            toSession(sessionId, { jsonrpc: '2.0', method: '_codeflower/shell/ended', params: { ...shellParams, ...result } }, self);
          }
          resolve(result);
        };
        shell.once('error', (error) => {
          forward(`${error.message}\n`);
          finish(127);
        });
        shell.once('close', (code, signal) => finish(code ?? (signal ? 128 + 15 : 1)));
      });
    };


    const sessionKeyAllowed = (key) => typeof key === 'string' && key.startsWith(`${agentName}-`);

    // The worker's requests that are this agent's (handleControl): on its
    // windows, or on any with `agent` or with the key of one of its chats.
    // False for a method it does not know.
    const control = async (self, message, params, respond) => {
      const requireSessions = () => {
        if (!sessionsDirectory) throw new InvalidRequest('This worker does not record sessions');
        return sessionsDirectory;
      };
      const requirePlugins = () => {
        if (!plugins?.available) throw new InvalidRequest(`${agent.label ?? agentName} has no plugins in code flower`);
        return plugins;
      };
      const requireOwnSession = () => {
        if (!sessionKeyAllowed(params.key)) throw new InvalidRequest('Invalid session key');
        return params.key;
      };
      switch (message.method) {
        case '_codeflower/usage':
          respond(usageSnapshot());
          // The login's limits, if the last read is old; the notification brings them.
          refreshLimits();
          break;
        case '_codeflower/sessions/transcript': {
          const directory = requireSessions();
          const key = requireOwnSession();
          // A chat still running here: everything relayed so far is in the file.
          await recorder?.flush();
          // Clients that page ask for `before` and `maxBytes`; others get it all.
          const paged = params.before !== undefined || params.maxBytes !== undefined;
          respond(
            paged
              ? await readTranscriptPage(directory, key, { before: params.before, maxBytes: params.maxBytes })
              : { entries: await readTranscript(directory, key) }
          );
          break;
        }
        case '_codeflower/sessions/rename':
          await renameSession(requireSessions(), requireOwnSession(), params.title);
          respond({});
          break;
        case '_codeflower/sessions/delete': {
          const directory = requireSessions();
          const key = requireOwnSession();
          // A chat loaded here is released first, unless it is working.
          const host = agentHost;
          const loaded = [...(host?.sessions.keys() ?? [])].find((sessionId) => sessionKey(agentName, sessionId) === key);
          if (loaded !== undefined) {
            if (activity.busy(loaded)) throw new InvalidRequest('The chat is still working; stop it first');
            host.sessions.delete(loaded);
            host.mcpFailed.delete(loaded);
            for (const target of clients) target.sessions.delete(loaded);
            usage.forget(loaded);
            await recorder?.close(loaded);
            for (const child of host.subagents.childrenOf(loaded)) await recorder?.close(child.sessionId);
            host.subagents.forget(loaded);
          }
          await deleteSession(directory, key);
          respond({});
          break;
        }
        case '_codeflower/terminal/start':
          respond(params.kind === 'chat' ? await startChatTerminal(params, self) : await startTerminal(self, params));
          break;
        case '_codeflower/shell/run':
          // Answered when the command ends; other requests keep flowing meanwhile.
          void runShell(self, params).then(respond, (error) =>
            self.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } })
          );
          break;
        case '_codeflower/sessions/record': {
          // The client notes which files the agent showed the user (it knows the chat).
          const { sessionId, entry } = params;
          const files = Array.isArray(entry?.files) ? entry.files.filter((file) => typeof file === 'string') : [];
          if (entry?.kind !== 'show' || !files.length || files.length > 20) throw new InvalidRequest('Only shown files can be recorded');
          if (!recorder || !(typeof sessionId === 'string' && (await recorder.isOpen(sessionId)))) {
            throw new InvalidRequest('The session is not open on this worker');
          }
          recorder.record(sessionId, {
            kind: 'show',
            files: files.map((file) => file.slice(0, 4096)),
            ...(typeof entry.message === 'string' ? { message: entry.message.slice(0, 2000) } : {})
          });
          respond({});
          break;
        }
        case '_codeflower/credentials/set':
          if (!agent.setCredentials) {
            throw new InvalidRequest(`${agent.label ?? agentName} signs in through the agent`);
          }
          await agent.setCredentials(params);
          // The agent reads its keys at start: restart it to apply them.
          respond({ restartRequired: true });
          agentsChanged();
          break;
        case '_codeflower/credentials/get':
          if (!agent.credentials) {
            throw new InvalidRequest(`${agent.label ?? agentName} signs in through the agent`);
          }
          respond(await agent.credentials());
          break;
        case '_codeflower/credentials/models':
          if (!agent.listModels) {
            throw new InvalidRequest(`${agent.label ?? agentName} does not use an OpenAI-compatible endpoint`);
          }
          respond({ models: await agent.listModels(params) });
          break;
        case '_codeflower/credentials/check':
          if (!agent.checkEndpoint) {
            throw new InvalidRequest(`${agent.label ?? agentName} does not use an OpenAI-compatible endpoint`);
          }
          respond(await agent.checkEndpoint(params));
          break;
        case '_codeflower/plugins/list':
          respond(plugins ? await plugins.list() : { available: false });
          break;
        case '_codeflower/plugins/catalog':
          respond(await requirePlugins().catalog(params.catalog));
          break;
        case '_codeflower/plugins/add':
          respond(await requirePlugins().add(params.source));
          break;
        case '_codeflower/plugins/remove':
          respond(await requirePlugins().remove(params.id));
          break;
        case '_codeflower/plugins/setEnabled':
          respond(await requirePlugins().setEnabled(params.id, params.enabled));
          break;
        case '_codeflower/plugins/catalogs/add':
          respond(await requirePlugins().addCatalog(params.source));
          break;
        case '_codeflower/plugins/catalogs/remove':
          respond(await requirePlugins().removeCatalog(params.source));
          break;
        case '_codeflower/plugins/fetch': {
          const manager = requirePlugins();
          // Without the network the app's fetch run does it (codeflower plugins fetch).
          if (!manager.canFetch) throw new InvalidRequest('This sandbox has no network to fetch plugins', { pendingFetch: true });
          respond({ started: true });
          void manager.fetch().catch((error) => log(`Could not fetch plugins: ${error.message}`));
          break;
        }
        // ---- subagents (subagents/*.js) ----
        case '_codeflower/subagents/list':
          respond({ subagents: await subagentsOf(requireOwnSession()) });
          break;
        // A subagent's chat, opened in a window: what its transcript holds so
        // far, and from now on its updates and requests, as an attach.
        case '_codeflower/subagents/open': {
          const key = requireOwnSession();
          if (!self.subagents) throw new InvalidRequest('This window does not show subagents');
          const host = agentHost;
          const childId = liveSubagent(host, key);
          const recordedParent = sessionsDirectory ? await parentKeyOf(sessionsDirectory, key) : undefined;
          if (childId === undefined && !recordedParent) throw new InvalidRequest('Not a subagent of a chat on this worker');
          while (recorder?.busy) await recorder.idle();
          const summary = childId !== undefined ? publicSubagent(host.subagents.summary(childId)) : undefined;
          if (childId !== undefined) self.sessions.add(childId);
          respond({
            key,
            parentKey: summary?.parentKey ?? recordedParent,
            live: childId !== undefined,
            ...(childId !== undefined ? { sessionId: childId, transcriptEntries: recorder?.entryCount(childId) ?? 0, subagent: summary } : {})
          });
          if (childId !== undefined) {
            deliverWaiting(host, self, childId);
            await subagentAdapter.attach?.(childId, { request: (method, request) => requestAgent(host, method, request) });
          }
          break;
        }
        case '_codeflower/subagents/close': {
          const childId = liveSubagent(agentHost, requireOwnSession());
          if (childId !== undefined) self.sessions.delete(childId);
          respond({});
          break;
        }
        case '_codeflower/subagents/cancel': {
          const host = agentHost;
          const childId = liveSubagent(host, requireOwnSession());
          if (childId === undefined) throw new InvalidRequest('The subagent is not running here');
          const cancel = subagentAdapter.cancel?.(childId, host.subagents.summary(childId));
          if (!cancel) throw new InvalidRequest(`${agent.label ?? agentName} cannot stop this subagent`);
          writeToAgent(host, { jsonrpc: '2.0', ...cancel });
          respond({});
          break;
        }
        case '_codeflower/subagents/settings': {
          if (!subagentSettings) throw new InvalidRequest(`${agent.label ?? agentName} has no subagents in code flower`);
          if (params.settings !== undefined) {
            await subagentSettings.set(params.settings);
            notify({ jsonrpc: '2.0', method: '_codeflower/subagents/settingsChanged', params: subagentSettingsState() });
          }
          respond(subagentSettingsState());
          break;
        }
        case '_codeflower/agent/restart': {
          // Ends the agent; the window's next connection starts a fresh one.
          const host = agentHost;
          if (host && activity.running) throw new InvalidRequest('Chats are still working; stop them before restarting the agent');
          respond({});
          if (host) {
            host.retiring = true;
            endChild(host.child);
          }
          break;
        }
        default:
          return false;
      }
      return true;
    };

    // ---- what the worker asks of it ----

    // A host whose sign-in methods are known, for a sign-in from a window that
    // did not initialize the agent itself (the worker's own).
    const signInHost = async () => {
      const host = await ensureAgent();
      await ensureInitialized(host);
      return host;
    };

    const signedIn = async () => (agent.signedIn ? agent.signedIn() : true);
    const capabilities = () => ({
      plugins: Boolean(plugins?.available),
      // The agent's own terminal UI on chats (`_codeflower/terminal/start` kind "chat").
      chatTerminals: Boolean(agent.tuiCommand && Array.isArray(ptyHelper) && ptyHelper.length),
      // What the agent tells of its subagents, and which of their settings it takes.
      ...(subagentAdapter ? { subagents: subagentAdapter.features } : {})
    });

    // The agent as the windows show it (_codeflower/agents): name, color and
    // logo, whether it can run here, its sign-in, and whether it runs.
    const describeAgent = async () => {
      const signed = await signedIn().catch(() => false);
      return {
        id: agentName,
        name: agent.label ?? agentName,
        ...agent.presentation,
        ...(agent.unavailable ? { unavailable: agent.unavailable } : {}),
        signedIn: signed,
        credentials: agent.setCredentials ? 'keys' : 'agent',
        running: Boolean(agentHost),
        // What the running agent takes only when it starts again: keys, or
        // subagent settings it reads at start.
        restartPending:
          Boolean(agentHost) &&
          ((agentHost.withoutKeys && signed) || JSON.stringify(subagentEffects().env) !== JSON.stringify(startedSubagentEnv)),
        capabilities: capabilities()
      };
    };

    // What _codeflower/status says of the agent, on its windows.
    const statusFields = async () => ({
      agent: agentName,
      agentLabel: agent.label ?? agentName,
      ...(agent.presentation ? { agentInfo: agent.presentation } : {}),
      signedIn: await signedIn(),
      credentials: agent.setCredentials ? 'keys' : 'agent',
      capabilities: capabilities()
    });

    return {
      name: agentName,
      agent,
      clients,
      get host() {
        return agentHost;
      },
      connect,
      handleClientMessage,
      control,
      describe: describeAgent,
      statusFields,
      // Its account and totals, without the chats'.
      account() {
        const { sessions: _, ...account } = usageSnapshot();
        return account;
      },
      flush: () => recorder?.flush(),
      // The chats with a turn running or a request waiting, for a wrap-up.
      wrapUpCandidates: () => (agentHost ? [...new Set(activity.snapshot().chats.map((chat) => chat.sessionId))] : []),
      wrapUp: (sessionId, notice, template) => (agentHost ? wrapUpChat(agentHost, sessionId, notice, template) : Promise.resolve()),
      fromHook,
      startInitialSession,
      async close() {
        stopPluginNotices?.();
        clearTimeout(usageTimer);
        clearTimeout(limitsTimer);
        if (saveTimer) {
          clearTimeout(saveTimer);
          await saveUsage();
        }
        await limitsReading;
        const host = agentHost ?? (await agentStarting?.catch(() => undefined));
        if (host) {
          endChild(host.child);
          await host.done;
        }
        await recorder?.closeAll();
      }
    };
  }

  // ---- windows ----

  const attachClient = (webSocket) => {
    const target = {
      webSocket,
      // For the log: which window this is.
      id: nextClient++,
      agent: undefined,
      // The chats this window opened; it gets their updates and requests.
      sessions: new Set(),
      // Permission requests and questions already sent to it.
      delivered: new Set(),
      terminals: new Map(),
      queue: Promise.resolve(),
      alive: true,
      send(message) {
        if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
      },
      sendFrame(frame) {
        if (webSocket.readyState !== WebSocket.OPEN) return;
        if (webSocket.bufferedAmount + Buffer.byteLength(frame) > MAX_PAYLOAD) {
          log('ACP WebSocket client is not keeping up with the agent');
          target.close(1009, 'ACP client is not keeping up');
          return;
        }
        webSocket.send(frame);
      },
      close(code, reason) {
        if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
          webSocket.close(code, reason);
        }
      }
    };
    return target;
  };

  sockets.on('connection', (webSocket, request, runtime) => {
    // Windows attach side by side, e.g. VS Code and the app's page.
    const self = attachClient(webSocket);
    self.agentName = runtime?.name;
    clients.add(self);
    runtime?.clients.add(self);
    // The app's page comes through the app, so its address is the app's.
    const from = request?.socket?.remoteAddress ?? 'unknown address';
    const userAgent = typeof request?.headers?.['user-agent'] === 'string' ? ` (${request.headers['user-agent'].slice(0, 200)})` : '';
    log(`Client ${self.id} connected from ${from}${userAgent} to ${runtime ? runtime.name : 'the worker'}; ${clients.size} connected`);

    let released = false;
    const release = (code, reason) => {
      if (released) return;
      released = true;
      for (const terminal of self.terminals.values()) terminal.kill('SIGTERM');
      self.terminals.clear();
      // The chats' terminals keep running without it.
      chatTerminals.detachClient(self);
      void uploads.release(self);
      void downloads.release(self);
      clients.delete(self);
      runtime?.clients.delete(self);
      const why = [code, reason?.toString().trim()].filter(Boolean).join(' ');
      log(`Client ${self.id} disconnected${why ? ` (${why})` : ''}; ${clients.size} connected`);
    };

    if (runtime) self.queue = self.queue.then(() => runtime.connect(self));

    webSocket.on('pong', () => {
      self.alive = true;
    });

    webSocket.on('message', (data, isBinary) => {
      if (isBinary) {
        self.close(1003, 'ACP messages must be text');
        return;
      }

      const frame = data.toString();
      if (frame.includes('\n') || frame.includes('\r')) {
        self.close(1007, 'Each WebSocket frame must contain one compact JSON object');
        return;
      }

      let message;
      try {
        message = JSON.parse(frame);
        if (!protocolObject(message)) throw new Error('ACP frame must be a JSON object');
      } catch {
        self.close(1007, 'Invalid ACP JSON object');
        return;
      }

      if (typeof message.method === 'string' && message.method.startsWith(CONTROL_PREFIX)) {
        if (message.id === undefined) return;
        // Control requests do not wait behind agent traffic, so a terminal
        // stays responsive while the agent is busy.
        void handleControl(self, message);
        return;
      }
      if (!runtime) {
        // The worker's own window speaks to no agent.
        if (message.id !== undefined) {
          self.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `${String(message.method)} is for an agent: connect with ${CONNECTION_PATH}?agent=NAME` }
          });
        }
        return;
      }
      self.queue = self.queue.then(() => runtime.handleClientMessage(self, message));
    });

    // The agent keeps working when the window goes.
    webSocket.once('close', release);
    webSocket.once('error', (error) => {
      log(`WebSocket transport error: ${error.message}`);
      release();
    });
  });

  // ---- the worker's requests (`_codeflower/*`) ----

  // What is the worker's is answered here; the rest goes to the agent of the
  // window, of the chat's key, or named by `agent`.
  const handleControl = async (self, message) => {
    const params = protocolObject(message.params) ? message.params : {};
    const respond = (result) => self.send({ jsonrpc: '2.0', id: message.id, result });
    const own = self.agentName !== undefined ? runtimes.get(self.agentName) : undefined;
    try {
      switch (message.method) {
        case '_codeflower/status': {
          const fields = own ? await own.statusFields() : {};
          respond({
            ...(await describe()),
            ...(Number.isFinite(allocationEnd) ? { allocationEnd: new Date(allocationEnd).toISOString() } : {}),
            instanceId,
            ...fields,
            capabilities: {
              ...fields.capabilities,
              // The user's shells (`_codeflower/terminal/start` kind "shell").
              shellTerminals: Boolean(Array.isArray(ptyHelper) && ptyHelper.length)
            },
            agents: await describeAgents(),
            // What an agent's window hears in `initialize`, for the worker's own: sending files both ways.
            files: { upload: { ...uploads.capability, folders: true }, download: downloads.capability },
            ...(slurmJobId ? { slurmJobId } : {})
          });
          break;
        }
        case '_codeflower/agents':
          respond({ agents: await describeAgents() });
          break;
        case '_codeflower/actions/list':
          respond({ actions });
          break;
        case '_codeflower/activity':
          respond(activitySnapshot());
          break;
        case '_codeflower/sessions/list':
          respond({ sessions: await allSessions() });
          break;
        case '_codeflower/terminal/input': {
          if (typeof params.data !== 'string' || params.data.length > MAX_TERMINAL_INPUT) {
            throw new InvalidRequest('Terminal input must be a string');
          }
          const terminal = self.terminals.get(params.terminalId);
          if (terminal) {
            terminal.stdin.write(params.data);
          } else {
            const chat = chatTerminals.byId(params.terminalId);
            if (!chat) throw new InvalidRequest('Unknown terminal');
            chatTerminals.input(chat, self, params.data);
          }
          respond({});
          break;
        }
        case '_codeflower/terminal/close':
          if (self.terminals.has(params.terminalId)) {
            self.terminals.get(params.terminalId).kill('SIGTERM');
          } else {
            const chat = chatTerminals.byId(params.terminalId);
            if (chat) await chatTerminals.close(chat);
          }
          respond({});
          break;
        // A chat's terminal: watch it (again), follow the window's size, stop watching.
        case '_codeflower/terminal/attach': {
          const chat = chatTerminals.byId(params.terminalId);
          if (!chat) throw new InvalidRequest('Unknown terminal');
          rememberLinkBase(chat, params.linkBase);
          chatTerminals.attach(chat, self, { size: terminalSize(params), watch: params.watch === true });
          respond({ terminalId: chat.id, sessionKey: chat.key, sessionId: chat.sessionId });
          break;
        }
        case '_codeflower/terminal/resize': {
          const chat = chatTerminals.byId(params.terminalId);
          if (!chat) throw new InvalidRequest('Unknown terminal');
          chatTerminals.resize(chat, self, terminalSize(params, chat));
          respond({});
          break;
        }
        case '_codeflower/terminal/detach': {
          const chat = chatTerminals.byId(params.terminalId);
          if (chat) chatTerminals.detach(chat, self);
          respond({});
          break;
        }
        case '_codeflower/terminal/list':
          respond({ terminals: chatTerminals.list() });
          break;
        case '_codeflower/shell/cancel':
          shells.get(params.runId)?.stop();
          respond({});
          break;
        case '_codeflower/files/read':
          respond(await readClientFile(params.path, fileOptions));
          break;
        case '_codeflower/files/thumbnail':
          respond(await thumbnails.thumbnail(params.path, params.height));
          break;
        case '_codeflower/files/stat':
          respond(await resolveFile(params.path, fileOptions));
          break;
        case '_codeflower/files/list':
          respond(await listDirectory(params.path, fileOptions));
          break;
        case '_codeflower/files/upload':
          respond(await uploads.handle(params, self));
          break;
        case '_codeflower/files/exists':
          respond(await uploads.exists(params));
          break;
        case '_codeflower/files/download':
          respond(await downloads.handle(params, self));
          break;
        case '_codeflower/files/write':
          respond(await writeClientFile(params.path, params.text, params.expectedMtimeMs, fileOptions));
          break;
        case '_codeflower/reports/comments':
          respond(await saveReportComments(params.path, params.comments, fileOptions));
          break;
        default: {
          if (message.method === '_codeflower/terminal/start' && params.kind === 'shell') {
            respond(startShellTerminal(params, self));
            break;
          }
          const runtime = runtimeOfKey(params.key ?? params.sessionKey) ?? own ?? runtimes.get(params.agent);
          if (!runtime) {
            throw new InvalidRequest(
              params.agent !== undefined
                ? `This sandbox has no agent ${String(params.agent)}`
                : `${message.method} is an agent's: send it on the agent's connection, or name the agent`
            );
          }
          if (!(await runtime.control(self, message, params, respond))) {
            self.send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` }
            });
          }
        }
      }
    } catch (error) {
      self.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: error.message, ...(error instanceof InvalidRequest && error.data ? { data: error.data } : {}) }
      });
    }
  };

  for (const [name, agent] of Object.entries(agents)) runtimes.set(name, await createRuntime(name, agent, plugins[name]));

  const pings = setInterval(() => {
    for (const target of clients) {
      if (!target.alive) {
        target.webSocket.terminate();
        continue;
      }
      target.alive = false;
      target.webSocket.ping();
    }
  }, PING_MS);
  pings.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    const ready = () => {
      server.off('error', reject);
      resolve();
    };
    if (listenSocket) server.listen(listenSocket, ready);
    else server.listen(port, host, ready);
  });

  // Files to look at, for a window to open and note in the chat (its Shown tab).
  function sendShow(target, files, { title, message, sessionId } = {}) {
    target.send({
      jsonrpc: '2.0',
      method: '_codeflower/show',
      params: {
        files,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(typeof title === 'string' ? { title: title.slice(0, 200) } : {}),
        ...(typeof message === 'string' ? { message: message.slice(0, 2000) } : {})
      }
    });
  }

  // The agent asks the user to look at files; the client opens them.
  let showServer;
  try {
    showServer = await startShowServer(showSocket, async (request) => {
      const paths = Array.isArray(request?.paths) ? request.paths : [];
      if (!paths.length) throw new InvalidRequest('No files to show');
      const cwd = typeof request.cwd === 'string' ? request.cwd : workspace;
      const files = [];
      for (const path of paths.slice(0, 20)) files.push(await resolveFile(path, { ...fileOptions, cwd }));
      // Links for the user's browser, from a terminal attached here
      // (`codeflower attach`): the agent's tool prints them, which its
      // terminal UI shows. `codeflower-open` asks for the links only.
      const links = fileLinks(files);
      if (request.linkOnly === true) {
        if (!links.length) return { error: 'No terminal with links is attached to this worker (codeflower attach); the files are in the sandbox' };
        return { links };
      }
      if (links.length) {
        chatTerminals.notifyViewers('_codeflower/terminal/show', {
          files: links,
          ...(typeof request.title === 'string' ? { title: request.title.slice(0, 200) } : {}),
          ...(typeof request.message === 'string' ? { message: request.message.slice(0, 2000) } : {})
        });
      }
      // One window opens them: the one that sent the latest prompt, else the newest.
      const target = clients.has(lastPrompter) ? lastPrompter : newestClient();
      if (!target) {
        if (links.length) return { shown: [], links };
        return { error: 'No window is connected to this worker, so nobody can see the files now' };
      }
      sendShow(target, files, request);
      return { shown: files.map((file) => file.path), ...(links.length ? { links } : {}) };
    });
  } catch (error) {
    log(`codeflower-show is unavailable: ${error.message}`);
  }

  // Claude Code's hooks, for chats handed over to its terminal UI.
  let hookServer;
  if ([...runtimes.values()].some((runtime) => runtime.agent.handoff)) {
    try {
      hookServer = await startShowServer(hookSocket, async (event) => {
        for (const runtime of runtimes.values()) runtime.fromHook(event);
        return {};
      });
    } catch (error) {
      log(`The terminal UI's hooks are unavailable: ${error.message}`);
    }
  }

  const address = listenSocket ? { port } : server.address();
  if (!address || typeof address === 'string' || !address.port) {
    clearInterval(pings);
    await new Promise((resolve) => server.close(resolve));
    throw new Error('WebSocket server did not bind to a TCP port');
  }

  const metadata = {
    id: instanceId,
    host: advertiseHost,
    port: address.port,
    path: CONNECTION_PATH,
    transport: 'websocket',
    token,
    pid: appPid,
    started_at: new Date().toISOString(),
    ...(initialPrompt !== undefined ? { initialPrompt: true } : {}),
    ...(slurmJobId ? { slurm_job_id: slurmJobId } : {})
  };
  if (fingerprint) metadata.fingerprint = fingerprint;
  metadata.url = connectionUrl(metadata.host, metadata.port, token, fingerprint);
  listening = metadata;

  try {
    await writeConnectionFile(connectionFile, metadata);
  } catch (error) {
    clearInterval(pings);
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  scheduleWrapUp();

  if (initialPrompt !== undefined) {
    void runtimes.get(promptAgent).startInitialSession().catch((error) => {
      if (!closing) log(`Could not start the initial task session: ${error.message}`);
    });
  }

  return {
    address: metadata,
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(pings);
      clearTimeout(wrapUpTimer);
      clearTimeout(agentsTimer);
      for (const target of clients) target.close(1001, 'Server shutting down');
      for (const shell of shells.values()) shell.stop();
      await chatTerminals.closeAll();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
      await new Promise((resolve) => server.close(resolve));
      sockets.close();
      await showServer?.close();
      await hookServer?.close();
      await uploads.close();
      await downloads.close();
      await unlink(connectionFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };
}
