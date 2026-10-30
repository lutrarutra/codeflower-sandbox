import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';
import { createActivity } from './activity.js';
import { CREDENTIAL_VARIABLES, InvalidRequest, terminalAuthCommand } from './agents.js';
import { readCodexLimits } from './codex-limits.js';
import { listDirectory, readClientFile, resolveFile, saveReportComments, startShowServer } from './files.js';
import {
  LeaseError,
  createSessionStore,
  deleteSession,
  listSessions,
  readTranscript,
  renameSession,
  sessionKey,
  writeJsonAtomically
} from './sessions.js';
import { createUsage, dshTokens } from './usage.js';

const CONNECTION_PATH = '/acp';
const STATUS_PATH = '/status';
// A window that misses two pings in a row is gone, e.g. a laptop that went to sleep.
const PING_MS = 30_000;
const TAKEN_OVER = 4001;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const CONTROL_PREFIX = '_codeflower/';
const LEASE_CONFLICT = -32010;
const MAX_TERMINAL_INPUT = 64 * 1024;
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
// setTimeout waits at most about 24 days; longer waits are made of several.
const MAX_TIMER_MS = 2 ** 31 - 1;
const SESSION_STARTS = ['session/new', 'session/resume', 'session/load'];

/** The line users paste into VS Code; the token travels in it like Jupyter's. */
export function connectionUrl(host, port, token) {
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `codeflower://${address}:${port}?token=${encodeURIComponent(token)}`;
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
  delete result.CODEFLOWER_CONNECTION_FILE;
  delete result.CODEFLOWER_LISTEN_HOST;
  delete result.CODEFLOWER_ADVERTISE_HOST;
  delete result.CODEFLOWER_PORT;
  delete result.CODEFLOWER_LISTEN_SOCKET;
  delete result.CODEFLOWER_EGRESS_SOCKET;
  delete result.CODEFLOWER_LAUNCHER_PID;
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
    // A network-isolated sandbox listens on a Unix socket the launcher
    // forwards to; port is then the launcher's.
    listenSocket,
    advertiseHost = host,
    token,
    connectionFile,
    launcherPid = process.pid,
    instanceId = randomUUID(),
    slurmJobId,
    agentName,
    agent,
    initialPrompt,
    sessionsDirectory,
    // When the batch job ends (ms since the epoch), and what chats with a turn
    // running are told some minutes before ({{end}}, {{minutes}}).
    allocationEnd,
    wrapUpTemplate,
    wrapUpLeadMs = WRAP_UP_LEAD_MS,
    describe = async () => ({}),
    ptyHelper,
    environment: workerEnvironment = process.env,
    workspace = workerEnvironment.CODEFLOWER_WORKSPACE ?? process.cwd(),
    // `codeflower-show` reaches the bridge here; a local path, as sockets on
    // network filesystems do not work.
    showSocket = join(tmpdir(), `codeflower-show-${instanceId}.sock`),
    // The project state: only its workspace may be shown or read.
    privateDirectory = sessionsDirectory ? dirname(sessionsDirectory) : undefined,
    log = (message) => process.stderr.write(`${message}\n`)
  } = options;

  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error('CODEFLOWER_TOKEN must contain at least 32 bytes');
  }
    // Read-write mounts (/data/output/NAME, /data/code/NAME), where reports may also take comments.
    writableFolders = [],
  if (!connectionFile) {
    throw new Error('CODEFLOWER_CONNECTION_FILE is required');
  }
  if (typeof agentName !== 'string' || !agent || typeof agent.command !== 'function') {
    throw new Error('An agent is required');
  }
  if (initialPrompt !== undefined && (typeof initialPrompt !== 'string' || !initialPrompt.trim())) {
    throw new Error('The initial prompt must be a non-empty string');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('CODEFLOWER_PORT must be an integer between 0 and 65535');
  }

  const environment = { ...workerEnvironment, CODEFLOWER_SHOW_SOCKET: showSocket };
  const fileOptions = { workspace, privateDirectory, writableFolders };

  // One store and recorder for the worker: sessions stay open, and their
  // leases fresh, while no window is connected.
  const store = sessionsDirectory
    ? createSessionStore({ directory: sessionsDirectory, instanceId, harness: agentName, log })
    : undefined;
  const recorder = store ? createRecorder(store, log) : undefined;

  // The agent runs from the first connection until the worker stops; VS Code
  // windows attach to it one at a time and may come and go.
  let agentHost;
  let agentStarting;
  let client;
  let closing = false;
  const shells = new Map();

  const sendToClient = (message) => client?.send(message);
  const activity = createActivity(() =>
    sendToClient({ jsonrpc: '2.0', method: '_codeflower/activity', params: activitySnapshot() })
  );

  function activitySnapshot() {
    const { chats, working, waiting } = activity.snapshot();
    return {
      chats: chats.map(({ sessionId, ...chat }) => ({ key: sessionKey(agentName, sessionId), ...chat })),
      working,
      waiting
    };
  }

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
        sendToClient({ jsonrpc: '2.0', method: '_codeflower/usage', params: usageSnapshot() });
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

  // Codex's limits, from a separate app-server: after turns, at most once a
  // minute, with the last turn's read made when the minute is over.
  let limitsReading;
  let limitsReadAt = 0;
  let limitsTimer;
  const refreshLimits = () => {
    if (!agent.limitsCommand || usage.authKind === 'api_key' || limitsReading || closing) return;
    const wait = limitsReadAt + LIMITS_INTERVAL_MS - Date.now();
    if (wait > 0) {
      limitsTimer ??= setTimeout(() => {
        limitsTimer = undefined;
        refreshLimits();
      }, wait);
      return;
    }
    limitsReadAt = Date.now();
    limitsReading = readCodexLimits(agent.limitsCommand(), agentEnvironment(environment, agent.env))
      .then((response) => usage.codexRateLimits(response))
      .catch((error) => log(`Could not read Codex's rate limits: ${error.message}`))
      .finally(() => {
        limitsReading = undefined;
      });
  };

  async function statusSnapshot() {
    const snapshot = activitySnapshot();
    // The worker's account and totals; per chat only in the window.
    const { sessions: _, ...account } = usageSnapshot();
    const titles = new Map();
    if (snapshot.chats.length && sessionsDirectory) {
      await recorder?.flush();
      for (const session of await listSessions(sessionsDirectory).catch(() => [])) titles.set(session.key, session.title);
    }
    return {
      agent: agentName,
      agentLabel: agent.label ?? agentName,
      connected: Boolean(client),
      running: Boolean(agentHost),
      working: snapshot.working,
      waiting: snapshot.waiting,
      chats: snapshot.chats.map((chat) => ({ ...chat, title: titles.get(chat.key) ?? 'Untitled session' })),
      usage: account
    };
  }

  const bearer = (request) => {
    const authorization = request.headers.authorization;
    return typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
  };

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {}
    // What the launcher shows about the worker: counts and chat titles only.
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
    response.writeHead(404, { connection: 'close' });
    response.end();
  });

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    if (pathname !== CONNECTION_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!constantTimeTokenMatch(bearer(request), token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (closing) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit('connection', webSocket, request);
    });
  });

  // ---- the agent ----

  const childRunning = (child) => child.exitCode === null && child.signalCode === null;

  const startAgent = async () => {
    const command = await agent.command();
    // dsh's usage plugin reports token counts on a pipe of their own.
    const usageFd = agent.usageFd;
    const child = spawn(command[0], command.slice(1), {
      env: agentEnvironment(environment, { ...agent.env, ...(usageFd ? { CODEFLOWER_USAGE_FD: String(usageFd) } : {}) }),
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
      // Permission requests and questions nobody answered yet.
      waiting: new Map(),
      // Each loaded session's modes and settings, for windows that reattach.
      sessions: new Map(),
      // Requests the bridge answered itself (the wrap-up cancels them); the
      // window's late answers are dropped.
      answered: new Set(),
      retiring: false
    };
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer) > MAX_PAYLOAD && !stdoutBuffer.includes('\n')) {
        log('ACP child wrote an oversized stdio frame');
        client?.close(1009, 'ACP frame from agent is too large');
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
          client?.close(1011, 'Invalid ACP frame from agent');
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
      if (client?.agent === started) client.close(1011, 'Could not start agent');
    });
    child.stdin.on('error', (error) => {
      log(`Could not write to ${agentName}: ${error.message}`);
      if (client?.agent === started) client.close(1011, 'Could not write to agent');
    });
    child.once('close', (code, signal) => {
      if (stdoutBuffer.trim()) log('ACP child exited with an incomplete stdio frame');
      if (code !== 0 && code !== null) log(`${agentName} exited with status ${code}`);
      else if (signal) log(`${agentName} exited on signal ${signal}`);
      for (const request of started.requests.values()) {
        request.reject?.(new Error(`${agentName} exited before answering ${request.method}`));
      }
      started.requests.clear();
      if (agentHost === started) {
        agentHost = undefined;
        activity.clear();
        void recorder?.closeAll();
      }
      if (client?.agent === started) client.close(1011, 'Agent process ended');
    });
    return started;
  };

  const ensureAgent = async () => {
    if (agentHost?.retiring) await agentHost.done;
    if (agentHost) return agentHost;
    agentStarting ??= startAgent()
      .then((started) => (agentHost = started))
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
      const request = { client: null, id, key, method, params, resolve, reject };
      if (method === 'initialize') {
        host.initialized = new Promise((initialize) => {
          request.initialized = initialize;
        });
      }
      host.requests.set(key, request);
      if (method === 'session/prompt' && typeof params.sessionId === 'string') {
        activity.turnStarted(key, params.sessionId);
      }
      writeToAgent(host, withSessionMeta({ jsonrpc: '2.0', id, method, params }));
    });

  const startInitialSession = async () => {
    const host = await ensureAgent();
    if (host.initialized) {
      if (!(await host.initialized)) throw new Error('The agent could not be initialized');
    } else {
      await requestAgent(host, 'initialize', {
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
    }
    const session = await requestAgent(host, 'session/new', { cwd: workspace, mcpServers: [] });
    if (typeof session?.sessionId !== 'string') {
      throw new Error('The agent did not return a session id');
    }
    await requestAgent(host, 'session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: initialPrompt.trim() }]
    });
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
      () => (wait > MAX_TIMER_MS ? scheduleWrapUp() : void wrapUpChats().catch((error) => log(`Could not wrap up: ${error.message}`))),
      Math.min(Math.max(0, wait), MAX_TIMER_MS)
    );
    wrapUpTimer.unref();
  };

  const wrapUpNotice = () => {
    const minutes = Math.max(0, Math.round((allocationEnd - Date.now()) / 60_000));
    return { end: new Date(allocationEnd).toISOString(), minutes };
  };

  const wrapUpChats = async () => {
    const host = agentHost;
    const sessionIds = host && !closing ? [...new Set(activity.snapshot().chats.map((chat) => chat.sessionId))] : [];
    const notice = wrapUpNotice();
    log(`The job ends at ${notice.end}; asking ${sessionIds.length} working chat(s) to wrap up`);
    sendToClient({ jsonrpc: '2.0', method: '_codeflower/wrapUp', params: { ...notice, chats: sessionIds.length } });
    await Promise.all(sessionIds.map((sessionId) => wrapUpChat(host, sessionId)));
  };

  const wrapUpChat = async (host, sessionId) => {
    // As a client cancels: the turn, then the requests it waits on.
    writeToAgent(host, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    for (const [key, { message, sessionId: owner }] of host.waiting) {
      if (owner !== sessionId) continue;
      host.waiting.delete(key);
      host.answered.add(key);
      activity.answered(key);
      const result = message.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' };
      writeToAgent(host, { jsonrpc: '2.0', id: message.id, result });
    }
    const deadline = Date.now() + WRAP_UP_CANCEL_MS;
    while (activity.busy(sessionId) && Date.now() < deadline && !closing) await new Promise((resolve) => setTimeout(resolve, 200));
    if (closing || agentHost !== host) return;
    if (activity.busy(sessionId)) {
      log(`A chat did not stop within ${WRAP_UP_CANCEL_MS / 1000} s; it was not asked to wrap up`);
      return;
    }
    const notice = wrapUpNotice();
    const text = wrapUpTemplate.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => String(notice[name] ?? placeholder)).trim();
    // The window shows the prompt, as it did not send it.
    sendToClient({
      jsonrpc: '2.0',
      method: '_codeflower/wrapUp',
      params: { ...notice, key: sessionKey(agentName, sessionId), prompt: text }
    });
    await requestAgent(host, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).catch((error) =>
      log(`A chat could not wrap up: ${error.message}`)
    );
  };

  // A permission request or question goes to the window once, after it has
  // opened that chat.
  const deliver = (target, key, message) => {
    if (target.delivered.has(key)) return;
    target.delivered.add(key);
    target.send(message);
  };

  // On attach: the requests are in the transcript the window loads, so they
  // are marked to be asked, not added to the chat again.
  const deliverWaiting = (host, target, sessionId) => {
    for (const [key, { message, sessionId: owner }] of host.waiting) {
      if (owner !== sessionId) continue;
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
    if (target !== client || !host.sessions.has(sessionId)) {
      target.send({ jsonrpc: '2.0', id, result });
      return;
    }
    target.sessions.add(sessionId);
    target.send({
      jsonrpc: '2.0',
      id,
      result: {
        ...result,
        _meta: {
          ...(protocolObject(result._meta) ? result._meta : {}),
          'codeflower/transcriptEntries': recorder?.entryCount(sessionId) ?? 0,
          'codeflower/busy': activity.busy(sessionId)
        }
      }
    });
    deliverWaiting(host, target, sessionId);
  };

  const rememberSession = (host, sessionId, result) => {
    const { sessionId: _, _meta, ...state } = result;
    host.sessions.set(sessionId, structuredClone(state));
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
  };

  // The agent answered a client request.
  const settleRequest = (host, request, message) => {
    const { method, params, key } = request;
    if (method === 'session/prompt') activity.turnEnded(key);
    const result = message.result;
    if (method === 'initialize') {
      // Remember the sign-in methods the agent offers, so terminal sign-ins
      // can only run commands the agent itself announced.
      if (!message.error) host.authMethods = Array.isArray(result?.authMethods) ? result.authMethods : [];
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
        rememberSession(host, sessionId, result);
        // The session's totals start from those its transcript recorded.
        void (recorder?.isOpen(sessionId) ?? Promise.resolve()).then(() =>
          usage.opened(sessionId, store?.storedUsage(sessionId))
        );
        if (request.client === client) void attachSession(host, request.client, request.id, sessionId, result);
        return true;
      case 'session/set_config_option':
        if (state && Array.isArray(result.configOptions)) state.configOptions = result.configOptions;
        break;
      case 'session/set_mode':
        if (state?.modes) state.modes.currentModeId = params.modeId;
        break;
      case 'session/set_model':
      case 'session/unstable_setSessionModel':
        if (state?.models) state.models.currentModelId = params.modelId;
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
      const turn = request.method === 'session/prompt' ? endTurn(request, message) : undefined;
      recorder?.fromAgent(message, turn);
      // Attaches answer once the recorder caught up.
      const attached = settleRequest(host, request, message);
      if (message.error) request.reject?.(new Error(message.error.message ?? `${request.method} failed`));
      else request.resolve?.(message.result);
      if (attached) return;
      if (request.client === client) client.send({ ...message, id: request.id });
      return;
    }
    recorder?.fromAgent(message);
    const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined;

    if (message.method === 'session/update') {
      const update = message.params?.update;
      trackSettings(host, sessionId, update);
      if (update?.sessionUpdate === 'tool_call') activity.toolCall(sessionId, update);
      if (update?.sessionUpdate === 'usage_update' && sessionId !== undefined) usage.update(sessionId, update);
      if (sessionId !== undefined && client?.sessions.has(sessionId)) client.sendFrame(frame);
      return;
    }

    if (message.id !== undefined) {
      const key = requestKey(message.id);
      if (message.method === 'session/request_permission' || message.method === 'elicitation/create') {
        // It waits for the user, however long they are away.
        host.waiting.set(key, { message, sessionId });
        if (sessionId !== undefined && message.method === 'session/request_permission') {
          activity.permission(key, sessionId, message.params?.toolCall);
        } else if (sessionId !== undefined && message.params?.mode !== 'url') {
          activity.question(key, sessionId);
        }
        if (client && (sessionId === undefined || client.sessions.has(sessionId))) deliver(client, key, message);
        return;
      }
      if (client) {
        client.sendFrame(frame);
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
    if (message.method === '_auth/status_update') usage.auth(message.params?.authStatus);
    // Claude Code's rate limit events, which the bridge asked for (sessionMeta).
    if (message.method === '_claude/sdkMessage' && message.params?.message?.type === 'rate_limit_event') {
      usage.claudeRateLimit(message.params.message.rate_limit_info);
      return;
    }
    client?.sendFrame(frame);
  };

  // A prompt's answer: what the turn added to the session's usage, which a
  // prompt result without counts (dsh) gets from the bridge.
  const endTurn = (request, message) => {
    const sessionId = request.params?.sessionId;
    if (message.error || typeof sessionId !== 'string' || !protocolObject(message.result)) return undefined;
    const turn = usage.turnEnded(sessionId, message.result);
    if (turn?.usage && !protocolObject(message.result.usage)) message.result.usage = turn.usage;
    refreshLimits();
    return turn;
  };

  // What the bridge asks of every session the agent starts, e.g. Claude Code's
  // rate limit events, next to what the window asked.
  const withSessionMeta = (message) => {
    if (!agent.sessionMeta || !SESSION_STARTS.includes(message.method) || !protocolObject(message.params)) return message;
    const meta = protocolObject(message.params._meta) ? message.params._meta : {};
    const merged = { ...meta };
    for (const [name, value] of Object.entries(agent.sessionMeta)) {
      merged[name] = { ...(protocolObject(meta[name]) ? meta[name] : {}), ...value };
    }
    return { ...message, params: { ...message.params, _meta: merged } };
  };

  // ---- windows ----

  const attachClient = (webSocket) => {
    const target = {
      webSocket,
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

  sockets.on('connection', (webSocket) => {
    // The newest window wins, e.g. the same chats opened from another computer.
    client?.close(TAKEN_OVER, 'Another VS Code window took over');
    const self = attachClient(webSocket);
    client = self;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const terminal of self.terminals.values()) terminal.kill('SIGTERM');
      self.terminals.clear();
      if (client === self) client = undefined;
    };

    const start = async () => {
      let host;
      try {
        host = await ensureAgent();
      } catch (error) {
        log(`Could not prepare ${agentName}: ${error.message}`);
        self.close(1011, 'Could not start agent');
        return;
      }
      self.agent = host;
      // Sign-in links the agent sent while no window was connected.
      for (const [key, { message, sessionId }] of host.waiting) {
        if (sessionId === undefined) deliver(self, key, message);
      }
    };
    self.queue = self.queue.then(start);

    const handleClientMessage = async (message) => {
      const host = self.agent;
      if (!host || !childRunning(host.child) || client !== self) return;

      // An answer to the agent's request: forwarded once, then it stops waiting.
      if (message.method === undefined) {
        if (message.id === undefined) return;
        const key = requestKey(message.id);
        if (host.answered.delete(key)) return;
        if (host.waiting.delete(key)) activity.answered(key);
        writeToAgent(host, message, webSocket);
        return;
      }
      if (message.id === undefined) {
        writeToAgent(host, message, webSocket);
        return;
      }

      const respond = (result) => self.send({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize' && host.initialized) {
        const result = await host.initialized;
        if (result) {
          respond(result);
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
      if (recorder) {
        const refusal = await recorder.admitClientMessage(message);
        if (refusal) {
          self.send(refusal);
          return;
        }
      }

      const bridgeId = `cf-${host.nextRequest++}`;
      const key = requestKey(bridgeId);
      const request = { client: self, id: message.id, key, method: message.method, params: message.params };
      if (message.method === 'initialize') {
        host.initialized = new Promise((resolve) => (request.initialized = resolve));
      }
      host.requests.set(key, request);
      if (message.method === 'session/prompt' && typeof sessionId === 'string') activity.turnStarted(key, sessionId);
      writeToAgent(host, { ...withSessionMeta(message), id: bridgeId }, webSocket);
    };

    // ---- sign-in terminals ----

    const terminalCommand = async (methodId) => {
      const method = (self.agent?.authMethods ?? []).find((candidate) => candidate?.id === methodId);
      if (!method) throw new InvalidRequest(`The agent offers no sign-in method ${String(methodId)}`);
      return terminalAuthCommand(agent, method);
    };

    const startTerminal = async (params) => {
      if (!Array.isArray(ptyHelper) || ptyHelper.length === 0) {
        throw new InvalidRequest('This worker cannot open terminals');
      }
      const command = await terminalCommand(params.methodId);
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
    const runShell = async (params) => {
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
          sendToClient({ jsonrpc: '2.0', method: '_codeflower/shell/output', params: { runId, data } });
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
          resolve(result);
        };
        shell.once('error', (error) => {
          forward(`${error.message}\n`);
          finish(127);
        });
        shell.once('close', (code, signal) => finish(code ?? (signal ? 128 + 15 : 1)));
      });
    };

    // ---- worker-level requests ----

    const sessionKeyAllowed = (key) => typeof key === 'string' && key.startsWith(`${agentName}-`);

    const handleControl = async (message) => {
      const params = protocolObject(message.params) ? message.params : {};
      const respond = (result) => self.send({ jsonrpc: '2.0', id: message.id, result });
      const requireSessions = () => {
        if (!sessionsDirectory) throw new InvalidRequest('This worker does not record sessions');
        return sessionsDirectory;
      };
      const requireOwnSession = () => {
        if (!sessionKeyAllowed(params.key)) throw new InvalidRequest('Invalid session key');
        return params.key;
      };
      try {
        switch (message.method) {
          case '_codeflower/status':
            respond({
              ...(await describe()),
              ...(Number.isFinite(allocationEnd) ? { allocationEnd: new Date(allocationEnd).toISOString() } : {}),
              instanceId,
              agent: agentName,
              agentLabel: agent.label ?? agentName,
              signedIn: agent.signedIn ? await agent.signedIn() : true,
              credentials: agent.setCredentials ? 'keys' : 'agent',
              ...(slurmJobId ? { slurmJobId } : {})
            });
            break;
          case '_codeflower/activity':
            respond(activitySnapshot());
            break;
          case '_codeflower/usage':
            respond(usageSnapshot());
            // Codex's limits, if the last read is old; the notification brings them.
            refreshLimits();
            break;
          case '_codeflower/sessions/list': {
            const sessions = sessionsDirectory ? await listSessions(sessionsDirectory) : [];
            respond({ sessions: sessions.filter((session) => session.harness === agentName) });
            break;
          }
          case '_codeflower/sessions/transcript': {
            const directory = requireSessions();
            const key = requireOwnSession();
            // A chat still running here: everything relayed so far is in the file.
            await recorder?.flush();
            respond({ entries: await readTranscript(directory, key) });
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
              client?.sessions.delete(loaded);
              usage.forget(loaded);
              await recorder?.close(loaded);
            }
            await deleteSession(directory, key);
            respond({});
            break;
          }
          case '_codeflower/terminal/start':
            respond(await startTerminal(params));
            break;
          case '_codeflower/terminal/input': {
            const terminal = self.terminals.get(params.terminalId);
            if (!terminal) throw new InvalidRequest('Unknown terminal');
            if (typeof params.data !== 'string' || params.data.length > MAX_TERMINAL_INPUT) {
              throw new InvalidRequest('Terminal input must be a string');
            }
            terminal.stdin.write(params.data);
            respond({});
            break;
          }
          case '_codeflower/terminal/close':
            self.terminals.get(params.terminalId)?.kill('SIGTERM');
            respond({});
            break;
          case '_codeflower/shell/run':
            // Answered when the command ends; other requests keep flowing meanwhile.
            void runShell(params).then(respond, (error) =>
              self.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } })
            );
            break;
          case '_codeflower/shell/cancel':
            shells.get(params.runId)?.stop();
            respond({});
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
          case '_codeflower/files/read':
            respond(await readClientFile(params.path, fileOptions));
            break;
          case '_codeflower/files/stat':
            respond(await resolveFile(params.path, fileOptions));
            break;
          case '_codeflower/files/list':
            respond(await listDirectory(params.path, fileOptions));
            break;
          case '_codeflower/reports/comments':
            respond(await saveReportComments(params.path, params.comments, fileOptions));
            break;
          case '_codeflower/credentials/set':
            if (!agent.setCredentials) {
              throw new InvalidRequest(`${agent.label ?? agentName} signs in through the agent`);
            }
            await agent.setCredentials(params);
            // The agent reads its keys at start: restart it to apply them.
            respond({ restartRequired: true });
            break;
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
            self.send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` }
            });
        }
      } catch (error) {
        self.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: error instanceof InvalidRequest ? error.message : error.message }
        });
      }
    };

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
        void handleControl(message);
        return;
      }
      self.queue = self.queue.then(() => handleClientMessage(message));
    });

    // The agent keeps working when the window goes.
    webSocket.once('close', release);
    webSocket.once('error', (error) => {
      log(`WebSocket transport error: ${error.message}`);
      release();
    });
  });

  const pings = setInterval(() => {
    if (!client) return;
    if (!client.alive) {
      client.webSocket.terminate();
      return;
    }
    client.alive = false;
    client.webSocket.ping();
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

  // The agent asks the user to look at files; the client opens them.
  let showServer;
  try {
    showServer = await startShowServer(showSocket, async (request) => {
      const paths = Array.isArray(request?.paths) ? request.paths : [];
      if (!paths.length) throw new InvalidRequest('No files to show');
      const cwd = typeof request.cwd === 'string' ? request.cwd : workspace;
      const files = [];
      for (const path of paths.slice(0, 20)) files.push(await resolveFile(path, { ...fileOptions, cwd }));
      if (!client) return { error: 'No VS Code window is connected to this worker, so nobody can see the files now' };
      sendToClient({
        jsonrpc: '2.0',
        method: '_codeflower/show',
        params: {
          files,
          ...(typeof request.title === 'string' ? { title: request.title.slice(0, 200) } : {}),
          ...(typeof request.message === 'string' ? { message: request.message.slice(0, 2000) } : {})
        }
      });
      return { shown: files.map((file) => file.path) };
    });
  } catch (error) {
    log(`codeflower-show is unavailable: ${error.message}`);
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
    pid: launcherPid,
    started_at: new Date().toISOString(),
    agent: agentName,
    ...(initialPrompt !== undefined ? { initialPrompt: true } : {}),
    ...(slurmJobId ? { slurm_job_id: slurmJobId } : {})
  };
  metadata.url = connectionUrl(metadata.host, metadata.port, token);

  try {
    await writeConnectionFile(connectionFile, metadata);
  } catch (error) {
    clearInterval(pings);
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  scheduleWrapUp();

  if (initialPrompt !== undefined) {
    void startInitialSession().catch((error) => {
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
      clearTimeout(usageTimer);
      clearTimeout(limitsTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        await saveUsage();
      }
      await limitsReading;
      client?.close(1001, 'Server shutting down');
      for (const shell of shells.values()) shell.stop();
      const host = agentHost ?? (await agentStarting?.catch(() => undefined));
      if (host) {
        endChild(host.child);
        await host.done;
      }
      await recorder?.closeAll();
      await new Promise((resolve) => server.close(resolve));
      sockets.close();
      await showServer?.close();
      await unlink(connectionFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };
}
