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
# Seeding downloads pip; without a network (an isolated sandbox) the venv
# starts without it: `uv pip install` works, and pip is added by a later
# start that has a network.
if [ ! -x "$venv/bin/python" ]; then
  if ! uv venv --quiet --seed --system-site-packages --python /opt/conda/bin/python "$venv" 2>/dev/null; then
    rm -rf "$venv"
    uv venv --quiet --system-site-packages --python /opt/conda/bin/python "$venv"
  fi
fi
# `pip install` must reach the venv, not the image's conda base; older
# projects' venvs were made without pip. Without a network this waits for later.
if [ ! -x "$venv/bin/pip" ] && [ "${CODEFLOWER_NETWORK:-}" != isolated ]; then
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

# storyteller, the report library, lives in the project as an editable install, so
# the agent can fix or extend it. A new image's version replaces that copy only
# while it is unchanged (a pristine copy in run/ tells, as for the templates);
# an edited copy is kept. Its dependencies are in the image, so this works offline.
storyteller_image=/opt/codeflower/src/storyteller
storyteller="$state/env/src/storyteller"
storyteller_installed="$state/run/storyteller"
same_tree() {
  diff -rq -x __pycache__ -x '*.egg-info' -x .pytest_cache -x .ruff_cache "$1" "$2" >/dev/null 2>&1
}
if [ -d "$storyteller_image" ]; then
  if [ -z "$(ls -A "$storyteller" 2>/dev/null)" ] || { [ -d "$storyteller_installed" ] && same_tree "$storyteller" "$storyteller_installed"; }; then
    if ! same_tree "$storyteller_image" "$storyteller"; then
      rm -rf "$storyteller" "$storyteller_installed"
      mkdir -p "$(dirname "$storyteller")"
      cp -R "$storyteller_image" "$storyteller"
      cp -R "$storyteller_image" "$storyteller_installed"
    fi
  elif ! same_tree "$storyteller_image" "$storyteller_installed"; then
    echo "Keeping the edited storyteller in $storyteller (the image has another version in $storyteller_image)" >&2
  fi
  if ! "$venv/bin/python" -I -c 'import storyteller.report' 2>/dev/null; then
    uv pip install --quiet --offline --no-deps --no-build-isolation --python "$venv/bin/python" -e "$storyteller" \
      || echo "Could not install storyteller from $storyteller" >&2
  fi
fi

# Skills the user mounted (--skills), and the network skill in an isolated
# sandbox, are linked where each harness looks for skills. A mounted folder is
# one skill when it has a SKILL.md, otherwise a folder of skills. Links from
# earlier starts are replaced, so removed skills disappear.
skill_roots="${CLAUDE_CONFIG_DIR:-$state/harness/claude}/skills ${CODEX_HOME:-$state/harness/codex}/skills ${DSH_HOME:-$state/dsh-home}/skills"
for root in $skill_roots; do
  mkdir -p "$root"
  for link in "$root"/*; do
    if [ -L "$link" ]; then
      case "$(readlink "$link")" in
        /data/skills/* | /opt/codeflower/skills/* | "$state"/env/src/*) rm -f "$link" ;;
      esac
    fi
  done
done
linked=" "
link_skill() {
  name=${2:-$(basename "$1")}
  case "$linked" in
    *" $name "*)
      echo "Skipping the skill $1: another skill is already called $name" >&2
      return
      ;;
  esac
  linked="$linked$name "
  for root in $skill_roots; do
    if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then
      echo "Keeping $root/$name rather than linking the skill $1 of the same name" >&2
    else
      ln -s "$1" "$root/$name"
    fi
  done
}
if [ "${CODEFLOWER_NETWORK:-}" = isolated ]; then
  link_skill /opt/codeflower/skills/codeflower-network
fi
if [ -f "$storyteller/skill/SKILL.md" ]; then
  link_skill "$storyteller/skill" storyteller
fi
for folder in /data/skills/*; do
  [ -d "$folder" ] || continue
  if [ -f "$folder/SKILL.md" ]; then
    link_skill "$folder"
  else
    for skill in "$folder"/*; do
      [ -f "$skill/SKILL.md" ] && link_skill "$skill"
    done
  fi
done

# Keep launch facts per worker: several workers can share the same project.
if [ -n "${CODEFLOWER_INSTANCE_ID:-}" ]; then
  CODEFLOWER_ENVIRONMENT_FILE="${CODEFLOWER_RUN_DIR:-$state/run}/environment-$CODEFLOWER_INSTANCE_ID.md"
  export CODEFLOWER_ENVIRONMENT_FILE
  if ! codeflower-doctor --write-startup "$CODEFLOWER_ENVIRONMENT_FILE"; then
    echo "Could not write sandbox environment facts" >&2
    unset CODEFLOWER_ENVIRONMENT_FILE
  fi
fi

# What the user's data holds (formats, shapes, columns), so the agent knows it
# before listing anything. Workers of a project may mount different data, so
# each writes its own. A short time limit keeps big folders from delaying the
# start; the agent can run the command again for more.
if [ -n "${CODEFLOWER_INSTANCE_ID:-}" ]; then
  CODEFLOWER_INVENTORY_FILE="${CODEFLOWER_RUN_DIR:-$state/run}/inventory-$CODEFLOWER_INSTANCE_ID.md"
  export CODEFLOWER_INVENTORY_FILE
  if ! codeflower-inventory --time-limit "${CODEFLOWER_INVENTORY_SECONDS:-10}" --write "$CODEFLOWER_INVENTORY_FILE"; then
    echo "Could not describe the data in /data/input" >&2
    unset CODEFLOWER_INVENTORY_FILE
  fi
fi

# The app's development --inspect-port sets this; the agents never
# inherit an inspector because it is a node flag, not NODE_OPTIONS.
if [ -n "${CODEFLOWER_BRIDGE_INSPECT:-}" ]; then
  exec /usr/local/bin/node "--inspect=$CODEFLOWER_BRIDGE_INSPECT" /opt/codeflower/acp-ws/src/index.js
fi
exec /usr/local/bin/node /opt/codeflower/acp-ws/src/index.js
