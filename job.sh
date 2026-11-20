#!/bin/sh
# Runs one batch job's command (or one task of a job array) without any agent:
# the app's `codeflower job-run` starts the sandbox with this entrypoint
# instead of entrypoint.sh, with the folders and environment of the sandbox
# that asked for the job (codeflower-job). The project's software
# environments are there as that sandbox left them, read-only unless the
# config's jobs.env_writable says otherwise, so nothing is created here.
set -eu

if [ "$#" -eq 0 ]; then
  echo "Usage: job.sh COMMAND [ARGS...]" >&2
  exit 2
fi

if [ -n "${CODEFLOWER_PREPEND_PATH:-}" ]; then
  PATH="$CODEFLOWER_PREPEND_PATH:$PATH"
  export PATH
fi
# For login shells the job starts (bash -l), which /etc/profile gives a PATH of its own.
CODEFLOWER_SANDBOX_PATH="$PATH"
export CODEFLOWER_SANDBOX_PATH

# An isolated job reaches only the allowlist's hosts, through the app's proxy.
if [ -n "${CODEFLOWER_EGRESS_SOCKET:-}" ]; then
  /usr/local/bin/node /opt/codeflower/lib/egress-forwarder.mjs &
fi

cd "${CODEFLOWER_JOB_WORKDIR:-/codeflower-state/workspace}"
if [ -n "${CODEFLOWER_EGRESS_SOCKET:-}" ]; then
  # Not exec: the forwarder must outlive the command's start, and go with it.
  status=0
  "$@" || status=$?
  exit "$status"
fi
exec "$@"
