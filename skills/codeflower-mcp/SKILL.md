---
name: codeflower-mcp
description: How the user gives you MCP (Model Context Protocol) servers in code flower. Use when the user asks to connect, add or use an MCP server or its tools, when a tool they expect from one is missing, or when an MCP server fails.
---

# MCP servers in code flower

You get MCP servers only from the code flower app's config on the user's
computer. You cannot add one yourself: the config is not in the sandbox, and
your own MCP settings are not used. When the user wants a server, explain the
steps below and let them do it.

## What to tell the user

1. **Open the config file** on the computer that starts the sandbox:
   `~/.codeflower/config.yaml`, or `config.yaml` in the folder given with
   `--config` or `CODEFLOWER_CONFIG`. On a cluster, this is the file on the
   cluster, where `codeflower` runs.
2. **Add the server under `mcp_servers:`**, with a name of 1 to 32 letters,
   digits, `-` or `_`. Either a server at a URL:

   ```yaml
   mcp_servers:
     docs:
       url: https://mcp.example.org/mcp
       transport: http          # the default; sse works for Claude Code and OpenCode only
       headers: { Authorization: "Bearer <token>" }
   ```

   or a command that runs **inside the sandbox** (stdio):

   ```yaml
   mcp_servers:
     files:
       command: files-mcp       # found in the sandbox's PATH, or a full path
       args: [--root, /codeflower-state/workspace]
       env: { TOKEN: "<token>" }
   ```

3. **If the server has `env` or `headers`**, make the file private:
   `chmod 600 ~/.codeflower/config.yaml`. code flower refuses to start
   otherwise, as these usually hold tokens.
4. **Restart the sandbox.** The list is read when the sandbox starts, so this
   chat does not get the new server. After the restart, the user can reopen this
   chat or start a new one.

Write out the exact lines for the server they asked about. Take the URL, the
command and the header names from that server's own documentation. Never put
a real token in your message: use a placeholder and say where it goes.

## Commands run in the sandbox

A `command` server must be installed in the sandbox before the restart, or it
is left out. You can install it in the project's environment, which persists:

- Python servers: `uv pip install <package>`. The command is then in
  `/codeflower-state/env/venv/bin`, which is on `PATH`.
- Node servers: `npm install --prefix /codeflower-state/env/mcp <package>`, then
  use the full path `/codeflower-state/env/mcp/node_modules/.bin/<command>`
  as `command`.

Test that the command starts before telling the user to add it. Prefer an
installed command to `npx`/`uvx`, which download the server at every start
and fail without network.

## With an isolated network

When the sandbox's network is isolated, the host of each `url` server is
allowed by itself. Two cases still need lines in the allowlist file (see the
codeflower-network skill):

- a server on the local network or the cluster (private addresses), and
- whatever a `command` server itself connects to.

## When a server's tools are missing

- **Check your own tools first.** The server's tools appear among them under
  its name.
- **Left out.** The chat shows a notice naming each configured server it is
  without, and why; the worker's log says it too ("MCP servers left out
  for …"). The reasons are:
  - an `sse` server, which Codex and DeepSeek Harness (dsh) do not support (ask
    whether the server also offers streamable HTTP, `transport: http`),
  - a command not found in the sandbox, and
  - "it did not start": the command crashed, or the URL was unreachable or
    refused the token. The chat works without it, and the next chat or
    reopening tries it again. Help the user find out why: run the command
    yourself and read its error, or check the URL and token.
- **Failed while running.** A server that stops later shows up as failing
  tool calls. Say so, and work without it.
- **Config refused.** `codeflower` stops before starting the sandbox and
  names the line, e.g. both `command` and `url`, or a misspelled field.
