import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { CREDENTIAL_VARIABLES, InvalidRequest } from './agents.js';
import { listDirectory, readClientFile, resolveFile, startShowServer } from './files.js';
import {
  LeaseError,
  createSessionStore,
  deleteSession,
  listSessions,
  readTranscript,
  renameSession
} from './sessions.js';

const CONNECTION_PATH = '/acp';
const MAX_PAYLOAD = 16 * 1024 * 1024;
const CONTROL_PREFIX = '_codeflower/';
const LEASE_CONFLICT = -32010;
const MAX_TERMINAL_INPUT = 64 * 1024;
// Shell commands the user runs from the chat (`!command`).
const MAX_SHELL_COMMAND = 16 * 1024;
const MAX_SHELL_RECORD = 64 * 1024;
const SHELL_TIMEOUT_MS = 15 * 60 * 1000;

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
  for (const name of CREDENTIAL_VARIABLES) {
    delete result[name];
  }
  return { ...result, ...harnessEnvironment };
}

function endChild(child) {
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
function createRecorder(store, log) {
  const clientRequests = new Map();
  const permissionRequests = new Map();
  const questionRequests = new Map();
  let queue = Promise.resolve();

  const run = (task) => {
    queue = queue.then(task).catch((error) => {
      if (error instanceof LeaseError) {
        log(`Session lease conflict: ${error.message}`);
      } else {
        log(`Could not record session: ${error.message}`);
      }
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

    fromAgent(message) {
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
              stopReason: message.result?.stopReason ?? null
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

    async close() {
      await queue;
      await store.closeAll();
    }
  };
}

export async function startBridge(options) {
  const {
    host = '0.0.0.0',
    port = 0,
    advertiseHost = host,
    token,
    connectionFile,
    launcherPid = process.pid,
    instanceId = randomUUID(),
    slurmJobId,
    agentName,
    agent,
    sessionsDirectory,
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
  if (!connectionFile) {
    throw new Error('CODEFLOWER_CONNECTION_FILE is required');
  }
  if (typeof agentName !== 'string' || !agent || typeof agent.command !== 'function') {
    throw new Error('An agent is required');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('CODEFLOWER_PORT must be an integer between 0 and 65535');
  }

  const environment = { ...workerEnvironment, CODEFLOWER_SHOW_SOCKET: showSocket };
  const fileOptions = { workspace, privateDirectory };
  // Sends to the connected client, if any.
  let notifyClient;

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const server = createServer((_, response) => {
    response.writeHead(404, { connection: 'close' });
    response.end();
  });
  let activeChild;
  let activeSocket;
  let activeConnectionDone;
  let closing = false;

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

    const authorization = request.headers.authorization;
    const suppliedToken =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : undefined;
    if (!constantTimeTokenMatch(suppliedToken, token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (closing || activeSocket) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit('connection', webSocket, request);
    });
  });

  sockets.on('connection', (webSocket) => {
    activeSocket = webSocket;
    let child;
    let shuttingDown = false;
    let stdoutBuffer = '';
    let clientQueue = Promise.resolve();
    let authMethods = [];
    const initializeRequests = new Set();
    const terminals = new Map();
    const shells = new Map();
    let finishConnection;
    activeConnectionDone = new Promise((resolve) => {
      finishConnection = resolve;
    });
    const recorder = sessionsDirectory
      ? createRecorder(createSessionStore({ directory: sessionsDirectory, instanceId, harness: agentName, log }), log)
      : undefined;

    const closeSocket = (code, reason) => {
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.close(code, reason);
      }
    };
    const sendToClient = (message) => {
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify(message));
      }
    };
    notifyClient = sendToClient;

    let released = false;
    const releaseConnection = async () => {
      if (released) return;
      released = true;
      for (const terminal of terminals.values()) terminal.kill('SIGTERM');
      terminals.clear();
      for (const shell of shells.values()) shell.stop();
      shells.clear();
      if (recorder) await recorder.close();
      if (activeSocket === webSocket) {
        activeSocket = undefined;
        activeChild = undefined;
        notifyClient = undefined;
      }
      finishConnection();
    };

    const forwardAgentFrame = (frame, message) => {
      // Remember the sign-in methods the agent offers, so terminal sign-ins
      // can only run commands the agent itself announced.
      if (message.id !== undefined && message.method === undefined && initializeRequests.has(requestKey(message.id))) {
        initializeRequests.delete(requestKey(message.id));
        authMethods = Array.isArray(message.result?.authMethods) ? message.result.authMethods : [];
      }
      recorder?.fromAgent(message);
      if (webSocket.readyState === WebSocket.OPEN) {
        if (webSocket.bufferedAmount + Buffer.byteLength(frame) > MAX_PAYLOAD) {
          log('ACP WebSocket client is not keeping up with the agent');
          closeSocket(1009, 'ACP client is not keeping up');
          endChild(child);
          return;
        }
        webSocket.send(frame);
      }
    };

    const startAgent = async () => {
      let command;
      try {
        command = await agent.command();
      } catch (error) {
        log(`Could not prepare ${agentName}: ${error.message}`);
        closeSocket(1011, 'Could not start agent');
        await releaseConnection();
        return;
      }
      if (webSocket.readyState !== WebSocket.OPEN) {
        await releaseConnection();
        return;
      }
      child = spawn(command[0], command.slice(1), {
        env: agentEnvironment(environment, agent.env),
        stdio: ['pipe', 'pipe', 'inherit']
      });
      activeChild = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        if (Buffer.byteLength(stdoutBuffer) > MAX_PAYLOAD && !stdoutBuffer.includes('\n')) {
          log('ACP child wrote an oversized stdio frame');
          closeSocket(1009, 'ACP frame from agent is too large');
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
            closeSocket(1011, 'Invalid ACP frame from agent');
            endChild(child);
            return;
          }
          forwardAgentFrame(frame, message);
        }
      });
      child.once('error', (error) => {
        log(`Could not start ${agentName}: ${error.message}`);
        closeSocket(1011, 'Could not start agent');
      });
      child.stdin.on('error', (error) => {
        log(`Could not write to ${agentName}: ${error.message}`);
        closeSocket(1011, 'Could not write to agent');
      });
      child.once('close', (code, signal) => {
        if (stdoutBuffer.trim()) log('ACP child exited with an incomplete stdio frame');
        if (code !== 0 && code !== null) log(`${agentName} exited with status ${code}`);
        else if (signal) log(`${agentName} exited on signal ${signal}`);
        closeSocket(1011, 'Agent process ended');
        void releaseConnection();
      });
    };

    const writeToChild = (message) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      if (message.method === 'initialize' && message.id !== undefined) {
        initializeRequests.add(requestKey(message.id));
      }
      recorder?.fromClient(message);
      if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
        webSocket.pause();
        child.stdin.once('drain', () => webSocket.resume());
      }
    };

    const handleClientMessage = async (message) => {
      if (recorder) {
        const refusal = await recorder.admitClientMessage(message);
        if (refusal) {
          sendToClient(refusal);
          return;
        }
      }
      writeToChild(message);
    };

    // ---- sign-in terminals ----

    const terminalCommand = async (methodId) => {
      const method = authMethods.find((candidate) => candidate?.id === methodId);
      if (!method) throw new InvalidRequest(`The agent offers no sign-in method ${String(methodId)}`);
      const meta = method._meta?.['terminal-auth'];
      if (meta && typeof meta.command === 'string') {
        return [meta.command, ...(Array.isArray(meta.args) ? meta.args.map(String) : [])];
      }
      if (method.type === 'terminal') {
        return [...(await agent.command()), ...(Array.isArray(method.args) ? method.args.map(String) : [])];
      }
      throw new InvalidRequest(`${methodId} is not a terminal sign-in`);
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
      terminals.set(terminalId, terminal);
      const output = (data) =>
        sendToClient({ jsonrpc: '2.0', method: '_codeflower/terminal/output', params: { terminalId, data } });
      terminal.stdout.setEncoding('utf8');
      terminal.stderr.setEncoding('utf8');
      terminal.stdout.on('data', output);
      terminal.stderr.on('data', output);
      terminal.stdin.on('error', () => {});
      terminal.once('error', (error) => output(`\r\nCould not start the sign-in: ${error.message}\r\n`));
      terminal.once('close', (code, signal) => {
        terminals.delete(terminalId);
        sendToClient({
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
    // client; the command and its (capped) output go into the session record.
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
      const respond = (result) => sendToClient({ jsonrpc: '2.0', id: message.id, result });
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
              instanceId,
              agent: agentName,
              agentLabel: agent.label ?? agentName,
              signedIn: agent.signedIn ? await agent.signedIn() : true,
              credentials: agent.setCredentials ? 'keys' : 'agent',
              ...(slurmJobId ? { slurmJobId } : {})
            });
            break;
          case '_codeflower/sessions/list': {
            const sessions = sessionsDirectory ? await listSessions(sessionsDirectory) : [];
            respond({ sessions: sessions.filter((session) => session.harness === agentName) });
            break;
          }
          case '_codeflower/sessions/transcript':
            respond({ entries: await readTranscript(requireSessions(), requireOwnSession()) });
            break;
          case '_codeflower/sessions/rename':
            await renameSession(requireSessions(), requireOwnSession(), params.title);
            respond({});
            break;
          case '_codeflower/sessions/delete':
            await deleteSession(requireSessions(), requireOwnSession());
            respond({});
            break;
          case '_codeflower/terminal/start':
            respond(await startTerminal(params));
            break;
          case '_codeflower/terminal/input': {
            const terminal = terminals.get(params.terminalId);
            if (!terminal) throw new InvalidRequest('Unknown terminal');
            if (typeof params.data !== 'string' || params.data.length > MAX_TERMINAL_INPUT) {
              throw new InvalidRequest('Terminal input must be a string');
            }
            terminal.stdin.write(params.data);
            respond({});
            break;
          }
          case '_codeflower/terminal/close':
            terminals.get(params.terminalId)?.kill('SIGTERM');
            respond({});
            break;
          case '_codeflower/shell/run':
            // Answered when the command ends; other requests keep flowing meanwhile.
            void runShell(params).then(respond, (error) =>
              sendToClient({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } })
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
          case '_codeflower/credentials/set':
            if (!agent.setCredentials) {
              throw new InvalidRequest(`${agent.label ?? agentName} signs in through the agent`);
            }
            await agent.setCredentials(params);
            // The agent reads its keys at start: reconnect to apply them.
            respond({ restartRequired: true });
            break;
          default:
            sendToClient({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` }
            });
        }
      } catch (error) {
        sendToClient({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: error instanceof InvalidRequest ? error.message : error.message }
        });
      }
    };

    clientQueue = clientQueue.then(startAgent);

    webSocket.on('message', (data, isBinary) => {
      if (isBinary) {
        closeSocket(1003, 'ACP messages must be text');
        return;
      }

      const frame = data.toString();
      if (frame.includes('\n') || frame.includes('\r')) {
        closeSocket(1007, 'Each WebSocket frame must contain one compact JSON object');
        return;
      }

      let message;
      try {
        message = JSON.parse(frame);
        if (!protocolObject(message)) throw new Error('ACP frame must be a JSON object');
      } catch {
        closeSocket(1007, 'Invalid ACP JSON object');
        return;
      }

      if (typeof message.method === 'string' && message.method.startsWith(CONTROL_PREFIX)) {
        if (message.id === undefined) return;
        // Control requests do not wait behind agent traffic, so a terminal
        // stays responsive while the agent is busy.
        void handleControl(message);
        return;
      }
      clientQueue = clientQueue.then(() => handleClientMessage(message));
    });

    const onSocketEnd = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void clientQueue.then(() => {
        if (child && child.exitCode === null && child.signalCode === null) {
          endChild(child);
        } else {
          void releaseConnection();
        }
      });
    };
    webSocket.once('close', onSocketEnd);
    webSocket.once('error', (error) => {
      log(`WebSocket transport error: ${error.message}`);
      onSocketEnd();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
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
      if (!notifyClient) return { error: 'No VS Code window is connected to this worker, so nobody can see the files now' };
      notifyClient({
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

  const address = server.address();
  if (!address || typeof address === 'string') {
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
    ...(slurmJobId ? { slurm_job_id: slurmJobId } : {})
  };
  metadata.url = connectionUrl(metadata.host, metadata.port, token);

  try {
    await writeConnectionFile(connectionFile, metadata);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  return {
    address: metadata,
    async close() {
      if (closing) return;
      closing = true;
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.close(1001, 'Server shutting down');
      }
      if (activeChild) endChild(activeChild);
      if (activeConnectionDone) await activeConnectionDone;
      await new Promise((resolve) => server.close(resolve));
      sockets.close();
      await showServer?.close();
      await unlink(connectionFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };
}
