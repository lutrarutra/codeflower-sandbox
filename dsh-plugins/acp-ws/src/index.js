import { readFile } from 'node:fs/promises';
import { AGENT_NAMES, createAgents, PROVIDED_KEY_VARIABLE } from './agents.js';
import { startEgressForwarder } from './egress.js';
import { connectionUrl, startBridge } from './server.js';
import { EXIT_CODES, runTask } from './task.js';

const RUNTIME_MODULES = '/opt/codeflower/runtime/node_modules';
const TASK_TEMPLATE = '/opt/codeflower/templates/TASK.md';
const DSH_USAGE_PATCH = '/opt/codeflower/dsh-usage/cordis.patch.yml';
const INITIAL_PROMPT_FILE = process.env.CODEFLOWER_INITIAL_PROMPT_FILE;

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
const agents = createAgents({
  nodePath: process.execPath,
  dshBin: `${RUNTIME_MODULES}/@deepseek-ai/dsh/lib/bin.js`,
  claudeAcpBin: `${RUNTIME_MODULES}/@agentclientprotocol/claude-agent-acp/dist/index.js`,
  codexAcpBin: `${RUNTIME_MODULES}/@agentclientprotocol/codex-acp/dist/index.js`,
  codexBin: `${RUNTIME_MODULES}/@openai/codex/bin/codex.js`,
  dshUsagePatch: DSH_USAGE_PATCH
});

// The launcher's config may give the agent an API key. It goes into the
// agent's own files in the project, and leaves this process's environment so
// that nothing started from here inherits it.
const providedKey = process.env[PROVIDED_KEY_VARIABLE];
delete process.env[PROVIDED_KEY_VARIABLE];
if (providedKey) {
  try {
    const kept = await agents[agentName].provideKey?.(providedKey);
    if (kept) process.stderr.write(`The API key from the launcher's config was not used: ${kept}\n`);
  } catch (error) {
    throw new Error(`Could not store the API key from the launcher's config: ${error.message}`);
  }
}

// What the extension shows about this worker.
// The folders the launcher mounted, e.g. /data/input/study42, with their host paths.
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

// A network-isolated sandbox's only way out: the launcher's proxy.
const egress = process.env.CODEFLOWER_EGRESS_SOCKET
  ? await startEgressForwarder(process.env.CODEFLOWER_EGRESS_SOCKET).catch((error) => {
      process.stderr.write(`The sandbox has no network: ${error.message}\n`);
    })
  : undefined;

// `codeflower task`: the agent works on its task by itself, without VS Code.
if (process.env.CODEFLOWER_TASK_FILE) {
  if (INITIAL_PROMPT_FILE) {
    throw new Error('CODEFLOWER_TASK_FILE and CODEFLOWER_INITIAL_PROMPT_FILE cannot be used together');
  }
  const aborting = new AbortController();
  process.once('SIGINT', () => aborting.abort());
  process.once('SIGTERM', () => aborting.abort());
  const result = await runTask({
    agentName,
    agent: agents[agentName],
    taskFile: process.env.CODEFLOWER_TASK_FILE,
    sessionsDirectory: requiredEnvironment('CODEFLOWER_SESSIONS_DIR'),
    instanceId: requiredEnvironment('CODEFLOWER_INSTANCE_ID'),
    workspace: requiredEnvironment('CODEFLOWER_WORKSPACE'),
    instructionsTemplate: await readFile(TASK_TEMPLATE, 'utf8'),
    signal: aborting.signal,
    interactive: process.env.CODEFLOWER_TASK_INTERACTIVE === '1',
    ptyHelper: ['/opt/conda/bin/python3', '/opt/codeflower/bin/codeflower-pty'],
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
  launcherPid: Number(process.env.CODEFLOWER_LAUNCHER_PID ?? process.pid),
  instanceId: requiredEnvironment('CODEFLOWER_INSTANCE_ID'),
  slurmJobId: process.env.CODEFLOWER_SLURM_JOB_ID,
  sessionsDirectory: requiredEnvironment('CODEFLOWER_SESSIONS_DIR'),
  agentName,
  agent: agents[agentName],
  initialPrompt,
  ptyHelper: ['/opt/conda/bin/python3', '/opt/codeflower/bin/codeflower-pty'],
  describe
});

process.stderr.write(
  [
    '',
    `code flower worker ready (${agents[agentName].label}). In VS Code, run "code flower: Connect to worker" and paste:`,
    '',
    `  ${connectionUrl(bridge.address.host, bridge.address.port, bridge.address.token)}`,
    '',
    'Anyone with this line can control the agent. Keep job logs private,',
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
