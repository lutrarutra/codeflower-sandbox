// `codeflower tui`: the agent's own terminal UI alone in the sandbox, on the
// user's terminal, instead of the bridge: no port, no windows, no record of
// the chat in code flower (the agent keeps its own, which --continue and
// --resume open again). The sandbox ends with it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeMcpConfig } from './mcp.js';
import { agentEnvironment } from './server.js';

// What the app asks for (CODEFLOWER_TUI_RESUME): a new chat (empty), the
// last one, the agent's own list, or a session id.
export function parseResume(value) {
  if (!value || value === 'new') return undefined;
  return value;
}

/**
 * Runs the terminal UI and resolves with its exit code. The settings and
 * environment are those of the chats the bridge hands over (agent.tuiSettings,
 * agent.tuiEnv), so the UI starts at once: no first-run screens, no updates.
 */
export async function runTui({ agentName, agent, plugins, mcpServers = [], resume, workspace, environment = process.env, log = () => {}, say = (text) => process.stdout.write(text) }) {
  const label = agent.label ?? agentName;
  if (!agent.soloCommand) throw new Error(`${label} has no terminal UI in code flower`);
  const pluginEnvironment = (await plugins?.activate()) ?? {};
  await agent.prepareTui?.({ cwd: workspace });
  let mcpConfig;
  if (mcpServers.length && agent.mcpConfigFile) {
    mcpConfig = join(tmpdir(), `codeflower-mcp-tui-${process.pid}.json`);
    await writeFile(mcpConfig, `${JSON.stringify(claudeMcpConfig(mcpServers))}\n`, { mode: 0o600 });
  } else if (mcpServers.length) {
    log(`The MCP servers from the app's config are not given to ${label}'s terminal UI; add them in its own config`);
  }
  const command = await agent.soloCommand({ resume, settings: { ...agent.tuiSettings }, mcpConfig });
  // Session files keep whole seconds on some file systems.
  const started = Date.now() - 2000;
  const child = spawn(command[0], command.slice(1), {
    cwd: workspace,
    stdio: 'inherit',
    env: agentEnvironment(environment, { ...agent.env, ...pluginEnvironment, ...agent.tuiEnv })
  });
  // The terminal's Ctrl+C is the program's (it reads it in raw mode); the
  // app's SIGTERM, or a closed terminal, ends it, and with it the sandbox.
  process.on('SIGINT', () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  const [code, signal] = await once(child, 'close');
  // The agent says how to open the chat again with its own command, which
  // the user's terminal does not have: the app gives its own (CODEFLOWER_TUI_AGAIN,
  // up to the id).
  const again = environment.CODEFLOWER_TUI_AGAIN;
  const session = again && (await agent.lastSession?.({ cwd: workspace, since: started }).catch(() => undefined));
  if (session) say(`\nContinue this chat in code flower with:\n${again}${session}\n`);
  return code ?? 128 + (constants.signals[signal] ?? 1);
}
