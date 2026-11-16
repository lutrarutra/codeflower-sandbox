#!/bin/sh
# Reproduces a pipeline archive without any agent: `codeflower reproduce` starts the sandbox with this
# entrypoint instead of entrypoint.sh, so no bridge, agent, sign-in or skill is involved. One mode per
# start, each in a new container on the same throwaway project:
#   check    validate the archive and dry-run it against the downloaded data (no network)
#   prepare  restore the environment from the lockfiles or the snapshot (package indexes only)
#   run      run the pipeline (no network), copy its results out and compare them
# The app mounts the archive at /repro/pipeline, the data at /repro/data, the snapshot at
# /repro/snapshot.tar.gz, a scratch folder at /repro/work and the output folder at /repro/out.
set -eu

mode=${1:-}
case "$mode" in
  check | prepare | run) ;;
  *)
    echo "Usage: reproduce.sh check|prepare|run" >&2
    exit 2
    ;;
esac

. /opt/codeflower/lib/env-setup.sh

pipeline=/repro/pipeline
cores=${CODEFLOWER_REPRO_CORES:-}

if [ -n "${CODEFLOWER_EGRESS_SOCKET:-}" ]; then
  /usr/local/bin/node /opt/codeflower/lib/egress-forwarder.mjs &
  forwarder=$!
  trap 'kill "$forwarder" 2>/dev/null || true' EXIT
fi

case "$mode" in
  check)
    exec codeflower-repro check "$pipeline" --data /repro/data --packed --json-out /repro/out/check.json
    ;;
  prepare)
    if [ -f /repro/snapshot.tar.gz ]; then
      exec codeflower-repro restore "$pipeline" --snapshot /repro/snapshot.tar.gz
    fi
    if [ -z "${CODEFLOWER_EGRESS_SOCKET:-}" ] && [ "${CODEFLOWER_NETWORK:-}" != isolated ]; then
      echo "  sandbox  The network is not restricted while the environment is restored" >&2
    fi
    codeflower-repro restore "$pipeline"
    ;;
  run)
    status=0
    codeflower-repro run "$pipeline" --data /repro/data --workdir /repro/work --copy-to /repro/out \
      ${cores:+--cores "$cores"} --record /repro/out/run.json || status=$?
    if [ "$status" -ne 0 ]; then
      echo "The pipeline failed (exit status $status)" >&2
      exit 3
    fi
    exec codeflower-repro verify "$pipeline" --dir /repro/out --report /repro/out/reproduce-report
    ;;
esac
