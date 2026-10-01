#!/usr/bin/env bash
#
# Start the reuse experiment (testbed/reuse/) after the same checks as start_e6.sh:
#   1. the model server answers, both recorders and the backend run, no load generator runs,
#      and every VM clock is within 1 s of the Mac;
#   2. the backend has no recommendation in preparation;
#   3. the plan and scripts are staged into ~/dias-testbed/reuse (mounted read-only into the
#      containers), the plan's cases and records are seeded (idempotent), and the ledger holds
#      no authorization for any record of the plan;
#   4. the run starts in a detached container under a fresh run name; for the full run the Mac
#      is kept awake until the load generator exits.
# While it runs send nothing else to the model server.
#
# Usage: bash testbed/scripts/start_reuse.sh [--smoke]   (REUSE_PLAN_NAME=<file> picks another smoke plan)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="${HOME}/dias-testbed"
M4="lima-dias-m4"
IMAGE="dias-backend:testbed"
API="http://dias-backend:3001/api"
TRACE="/data/trace/backend-trace.jsonl"
PEERS='{"police":"peer0.police.example.com:7051","forensics":"peer0.forensics.example.com:8051","prosecution":"peer0.prosecution.example.com:9051","court":"peer0.court.example.com:10051","audit":"peer0.audit.example.com:11051"}'

if [ "${1:-}" = "--smoke" ]; then
  KIND="reuse-smoke"; PLAN_NAME="${REUSE_PLAN_NAME:-reuse-smoke-plan.json}"; PACE=(--settle 10000 --cooldown 10000)
else
  KIND="reuse"; PLAN_NAME="reuse-100-users-plan.json"; PACE=(--settle 60000 --cooldown 30000)
fi
PLAN="testbed/reuse/generated/${PLAN_NAME}"
CONTAINER="loadgen-${KIND}"

fail() { echo "NOT STARTED: $*" >&2; exit 1; }
alive() { [ -f "${TB}/logs/$1.pid" ] && kill -0 "$(cat "${TB}/logs/$1.pid")" 2>/dev/null; }

echo "== 1. checks"
[ -f "${REPO}/${PLAN}" ] || fail "${PLAN} does not exist; run node testbed/reuse/plan.js$([ "${KIND}" = reuse-smoke ] && echo ' --smoke')"
curl -sf --max-time 10 -o /dev/null http://127.0.0.1:8081/health || fail "the model server on port 8081 does not answer"
alive model-server || fail "model-server.pid does not point at a running process"
alive mac-sampler || fail "the Mac recorder (mac_sampler.py) is not running"
alive container-sampler || fail "the per-container recorder (docker_stats_sampler.py) is not running"
docker --context "${M4}" ps --format '{{.Names}}' | grep -qx dias-backend || fail "dias-backend is not running on M4"
if docker --context "${M4}" ps --format '{{.Names}}' | grep -q '^loadgen-'; then fail "a load generator is already running"; fi
for vm in dias-m1 dias-m2 dias-m3 dias-m4; do
  python3 - "${vm}" <<'PY' || fail "the clock of ${vm} differs from the Mac by more than 1 s; wait a minute and retry"
import subprocess, sys, time
t0 = time.time()
vm = float(subprocess.run(["limactl", "shell", sys.argv[1], "date", "+%s.%N"], capture_output=True, text=True, check=True).stdout)
skew = vm - (t0 + time.time()) / 2
print(f"{sys.argv[1]} clock minus Mac clock: {skew:+.3f} s")
sys.exit(0 if abs(skew) <= 1.0 else 1)
PY
done

echo "== 2. wait until the backend has no recommendation in preparation"
for attempt in $(seq 1 60); do
  counts="$(docker --context "${M4}" exec dias-backend cat "${TRACE}" | python3 -c '
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
')" || fail "cannot read the backend trace"
  read -r enqueued ready created decided <<< "${counts}"
  [ "${enqueued}" = "${ready}" ] && break
  [ "${attempt}" = 60 ] && fail "the backend queue did not drain (${enqueued} enqueued, ${ready} ready)"
  sleep 5
done
echo "backend trace: ${enqueued} recommendations enqueued, ${ready} ready; ${created} requests, ${decided} decisions"

echo "== 3. stage, seed and check the ledger"
RUN="${KIND}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${TB}/reuse" "${TB}/results/${RUN}"
rsync -a --delete "${REPO}/testbed/reuse/" "${TB}/reuse/"
docker --context "${M4}" compose -f "${TB}/compose/m4.json" run --rm --no-deps -e DIAS_TRACE_FILE= \
  -v "${TB}/reuse:/app/testbed/reuse:ro" dias-backend node testbed/reuse/seed.js --plan "${PLAN}" \
  | tee "${TB}/results/${RUN}/seed.log" || fail "seeding the plan's cases and records failed"
docker --context "${M4}" run --rm --network diasnet \
  -v "${TB}/organizations:/app/network/organizations:ro" -v "${TB}/reuse:/app/testbed/reuse:ro" -v "${TB}/results:/results" \
  -e FABRIC_PEER_ENDPOINTS="${PEERS}" -e CHANNEL=diaschannel -e CHAINCODE=diasrecords -e JWT_SECRET=check \
  "${IMAGE}" node testbed/reuse/check-ledger.js --plan "${PLAN}" --label before --out "/results/${RUN}/ledger-before.json" \
  || fail "the ledger check failed"
python3 -c "import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r['planAuthorizations']==0 else 1)" \
  "${TB}/results/${RUN}/ledger-before.json" || fail "the ledger already holds authorizations for records of this plan"
cat > "${TB}/results/${RUN}/start-notes.json" <<JSON
{"run": "${RUN}", "plan": "${PLAN}", "startedBy": "testbed/scripts/start_reuse.sh",
 "backendTraceBefore": {"enqueued": ${enqueued}, "ready": ${ready}, "requests": ${created}, "decisions": ${decided}},
 "note": "Requests minus decisions in the backend trace: requests granted automatically by an exact-record authorization (they need no auditor decision) plus the two E7 decisions that timed out during the leader failover. The ledger kept one E7 request waiting for an auditor, on a world record outside this plan; it was left as E7 ended."}
JSON

echo "== 4. start ${RUN}"
docker --context "${M4}" rm "${CONTAINER}" > /dev/null 2>&1 || true
docker --context "${M4}" run -d --name "${CONTAINER}" --network diasnet \
  -v dias-backend-data:/data:ro -v "${TB}/results:/results" -v "${TB}/reuse:/app/testbed/reuse:ro" \
  "${IMAGE}" node testbed/reuse/run.js --plan "${PLAN}" --url "${API}" --review-dir /data/dias-reviews \
  --out "/results/${RUN}" "${PACE[@]}" > /dev/null
echo "${RUN}" > "${TB}/logs/${KIND}-run-name"
if [ "${KIND}" = reuse ]; then
  # Keep the Mac awake (no idle, disk or system sleep) until the load generator's container exits.
  nohup bash -c "caffeinate -ims -w \$\$ & while docker --context ${M4} ps --format '{{.Names}}' | grep -qx ${CONTAINER}; do sleep 60; done" \
    > "${TB}/logs/caffeinate-reuse.log" 2>&1 &
  echo $! > "${TB}/logs/caffeinate-reuse.pid"
fi
echo "started ${RUN} at $(date -u +%H:%M:%S) UTC"
echo "follow it:   docker --context ${M4} logs -f ${CONTAINER}"
