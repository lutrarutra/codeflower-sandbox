<p align="center">
  <img src="assets/icon.svg" width="112" height="112" alt="code flower sandbox icon">
</p>

<h1 align="center">code flower sandbox</h1>

<p align="center">The isolated image the agents work in, and the bridge to VS Code.</p>

<p align="center">
  <a href="https://github.com/lutrarutra/codeflower-app"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-app/main/assets/icon.png" width="20" height="20" alt=""> app</a>
  &nbsp;·&nbsp;
  <b><img src="assets/icon.png" width="20" height="20" alt=""> sandbox</b>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/codeflower-vsc-extension"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-vsc-extension/main/media/icon.png" width="20" height="20" alt=""> VS Code extension</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/storyteller"><img src="https://raw.githubusercontent.com/lutrarutra/storyteller/main/assets/icon.png" width="20" height="20" alt=""> storyteller</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/codeflower-tunnel"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-tunnel/main/assets/icon.png" width="20" height="20" alt=""> tunnel</a>
  &nbsp;·&nbsp;
  <a href="https://docs.codeflower.app">docs.codeflower.app</a>
</p>

The container image a code flower worker runs: Claude Code, Codex, DeepSeek Harness and OpenCode, the tools
they use to work on your data, and the bridge that connects VS Code and the browser to them over one
authenticated WebSocket. Claude Code itself is not in the image, as its license does not allow passing it
on: the code flower app downloads it for your machine and mounts it into Claude Code workers.

## Install

You normally do not install it yourself: the [app](https://github.com/lutrarutra/codeflower-app)
downloads the release it was tested with and starts it (`codeflower pull`, `codeflower sandbox`).
To get it by hand:

```sh
docker pull ghcr.io/lutrarutra/codeflower-sandbox:0.13
apptainer pull codeflower-sandbox.sif docker://ghcr.io/lutrarutra/codeflower-sandbox:0.13
```

Releases are published for linux/amd64 and linux/arm64, tagged `X.Y.Z`, `X.Y`, `latest` and
`sha-<commit>`. Run your own build with `codeflower sandbox --image codeflower-sandbox` (or
`--image FILE.sif`).

## Contents

- `Dockerfile`, `entrypoint.sh`: the image and its start script, which prepares the project's
  environment and starts the bridge
- `package.json`: the agent runtimes, pinned exactly
- `licenses/`: the licenses of what the image includes without them (OpenCode's binaries, the
  Single-cell best practices book in `skills/`)
- `bin/`: commands for the agent: `codeflower-show`, `codeflower-pty`, `codeflower-env-export`,
  `codeflower-network`, `codeflower-doctor` (the worker's resources and, when isolated, its
  allowlist) and `codeflower-inventory` (describes the mounted data: formats, shapes, columns)
- `templates/`: the agent instructions copied into a new workspace, and those of `codeflower task`
  (`TASK.md`, `task/continue.md`, `task/wrap-up.md`)
- `dsh-plugins/acp-ws/`: the bridge: ACP over WebSocket, session recording, sign-in relay
- `dsh-plugins/acp-ws/src/agents/<id>/`: one folder per agent: `agent.json` (name, launch script,
  home, credential variables, provider hosts) and an optional `index.js` (login checks, where a key
  goes). To add an agent, add its folder and its adapter to `package.json`, then run `make agents` in
  the app, which embeds the descriptors.

## Development

```sh
make sandbox-build          # the image codeflower-sandbox (Docker)
make sandbox-build-linux    # build/codeflower-sandbox-amd64.tar for an x86_64 cluster (Apptainer)
make bridge-install bridge-test
```

To develop it with the other components, clone
[codeflower-workspace](https://github.com/lutrarutra/codeflower-workspace), which has this repo as the
`sandbox/` submodule. Its [architecture document](https://github.com/lutrarutra/codeflower-workspace/blob/main/docs/architecture.md)
describes how the parts fit together and the `CODEFLOWER_*` environment and `/opt/codeflower` paths
the app relies on.
