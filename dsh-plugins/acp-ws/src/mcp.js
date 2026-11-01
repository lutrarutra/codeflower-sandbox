// MCP servers from the app's config (`mcp_servers:` in config.yaml). The app
// passes them in ACP's McpServer shape; the bridge gives them to the agent in
// every session/new, session/resume and session/load, which all four agents
// support natively. Each agent says in `initialize` which remote transports it
// takes (`mcpCapabilities`); stdio servers every agent takes.
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

// Where the app passes the servers. The bridge removes it from its environment.
export const MCP_SERVERS_VARIABLE = 'CODEFLOWER_MCP_SERVERS';

const NAME = /^[A-Za-z0-9_-]{1,32}$/;

function pairs(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value.map((pair) => {
    if (typeof pair?.name !== 'string' || !pair.name || typeof pair.value !== 'string') {
      throw new Error(`${where} must hold {name, value} strings`);
    }
    return { name: pair.name, value: pair.value };
  });
}

/** The servers in the app's JSON; throws on anything the agents would refuse. */
export function parseMcpServers(text) {
  if (!text) return [];
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error(`${MCP_SERVERS_VARIABLE} must be a JSON list`);
  const names = new Set();
  return value.map((server) => {
    const name = server?.name;
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new Error(`MCP server names are 1 to 32 letters, digits, - or _: ${JSON.stringify(name)}`);
    }
    if (names.has(name)) throw new Error(`Two MCP servers are named ${name}`);
    names.add(name);
    if (server.type === 'http' || server.type === 'sse') {
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)) {
        throw new Error(`MCP server ${name} needs an http or https url`);
      }
      return { type: server.type, name, url: server.url, headers: pairs(server.headers, `MCP server ${name}'s headers`) };
    }
    if (server.type !== undefined && server.type !== 'stdio') {
      throw new Error(`MCP server ${name} has an unknown type ${JSON.stringify(server.type)}`);
    }
    if (typeof server.command !== 'string' || !server.command) throw new Error(`MCP server ${name} needs a command`);
    const args = server.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`MCP server ${name}'s args must be strings`);
    }
    return { name, command: server.command, args, env: pairs(server.env, `MCP server ${name}'s env`) };
  });
}

// A command as an absolute path, which dsh requires: a bare name is looked up
// in PATH, a relative path is taken from the workspace.
function locate(command, path, workspace) {
  if (isAbsolute(command)) return command;
  if (command.includes('/')) return resolve(workspace, command);
  for (const directory of (path ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * The servers an agent takes, given its `initialize` result, with commands
 * made absolute. `skipped` says which were left out and why ({name, reason}):
 * a transport the agent does not support, or a command not found in the
 * sandbox. An agent fails the whole session on a server it refuses, so these
 * are left out.
 */
export function mcpServersFor(servers, initialized, { path, workspace }) {
  const remote = initialized?.agentCapabilities?.mcpCapabilities ?? {};
  const accepted = [];
  const skipped = [];
  for (const server of servers) {
    if (server.type) {
      if (remote[server.type] === true) accepted.push(server);
      else skipped.push({ name: server.name, reason: `the agent does not support ${server.type} servers` });
      continue;
    }
    const command = locate(server.command, path, workspace);
    if (command) accepted.push({ ...server, command });
    else skipped.push({ name: server.name, reason: `${server.command} is not in the sandbox` });
  }
  return { servers: accepted, skipped };
}

/** Left-out servers for a log line: `name (reason), …`. */
export function describeLeftOut(servers) {
  return servers.map(({ name, reason }) => `${name} (${reason})`).join(', ');
}

/** The configured servers a session request gets: those the client does not name itself. */
export function addedMcpServers(params, servers) {
  const own = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
  const named = new Set(own.map((server) => server?.name));
  return servers.filter((server) => !named.has(server.name));
}

/** A session request's servers: the client's own, then the configured ones it does not name. */
export function withMcpServers(params, servers) {
  const own = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
  return { ...params, mcpServers: [...own, ...addedMcpServers(params, servers)] };
}

// dsh's MCP client names the server that did not start:
// `mcp-client(NAME): initial connection or tool synchronization failed`.
const FAILED_SERVER = /mcp-client\(([A-Za-z0-9_-]{1,32})\)/;

/**
 * The servers to leave out after a session start failed, of those the bridge
 * added (`given`): the one the error names, or all of them when the error is
 * about MCP without naming one. None when the error is about something else,
 * or names a server the client gave itself: the error then stands.
 *
 * dsh fails a session on any MCP server that does not start
 * (`failOnStartupError`, which ACP cannot change); the other agents start the
 * session and report the server, so they never get here.
 */
export function failedMcpServers(error, given) {
  if (!given.length) return [];
  const text = `${error?.message ?? ''} ${JSON.stringify(error?.data ?? null)}`;
  const named = FAILED_SERVER.exec(text)?.[1];
  if (named) return given.some((server) => server.name === named) ? [named] : [];
  return /\bmcp\b/i.test(text) ? given.map((server) => server.name) : [];
}

// Why a server that failed a session start is not in it.
export const DID_NOT_START = 'it did not start';
