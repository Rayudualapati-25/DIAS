#!/usr/bin/env bash
#
# Supervisor for the AI decision listener.
#
# WHY THIS EXISTS
#
# The listener stops itself when a request cannot be decided. That is deliberate:
# it refuses to advance its checkpoint past a committed but unanswered request,
# so the request stays retryable instead of being silently skipped. The design
# assumes something will restart it. Nothing did, so a single model-inference
# timeout left authorization decisioning offline until a human intervened.
#
# This script is that missing something. It is deployment configuration only. It
# starts the listener, notices when it exits, and starts it again. It does not
# read or write ledger state, does not touch the checkpoint, does not alter
# requests, model responses, validator behaviour, policy, timeouts, signatures or
# chaincode. It cannot change any decision, because it only ever runs the same
# unmodified command.
#
# It also never hides a failure: every exit and every restart is written to a
# human log and to a JSONL event file the experiments read, so a run that
# recovered from a timeout is reported as exactly that rather than as a clean run.
#
# HOLDING THE LISTENER DOWN ON PURPOSE
#
# The fail-safe experiments need the listener genuinely unavailable. Creating the
# pause file stops the supervisor from restarting it; removing the file lets the
# next cycle bring it back. Without this, a supervisor would silently invalidate
# the very test that intends to hold the listener down.
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/backend"

LOG="${SEAL_SUPERVISOR_LOG:-/tmp/seal-ai-supervisor.log}"
EVENTS="${SEAL_SUPERVISOR_EVENTS:-$REPO/backend/data/listener-supervisor-events.jsonl}"
PAUSE_FILE="${SEAL_SUPERVISOR_PAUSE:-$REPO/backend/data/listener-supervisor.paused}"
LISTENER_LOG="${SEAL_LISTENER_LOG:-/tmp/seal-ai.log}"
BACKOFF_START="${SEAL_SUPERVISOR_BACKOFF_START:-1}"
BACKOFF_MAX="${SEAL_SUPERVISOR_BACKOFF_MAX:-15}"

mkdir -p "$(dirname "$EVENTS")"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

event() {
  # $1 event, $2 exit code (or ""), $3 note
  printf '{"at":"%s","event":"%s","exitCode":%s,"starts":%d,"restarts":%d,"note":"%s"}\n' \
    "$(now)" "$1" "${2:-null}" "$STARTS" "$RESTARTS" "${3:-}" >> "$EVENTS"
  printf '[supervisor %s] %s exit=%s starts=%d restarts=%d %s\n' \
    "$(now)" "$1" "${2:-none}" "$STARTS" "$RESTARTS" "${3:-}" | tee -a "$LOG"
}

STARTS=0
RESTARTS=0
BACKOFF=$BACKOFF_START
CHILD=""
STOPPING=0

shutdown() {
  STOPPING=1
  if [[ -n "$CHILD" ]] && kill -0 "$CHILD" 2>/dev/null; then
    kill -TERM "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
  fi
  event "supervisor-stopped" "0" "asked to stop"
  exit 0
}
trap shutdown SIGTERM SIGINT

event "supervisor-started" "null" "pause file: $PAUSE_FILE"

while true; do
  # A deliberate hold. The listener stays down until the file is removed, so a
  # fail-safe experiment measures a genuinely unavailable listener.
  if [[ -f "$PAUSE_FILE" ]]; then
    sleep 1
    continue
  fi

  STARTS=$((STARTS + 1))
  event "listener-starting" "null" "attempt $STARTS"

  node --env-file-if-exists=../.env src/ai/start.js >> "$LISTENER_LOG" 2>&1 &
  CHILD=$!
  wait "$CHILD"
  CODE=$?
  CHILD=""

  [[ $STOPPING -eq 1 ]] && exit 0

  if [[ $CODE -eq 0 ]]; then
    event "listener-exited-cleanly" "$CODE" "not restarting"
    exit 0
  fi

  RESTARTS=$((RESTARTS + 1))
  event "listener-exited" "$CODE" "restarting after ${BACKOFF}s"
  sleep "$BACKOFF"
  BACKOFF=$(( BACKOFF * 2 ))
  [[ $BACKOFF -gt $BACKOFF_MAX ]] && BACKOFF=$BACKOFF_MAX
done
