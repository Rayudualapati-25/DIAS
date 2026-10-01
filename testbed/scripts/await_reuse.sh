#!/usr/bin/env bash
#
# Wait for the full reuse run's load generator to exit, then finalize it (evaluate-only ledger
# check, collection, analysis) and copy the analysis into the results folder in Downloads, if it
# exists. Everything is logged to ~/dias-testbed/logs/await-reuse.log.
# Usage: nohup bash testbed/scripts/await_reuse.sh > /dev/null 2>&1 &
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${HOME}/dias-testbed/logs/await-reuse.log"
DOWNLOADS="${HOME}/Downloads/DIAS_results_20260925"
log() { echo "$(date -u +%FT%TZ) $*" >> "${LOG}"; }

log "waiting for loadgen-reuse to exit"
while docker --context lima-dias-m4 ps --format '{{.Names}}' | grep -qx loadgen-reuse; do sleep 60; done
log "loadgen-reuse exited: $(docker --context lima-dias-m4 ps -a --filter name=loadgen-reuse --format '{{.Status}}' | head -1)"
if ! bash "${REPO}/testbed/scripts/finalize_reuse.sh" >> "${LOG}" 2>&1; then
  log "FINALIZE FAILED; see above"
  exit 1
fi
if [ -d "${DOWNLOADS}" ]; then
  target="${DOWNLOADS}/11_Reuse_authorization_scope_100_users"
  mkdir -p "${target}"
  cp -R "${REPO}/experiments/runs/20260925_reuse_100_users/analysis/." "${target}/"
  log "copied the analysis to ${target}"
fi
log "DONE"
