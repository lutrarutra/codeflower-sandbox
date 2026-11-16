# Sourced by entrypoint.sh and reproduce.sh: the PATH and the project's Python
# environment, which the agents' sandbox and an agentless reproduction share.
# Sets state, venv and workspace, and defines step.

state=/codeflower-state
if [ -n "${CODEFLOWER_PREPEND_PATH:-}" ]; then
  PATH="$CODEFLOWER_PREPEND_PATH:$PATH"
  export PATH
fi
# For login shells, which /etc/profile gives a PATH of its own (profile.d/codeflower.sh).
CODEFLOWER_SANDBOX_PATH="$PATH"
export CODEFLOWER_SANDBOX_PATH
venv="${VIRTUAL_ENV:-$state/env/venv}"
workspace="${CODEFLOWER_WORKSPACE:-$state/workspace}"

# The steps that can take a while say so, so whoever watches the start (the
# app's page, a terminal) tells a slow start from a stuck one. A terminal UI
# draws over its terminal, so it gets none.
step() {
  [ "${CODEFLOWER_TUI:-}" = 1 ] || echo "  sandbox  $*" >&2
}

# Packages the agent installs go into the project, not into the read-only
# image, so every worker on the project sees the same environment.
# Seeding downloads pip; without a network (an isolated sandbox) the venv
# starts without it: `uv pip install` works, and pip is added by a later
# start that has a network.
if [ ! -x "$venv/bin/python" ]; then
  step "Creating the project's Python environment in $venv (first start)…"
  if ! uv venv --quiet --seed --system-site-packages --python /opt/conda/bin/python "$venv" 2>/dev/null; then
    rm -rf "$venv"
    uv venv --quiet --system-site-packages --python /opt/conda/bin/python "$venv"
  fi
fi
# `pip install` must reach the venv, not the image's conda base; older
# projects' venvs were made without pip. Without a network this waits for later.
if [ ! -x "$venv/bin/pip" ] && [ "${CODEFLOWER_NETWORK:-}" != isolated ]; then
  step "Adding pip to the project's Python environment…"
  uv pip install --quiet --python "$venv/bin/python" pip || echo "Could not add pip to $venv" >&2
fi
# R creates its project library (R_LIBS_USER) itself: /etc/R/Rprofile.site.
mkdir -p "${CONDA_ENVS_DIRS:-$state/env/conda}"
