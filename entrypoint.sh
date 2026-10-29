#!/bin/sh
# Prepares the project's persistent environment, then starts the ACP bridge.
set -eu

state=/codeflower-state
if [ -n "${CODEFLOWER_PREPEND_PATH:-}" ]; then
  PATH="$CODEFLOWER_PREPEND_PATH:$PATH"
  export PATH
fi
venv="${VIRTUAL_ENV:-$state/env/venv}"
workspace="${CODEFLOWER_WORKSPACE:-$state/workspace}"

# Packages the agent installs go into the project, not into the read-only
# image, so every worker on the project sees the same environment.
if [ ! -x "$venv/bin/python" ]; then
  uv venv --quiet --seed --system-site-packages --python /opt/conda/bin/python "$venv"
fi
# `pip install` must reach the venv, not the image's conda base; older
# projects' venvs were made without pip. Without a network this waits for later.
if [ ! -x "$venv/bin/pip" ]; then
  uv pip install --quiet --python "$venv/bin/python" pip || echo "Could not add pip to $venv" >&2
fi
mkdir -p "${CONDA_ENVS_DIRS:-$state/env/conda}" "${R_LIBS_USER:-$state/env/R}"

# Each harness reads its own instructions file. Copy the defaults, and update
# them with a new image unless the user edited them (a copy of what was
# installed tells the two apart).
installed="$state/run/templates"
mkdir -p "$workspace" "$installed"
for name in AGENTS.md CLAUDE.md; do
  template="/opt/codeflower/templates/$name"
  if [ ! -e "$workspace/$name" ] || { [ -e "$installed/$name" ] && cmp -s "$workspace/$name" "$installed/$name"; }; then
    cp "$template" "$workspace/$name"
    cp "$template" "$installed/$name"
  fi
done

# The launcher's development --inspect-port sets this; the agents never
# inherit an inspector because it is a node flag, not NODE_OPTIONS.
if [ -n "${CODEFLOWER_BRIDGE_INSPECT:-}" ]; then
  exec /usr/local/bin/node "--inspect=$CODEFLOWER_BRIDGE_INSPECT" /opt/codeflower/acp-ws/src/index.js
fi
exec /usr/local/bin/node /opt/codeflower/acp-ws/src/index.js
