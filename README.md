# code flower sandbox

The isolated runtime image of a code flower worker, with all three agents (Claude Code, Codex,
and DeepSeek Harness), and the bridge that connects it to VS Code.

- `Dockerfile`, `entrypoint.sh`: the image (`codeflower-sandbox`) and its start script
- `package.json`: the agent runtimes, pinned exactly
- `bin/`: `codeflower-show`, `codeflower-pty`, `codeflower-env-export`, `codeflower-network`,
  and `codeflower-doctor` for per-worker environment facts and live diagnostics
- `templates/`: the agent instructions copied into a new workspace
- `dsh-plugins/acp-ws/`: the authenticated ACP WebSocket bridge, session recorder, and sign-in relay

Releases are published as `ghcr.io/lutrarutra/codeflower-sandbox` for linux/amd64 and linux/arm64,
tagged `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>`. The launcher downloads the `X.Y` it was tested
with (`codeflower pull`); to get it yourself:

```sh
docker pull ghcr.io/lutrarutra/codeflower-sandbox:0.1
apptainer pull codeflower-sandbox.sif docker://ghcr.io/lutrarutra/codeflower-sandbox:0.1
```

To build it locally:

```sh
make sandbox-build          # the image codeflower-sandbox (Docker)
make sandbox-build-linux    # build/codeflower-sandbox-amd64.tar for an x86_64 cluster (Apptainer)
make bridge-install bridge-test
```

The launcher ([codeflower-launcher](https://github.com/lutrarutra/codeflower-launcher)) starts
the image. The `CODEFLOWER_*` environment and `/opt/codeflower` paths it relies on are described
in the [architecture document](https://github.com/lutrarutra/codeflower-workspace/blob/main/docs/architecture.md).
At startup each worker writes its own snapshot under `run/`; `codeflower-doctor` reads that
snapshot and checks current resources and, when isolated, the current network allowlist. CPU
affinity and host memory are not necessarily the resource limits imposed by a scheduler.
For development, clone [codeflower-workspace](https://github.com/lutrarutra/codeflower-workspace),
which has this repo as the `sandbox/` submodule.
