#!/usr/bin/env bash
#
# After a reuse run: check the ledger again (evaluate only), collect the raw results into
# experiments/runs/20260925_reuse_100_users/, and run the analysis.
#
# Usage: bash testbed/scripts/finalize_reuse.sh [--smoke]   (REUSE_PLAN_NAME=<file> picks another smoke plan)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="${HOME}/dias-testbed"
M4="lima-dias-m4"
IMAGE="dias-backend:testbed"
RUNDIR="${REPO}/experiments/runs/20260925_reuse_100_users"
PEERS='{"police":"peer0.police.example.com:7051","forensics":"peer0.forensics.example.com:8051","prosecution":"peer0.prosecution.example.com:9051","court":"peer0.court.example.com:10051","audit":"peer0.audit.example.com:11051"}'

if [ "${1:-}" = "--smoke" ]; then
  KIND="reuse-smoke"; PLAN_NAME="${REUSE_PLAN_NAME:-reuse-smoke-plan.json}"; AN=""
else
  KIND="reuse"; PLAN_NAME="reuse-100-users-plan.json"; AN="${RUNDIR}/analysis"
fi
PLAN="testbed/reuse/generated/${PLAN_NAME}"
RUN="$(cat "${TB}/logs/${KIND}-run-name")"
[ -n "${AN}" ] || AN="${RUNDIR}/analysis-smoke/${RUN}"
OUT="${TB}/results/${RUN}"

fail() { echo "NOT FINALIZED: $*" >&2; exit 1; }
if docker --context "${M4}" ps --format '{{.Names}}' | grep -qx "loadgen-${KIND}"; then fail "loadgen-${KIND} is still running"; fi
[ -s "${OUT}/run.json" ] || fail "${RUN} has no run.json (the run did not finish)"
docker --context "${M4}" logs "loadgen-${KIND}" > "${OUT}/loadgen.log" 2>&1 || true

echo "== ledger check after the run (evaluate only)"
docker --context "${M4}" run --rm --network diasnet \
  -v "${TB}/organizations:/app/network/organizations:ro" -v "${TB}/reuse:/app/testbed/reuse:ro" -v "${TB}/results:/results" \
  -e FABRIC_PEER_ENDPOINTS="${PEERS}" -e CHANNEL=diaschannel -e CHAINCODE=diasrecords -e JWT_SECRET=check \
  "${IMAGE}" node testbed/reuse/check-ledger.js --plan "${PLAN}" --label after --out "/results/${RUN}/ledger-after.json"

echo "== collect ${RUN}"
mkdir -p "${RUNDIR}/raw/${RUN}" "${RUNDIR}/raw/${RUN}/code"
rsync -a "${OUT}/" "${RUNDIR}/raw/${RUN}/"
cp "${REPO}/${PLAN}" "${RUNDIR}/raw/${RUN}/"
rsync -a --exclude generated "${TB}/reuse/" "${RUNDIR}/raw/${RUN}/code/"
docker --context "${M4}" cp dias-backend:/data/trace/backend-trace.jsonl "${RUNDIR}/raw/${RUN}/backend-trace.jsonl"
python3 - "${RUNDIR}/raw/${RUN}" "${TB}/results" <<'PY'
import csv, json, os, sys
out, results = sys.argv[1], sys.argv[2]
run = json.load(open(os.path.join(out, "run.json")))
lo, hi = run["startedAt"] / 1000 - 60, run["finishedAt"] / 1000 + 60
for src, dst in [("containers/container-stats.csv", "container-stats.csv"), ("mac/mac-samples.csv", "mac-samples.csv"),
                 ("mac/power-log.csv", "power-log.csv")]:
    with open(os.path.join(results, src)) as handle, open(os.path.join(out, dst), "w", newline="") as target:
        reader = csv.reader(handle)
        writer = csv.writer(target)
        writer.writerow(next(reader))
        kept = 0
        for row in reader:
            if lo <= float(row[0]) <= hi:
                writer.writerow(row)
                kept += 1
    print(f"{dst}: {kept} samples in the run window")
with open(os.path.join(out, "power-log.csv")) as handle:
    sources = {row["power_source"] for row in csv.DictReader(handle)}
print(f"power source during the run: {sorted(sources)}")
PY

echo "== analysis"
mkdir -p "${AN}"
python3 "${REPO}/testbed/analysis/analyze_reuse.py" --run "${RUNDIR}/raw/${RUN}" --plan "${REPO}/${PLAN}" --out "${AN}" \
  --container-stats "${RUNDIR}/raw/${RUN}/container-stats.csv" --mac-samples "${RUNDIR}/raw/${RUN}/mac-samples.csv" \
  | tee "${AN}/analysis.log"
echo "== done: ${AN}"
