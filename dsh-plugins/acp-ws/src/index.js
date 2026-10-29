import { AGENT_NAMES, createAgents } from './agents.js';
import { startEgressForwarder } from './egress.js';
import { connectionUrl, startBridge } from './server.js';

const RUNTIME_MODULES = '/opt/codeflower/runtime/node_modules';

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
  codexAcpBin: `${RUNTIME_MODULES}/@agentclientprotocol/codex-acp/dist/index.js`
});

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
