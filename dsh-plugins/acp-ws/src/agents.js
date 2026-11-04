// The agents a worker can run, one folder each under agents/: `agent.json`
// says what the bridge, the image and the app need to know (name, how to
// start it, its home in the project, its credential variables and provider
// hosts, files to write once), and an optional `index.js` adds what only code
// can say (whether the project holds a login, where a configured key goes, a
// launch command with arguments, its plugins adapter, parts of its subagents
// adapter). An agent that needs nothing but ACP needs no index.js. Adding an
// agent is adding a folder, its package to the image's package.json, and the
// descriptor to the app (`make agents` there).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidRequest } from './agents/support.js';
import { createSubagentAdapter } from './subagents/adapters.js';

export { InvalidRequest };

// Where the app passes the API keys from its config: JSON, by agent.
export const PROVIDED_KEYS_VARIABLE = 'CODEFLOWER_API_KEYS';

const AGENTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'agents');

/** Every agent's descriptor and hooks in a folder of agents, in folder order. */
export async function loadRegistry(directory = AGENTS_DIRECTORY) {
  return Promise.all(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'agent.json')))
      .map(async (entry) => {
        const folder = join(directory, entry.name);
        const descriptor = JSON.parse(readFileSync(join(folder, 'agent.json'), 'utf8'));
        if (descriptor.id !== entry.name) throw new Error(`${folder}/agent.json names the agent ${descriptor.id}`);
        if (typeof descriptor.launch !== 'string') throw new Error(`${folder}/agent.json has no launch script`);
        const hooks = existsSync(join(folder, 'index.js')) ? (await import(join(folder, 'index.js'))).default : undefined;
        return { descriptor, hooks, icon: readIcon(folder, descriptor) };
      })
  );
}

// The agent's logo (agent.json's `icon`, an SVG next to it; see ICONS.md), as a
// data URL that windows show in an <img>, where an SVG runs no script. A
// `mono` icon is drawn in currentColor, which an <img> does not inherit: windows
// use it as a mask over the text color instead.
function readIcon(folder, descriptor) {
  if (!descriptor.icon?.file) return undefined;
  const svg = readFileSync(join(folder, descriptor.icon.file));
  return { url: `data:image/svg+xml;base64,${svg.toString('base64')}`, mono: descriptor.icon.mono === true };
}

const registry = await loadRegistry();

export const AGENT_NAMES = registry.map(({ descriptor }) => descriptor.id);

/** The agents' descriptors, by id. */
export const DESCRIPTORS = Object.fromEntries(registry.map(({ descriptor }) => [descriptor.id, descriptor]));

// Every credential variable any agent understands. The bridge never passes
// them to an agent: logins and keys live in the agents' own files in the
// project, written by their sign-in flows.
export const CREDENTIAL_VARIABLES = [
  ...new Set(registry.flatMap(({ descriptor }) => descriptor.credentialVariables ?? [])),
  // The keys the app's config gives the agents; see provideKey.
  PROVIDED_KEYS_VARIABLE
];

export async function terminalAuthCommand(agent, method) {
  const methodId = method?.id ?? 'unknown';
  const meta = method?._meta?.['terminal-auth'];
  if (meta && typeof meta.command === 'string') {
    return [meta.command, ...(Array.isArray(meta.args) ? meta.args.map(String) : [])];
  }
  if (method?.type === 'terminal') {
    return [...(await agent.command()), ...(Array.isArray(method.args) ? method.args.map(String) : [])];
  }
  throw new InvalidRequest(`${methodId} is not a terminal sign-in`);
}

/**
 * The agents a worker can run, by id. Each knows its command, its extra
 * environment, and whether its project already holds a login or key.
 *
 * `modules` is the image's node_modules, where each agent's `launch` script
 * is; `launch` gives other scripts by agent id (tests start a fake agent).
 * `agents` replaces the built-in agents (tests, from loadRegistry).
 */
export function createAgents({ nodePath, modules, launch = {}, environment = process.env, agents = registry }) {
  return Object.fromEntries(
    agents.map(({ descriptor, hooks, icon }) => {
      const script = launch[descriptor.id] ?? (modules ? join(modules, descriptor.launch) : descriptor.launch);
      const home = descriptor.home ? environment[descriptor.home.variable] : undefined;
      const agent = {
        label: descriptor.name,
        // How windows show it: name, color and logo.
        presentation: {
          id: descriptor.id,
          name: descriptor.name,
          ...(descriptor.color ? { color: descriptor.color } : {}),
          ...(icon ? { icon: icon.url, ...(icon.mono ? { iconMono: true } : {}) } : {})
        },
        async command() {
          return [nodePath, script];
        },
        env: descriptor.env ?? {},
        goal: descriptor.goal,
        costEstimate: descriptor.costEstimate === true,
        // Which plugin sources and catalogs it takes; its hook's `plugins` fetches them (plugins.js).
        pluginsDescriptor: descriptor.plugins,
        ...hooks?.({ descriptor, home, launch: script, nodePath, modules, environment })
      };
      // How it shows its subagents (subagents/adapters.js): agent.json's
      // `subagents`, with what its index.js replaces.
      agent.subagents = createSubagentAdapter(descriptor.subagents, agent.subagents);
      return [descriptor.id, agent];
    })
  );
}
