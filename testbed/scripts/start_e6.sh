#!/usr/bin/env bash
#
# Start the one-hour E6 run from the same pre-registered plan, after checking that the testbed is ready:
#   1. the model server answers and both recorders (Mac and per-container) are running;
#   2. the backend has no recommendation still being prepared;
#   3. requests left open by a stopped attempt are closed (the decision follows the stored recommendation)
#      and the backend trace shows every created request has a decision;
#   4. the old loadgen-e6 container is removed and E6 starts under a fresh run name.
# While E6 runs (about 65 minutes) send nothing else to the model server and keep the Mac awake.
set -euo pipefail

TB="${HOME}/dias-testbed"
M4="lima-dias-m4"
IMAGE="dias-backend:testbed"
API="http://dias-backend:3001/api"
TRACE="/data/trace/backend-trace.jsonl"

fail() { echo "NOT STARTED: $*" >&2; exit 1; }
alive() { [ -f "${TB}/logs/$1.pid" ] && kill -0 "$(cat "${TB}/logs/$1.pid")" 2>/dev/null; }
# Prints "<recommendations enqueued> <ready> <requests created> <decisions written>" from the backend trace.
trace_counts() {
  docker --context "${M4}" exec dias-backend cat "${TRACE}" | python3 -c '
import json, sys
n = {"recommendation.enqueued": 0, "recommendation.ready": 0, "CreateAccessRequest": 0, "SubmitAuditorDecision": 0}
for line in sys.stdin:
    event = json.loads(line)
    name = event.get("event")
    if name in n:
        n[name] += 1
    elif name == "fabric.submit" and event.get("successful") and event.get("fn") in n:
        n[event["fn"]] += 1
print(*n.values())
'
}

echo "== 1. checks"
curl -sf --max-time 10 -o /dev/null http://127.0.0.1:8081/health || fail "the model server on port 8081 does not answer"
alive model-server || fail "model-server.pid does not point at a running process (the Mac recorder follows it)"
alive mac-sampler || fail "the Mac recorder (mac_sampler.py) is not running"
alive container-sampler || fail "the per-container recorder (docker_stats_sampler.py) is not running"
docker --context "${M4}" ps --format '{{.Names}}' | grep -qx dias-backend || fail "dias-backend is not running on M4"
if docker --context "${M4}" ps --format '{{.Names}}' | grep -qx 'loadgen-.*'; then fail "a load generator is already running"; fi
# The recorders use the Mac clock and the load generator uses the VM clock; after the Mac sleeps a VM
# clock can lag, which would shift the E6 time window in the CPU and memory graphs.
for vm in dias-m1 dias-m2 dias-m3 dias-m4; do
  python3 - "${vm}" <<'EOF' || fail "the clock of ${vm} differs from the Mac by more than 1 s; wait a minute and retry"
import subprocess, sys, time
t0 = time.time()
vm = float(subprocess.run(["limactl", "shell", sys.argv[1], "date", "+%s.%N"], capture_output=True, text=True, check=True).stdout)
skew = vm - (t0 + time.time()) / 2
print(f"{sys.argv[1]} clock minus Mac clock: {skew:+.3f} s")
sys.exit(0 if abs(skew) <= 1.0 else 1)
EOF
done

echo "== 2. wait until the backend has no recommendation in preparation"
for attempt in $(seq 1 60); do
  counts="$(trace_counts)" || fail "cannot read the backend trace"
  read -r enqueued ready _ _ <<< "${counts}"
  [[ "${enqueued}" =~ ^[0-9]+$ && "${ready}" =~ ^[0-9]+$ ]] || fail "unexpected trace counts: ${counts}"
  [ "${enqueued}" = "${ready}" ] && break
  [ "${attempt}" = 60 ] && fail "the backend queue did not drain (${enqueued} enqueued, ${ready} ready)"
  sleep 5
done

echo "== 3. close requests left open by a stopped attempt"
docker --context "${M4}" run --rm --network diasnet "${IMAGE}" node testbed/load/close-pending.js --url "${API}" \
  || fail "close-pending.js failed"
counts="$(trace_counts)" || fail "cannot read the backend trace"
read -r _ _ created decided <<< "${counts}"
[[ "${created}" =~ ^[0-9]+$ && "${decided}" =~ ^[0-9]+$ ]] || fail "unexpected trace counts: ${counts}"
echo "requests created: ${created} | decisions written: ${decided}"
[ "${created}" = "${decided}" ] || fail "some requests on the ledger still have no decision"

echo "== 4. start E6"
docker --context "${M4}" rm loadgen-e6 > /dev/null 2>&1 || true
RUN="e6-steady-$(date -u +%Y%m%dT%H%M%SZ)"
docker --context "${M4}" run -d --name loadgen-e6 --network diasnet \
  -v dias-backend-data:/data:ro -v "${TB}/results:/results" \
  "${IMAGE}" node testbed/load/run-steady.js --url "${API}" --review-dir /data/dias-reviews \
  --out "/results/${RUN}" --settle 60000 > /dev/null
echo "${RUN}" > "${TB}/logs/e6-run-name"
echo "started ${RUN} at $(date -u +%H:%M:%S) UTC; the workflows end about 63 minutes later"
echo "follow it:   docker --context ${M4} logs -f loadgen-e6"
echo "when done:   bash testbed/scripts/run_remaining.sh   then   bash testbed/scripts/finalize.sh"
