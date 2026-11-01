import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENT_NAMES, createAgents, PROVIDED_KEY_VARIABLE } from './agents.js';
import { readActions } from './actions.js';
import { MCP_SERVERS_VARIABLE, parseMcpServers } from './mcp.js';
import { PLUGINS_FETCH_VARIABLE, PLUGINS_VARIABLE, createPlugins, parsePlugins, runFetch } from './plugins.js';
import { startEgressForwarder } from './egress.js';
import { PAGE_DIRECTORY } from './page.js';
import { clientLink, connectionUrl, pageLink, startBridge } from './server.js';
import { EXIT_CODES, runTask } from './task.js';

const RUNTIME_MODULES = '/opt/codeflower/runtime/node_modules';
const STATE = '/codeflower-state';
const TEMPLATES = '/opt/codeflower/templates';
const INITIAL_PROMPT_FILE = process.env.CODEFLOWER_INITIAL_PROMPT_FILE;
// `--server`: the worker also serves the chat page on its port.
const SERVE_PAGE = process.env.CODEFLOWER_PAGE === '1';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const agentName = requiredEnvironment('CODEFLOWER_AGENT');
if (!AGENT_NAMES.includes(agentName)) {
  throw new Error(`CODEFLOWER_AGENT must be one of: ${AGENT_NAMES.join(', ')}`);
}
const agents = createAgents({ nodePath: process.execPath, modules: RUNTIME_MODULES });

// The app's config may give the agent an API key. It goes into the
// agent's own files in the project, and leaves this process's environment so
// that nothing started from here inherits it.
const providedKey = process.env[PROVIDED_KEY_VARIABLE];
delete process.env[PROVIDED_KEY_VARIABLE];
if (providedKey) {
  try {
    const kept = await agents[agentName].provideKey?.(providedKey);
    if (kept) process.stderr.write(`The API key from the app's config was not used: ${kept}\n`);
  } catch (error) {
    throw new Error(`Could not store the API key from the app's config: ${error.message}`);
  }
}

// MCP servers from the app's config. Their env and headers may hold secrets,
// so the variable leaves the environment too; the bridge gives them to the
// agent in each session.
let mcpServers;
try {
  mcpServers = parseMcpServers(process.env[MCP_SERVERS_VARIABLE]);
} catch (error) {
  throw new Error(`Could not read the MCP servers from the app's config: ${error.message}`);
}
delete process.env[MCP_SERVERS_VARIABLE];

// The agents' own plugins from the app's config, and whether this is the app's
// fetch run, which fetches them and exits.
let configuredPlugins;
try {
  configuredPlugins = parsePlugins(process.env[PLUGINS_VARIABLE]);
} catch (error) {
  throw new Error(`Could not read the plugins from the app's config: ${error.message}`);
}
delete process.env[PLUGINS_VARIABLE];
const FETCH_PLUGINS = process.env[PLUGINS_FETCH_VARIABLE] === '1';
delete process.env[PLUGINS_FETCH_VARIABLE];

// An agent installed outside the image (Claude Code) says when it is missing.
const missing = await agents[agentName].missing?.();
if (missing) throw new Error(missing);

// The project's plugins/. An isolated sandbox reaches only the providers, so
// its plugins are fetched by the app's fetch run.
const plugins = createPlugins({
  agentName,
  hooks: agents[agentName].plugins,
  descriptor: agents[agentName].pluginsDescriptor,
  directory: join(process.env.CODEFLOWER_SESSIONS_DIR ? dirname(process.env.CODEFLOWER_SESSIONS_DIR) : STATE, 'plugins'),
  configured: configuredPlugins[agentName] ?? [],
  canFetch: FETCH_PLUGINS || !process.env.CODEFLOWER_EGRESS_SOCKET,
  log: (message) => process.stderr.write(`${message}\n`)
});

// What the extension shows about this worker.
// The folders the app mounted, e.g. /data/input/study42, with their host paths.
function mounts() {
  try {
    const value = JSON.parse(process.env.CODEFLOWER_MOUNTS ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function describe() {
  return {
    stateDirectory: process.env.CODEFLOWER_HOST_STATE ?? null,
    engine: process.env.CODEFLOWER_ENGINE ?? 'apptainer',
    mounts: mounts()
  };
}

// A network-isolated sandbox's only way out: the app's proxy.
const egress = process.env.CODEFLOWER_EGRESS_SOCKET
  ? await startEgressForwarder(process.env.CODEFLOWER_EGRESS_SOCKET).catch((error) => {
      process.stderr.write(`The sandbox has no network: ${error.message}\n`);
    })
  : undefined;

// `codeflower plugins fetch` and before a start: the app's fetch run.
if (FETCH_PLUGINS) {
  const errors = await runFetch(plugins);
  egress?.close();
  process.exit(errors ? 1 : 0);
}

// `codeflower task`: the agent works on its task by itself, without VS Code.
if (process.env.CODEFLOWER_TASK_ATTEMPT_FILE) {
  if (INITIAL_PROMPT_FILE) {
    throw new Error('CODEFLOWER_TASK_ATTEMPT_FILE and CODEFLOWER_INITIAL_PROMPT_FILE cannot be used together');
  }
  const aborting = new AbortController();
  const wrapUpController = new AbortController();
  let wrappingUp = false;
  let lastCancelPress = 0;

  process.on('SIGTERM', () => aborting.abort());
  process.on('SIGINT', () => {
    if (!wrappingUp) {
      wrappingUp = true;
      wrapUpController.abort('interrupt');
      process.stderr.write('\nInterrupt received; wrapping up... (press Ctrl+C twice to cancel immediately)\n');
      return;
    }
    const now = Date.now();
    if (lastCancelPress && now - lastCancelPress <= 3000) {
      process.stderr.write('Cancelling...\n');
      aborting.abort();
    } else {
      lastCancelPress = now;
      process.stderr.write('Press Ctrl+C again within 3s to cancel wrap-up\n');
    }
  });

  const result = await runTask({
    agentName,
    agent: agents[agentName],
    attemptFile: process.env.CODEFLOWER_TASK_ATTEMPT_FILE,
    sessionsDirectory: requiredEnvironment('CODEFLOWER_SESSIONS_DIR'),
    instanceId: requiredEnvironment('CODEFLOWER_INSTANCE_ID'),
    workspace: requiredEnvironment('CODEFLOWER_WORKSPACE'),
    templates: {
      instructions: await readFile(`${TEMPLATES}/TASK.md`, 'utf8'),
      continue: await readFile(`${TEMPLATES}/task/continue.md`, 'utf8'),
      wrapUp: await readFile(`${TEMPLATES}/task/wrap-up.md`, 'utf8')
    },
    signal: aborting.signal,
    wrapUpSignal: wrapUpController.signal,
    onWrapUp: () => {
      wrappingUp = true;
    },
    interactive: process.env.CODEFLOWER_TASK_INTERACTIVE === '1',
    ptyHelper: ['/opt/conda/bin/python3', '/opt/codeflower/bin/codeflower-pty'],
    mcpServers,
    plugins,
    input: process.stdin,
    authOut: process.stderr
  });
  egress?.close();
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exit(EXIT_CODES[result.status] ?? 1);
}

const initialPrompt = INITIAL_PROMPT_FILE ? (await readFile(INITIAL_PROMPT_FILE, 'utf8')).trim() : undefined;
if (INITIAL_PROMPT_FILE && !initialPrompt) {
  throw new Error('The initial task prompt file is empty');
}

const bridge = await startBridge({
  host: process.env.CODEFLOWER_LISTEN_HOST ?? '0.0.0.0',
  port: Number(process.env.CODEFLOWER_PORT ?? 0),
  listenSocket: process.env.CODEFLOWER_LISTEN_SOCKET || undefined,
  advertiseHost: requiredEnvironment('CODEFLOWER_ADVERTISE_HOST'),
  token: requiredEnvironment('CODEFLOWER_TOKEN'),
  connectionFile: requiredEnvironment('CODEFLOWER_CONNECTION_FILE'),
  appPid: Number(process.env.CODEFLOWER_APP_PID ?? process.pid),
  instanceId: requiredEnvironment('CODEFLOWER_INSTANCE_ID'),
  slurmJobId: process.env.CODEFLOWER_SLURM_JOB_ID,
  sessionsDirectory: requiredEnvironment('CODEFLOWER_SESSIONS_DIR'),
  agentName,
  agent: agents[agentName],
  initialPrompt,
  mcpServers,
  plugins,
  // The batch job's end, from the app (Slurm, PBS, HTCondor or --time-limit).
  allocationEnd: Date.parse(process.env.CODEFLOWER_ALLOCATION_END ?? '') || undefined,
  actions: await readActions(`${TEMPLATES}/actions`),
  wrapUpTemplate: await readFile(`${TEMPLATES}/wrap-up.md`, 'utf8'),
  wrapUpQuitTemplate: await readFile(`${TEMPLATES}/wrap-up-quit.md`, 'utf8'),
  ptyHelper: ['/opt/conda/bin/python3', '/opt/codeflower/bin/codeflower-pty'],
  // Output and code folders: reports there take comments, like those in the workspace.
  writableFolders: mounts()
    .filter((mount) => mount && typeof mount.target === 'string' && mount.readOnly === false)
    .map((mount) => mount.target),
  describe,
  page: SERVE_PAGE && { directory: PAGE_DIRECTORY },
  // The page's Quit: stop as on SIGTERM, which ends the sandbox.
  onQuit: () => void stop().then(() => process.exit(process.exitCode ?? 0))
});

const workerLine = connectionUrl(bridge.address.host, bridge.address.port, bridge.address.token);
const opening = SERVE_PAGE
  ? ['Open in a browser:', '', `  ${pageLink(bridge.address.host, bridge.address.port, bridge.address.token)}`]
  : ['With the code flower app running on your computer, open:', '', `  ${clientLink(workerLine)}`];
process.stderr.write(
  [
    '',
    `code flower worker ready (${agents[agentName].label}). ${opening[0]}`,
    ...opening.slice(1),
    '',
    'Or in VS Code, run "code flower: Connect to worker" and paste:',
    '',
    `  ${workerLine}`,
    '',
    `Anyone with ${SERVE_PAGE ? 'these links' : 'this line'} can control the agent. Keep job logs private,`,
    'e.g. sbatch --output=$HOME/.codeflower-logs/%j.out with that directory chmod 700.',
    '',
    ''
  ].join('\n')
);

let stopping;
const stop = () => {
  egress?.close();
  stopping ??= bridge.close().catch((error) => {
    process.stderr.write(`Could not stop ACP WebSocket bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
  return stopping;
};

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
