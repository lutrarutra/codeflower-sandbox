# Plugins and transport

- [`acp-ws/`](acp-ws/): the bridge between the VS Code extension and the worker's agent. It serves ACP over an
  authenticated WebSocket, starts the worker's agent (DeepSeek Harness, Claude Code, or Codex) for each
  connection, records sessions in the project's `sessions/` directory, runs the agents' terminal sign-ins,
  and stores DeepSeek Harness keys. It is agent-independent despite this directory's name.
- [`usage/`](usage/): a dsh plugin that reports each model call's token counts to the bridge, which dsh's ACP
  app does not send. The bridge adds it with `--patch` and reads its lines on file descriptor 3.

The kernel and notebook integration follow later as an MCP server, so all three agents can use it.
See [the architecture document](https://github.com/lutrarutra/codeflower-workspace/blob/main/docs/architecture.md#3-bridge-sandboxdsh-pluginsacp-ws).
