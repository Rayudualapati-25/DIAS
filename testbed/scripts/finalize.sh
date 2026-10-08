#!/usr/bin/env bash
#
# Collect every raw result into the run folder, run all analyses in order, and
# retain structured analyses, figures and observed provenance for later reporting.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="${TB:-${HOME}/dias-testbed}"
RUNDIR="${RUNDIR:?Set RUNDIR to the fresh v3 research run directory}"
CHAINCODE_DEFINITION="${CHAINCODE_DEFINITION:?Supply the deployed testbed querycommitted JSON}"
MODEL_EVIDENCE="${MODEL_EVIDENCE:?Supply the passing testbed smoke JSON}"
BASELINE_RUN="${BASELINE_RUN:?Supply the fresh v3 untuned evaluation directory}"
PROPOSED_RUN="${PROPOSED_RUN:?Supply the fresh v3 proposed evaluation directory}"
[ ! -e "${RUNDIR}/manifest.json" ] || { echo "manifest already exists; retain the earlier run" >&2; exit 1; }
AN="${RUNDIR}/analysis"
A="${REPO}/testbed/analysis"
E5="$(cat "${TB}/logs/e5-run-name")"
E6="$(cat "${TB}/logs/e6-run-name")"
E7="$(cat "${TB}/logs/e7-run-name")"
E3="$(cat "${TB}/logs/e3-run-name")"

echo "== collect raw results"
mkdir -p "${RUNDIR}/raw"
for run in "${E5}" "${E6}" "${E7}" "${E3}" probes mac containers; do
  rsync -a "${TB}/results/${run}/" "${RUNDIR}/raw/${run}/"
done
for aborted in "${TB}"/results/*-ABORTED-*; do
  [ -d "${aborted}" ] && rsync -a "${aborted}" "${RUNDIR}/raw/"
done
docker --context lima-dias-m4 cp dias-backend:/data/trace/backend-trace.jsonl "${RUNDIR}/raw/backend-trace.jsonl"
for run in "${E5}" "${E6}" "${E7}"; do cp "${RUNDIR}/raw/backend-trace.jsonl" "${RUNDIR}/raw/${run}/backend-trace.jsonl"; done
cp "${TB}/logs/remaining.log" "${RUNDIR}/raw/remaining.log" 2>/dev/null || true
# Testbed logs (model server, recorders, VM start-up, start script, paused timers); never backend.env.
mkdir -p "${RUNDIR}/raw/logs" "${RUNDIR}/raw/config"
cp "${TB}"/logs/*.log "${TB}"/logs/*.txt "${TB}"/logs/*-run-name "${RUNDIR}/raw/logs/"
# A snapshot of the network, compose and monitoring configuration the runs used.
cp "${REPO}"/testbed/config/* "${REPO}"/testbed/compose/*.json "${REPO}/testbed/monitor/prometheus.yml" "${RUNDIR}/raw/config/"
cp "${REPO}/testbed/load/generated/"*.json "${RUNDIR}/raw/" 2>/dev/null || true
mkdir -p "${RUNDIR}/raw/plans" && mv "${RUNDIR}"/raw/*plan*.json "${RUNDIR}"/raw/users.json "${RUNDIR}/raw/plans/" 2>/dev/null || true

CONTAINERS="${RUNDIR}/raw/containers/container-stats.csv"
MAC="${RUNDIR}/raw/mac/mac-samples.csv"

echo "== verify the workflow runs (complete, planned facts, no prompt reuse, AC power, no recorder gaps)"
for run in "${E6}" "${E7}"; do
  plan="steady-plan.json"; [ "${run}" = "${E7}" ] && plan="fault-plan.json"
  python3 "${REPO}/testbed/scripts/verify_run.py" --run "${RUNDIR}/raw/${run}" \
    --plan "${REPO}/testbed/load/generated/${plan}" --trace "${RUNDIR}/raw/backend-trace.jsonl" \
    --power-log "${RUNDIR}/raw/mac/power-log.csv" --mac-samples "${MAC}" --container-stats "${CONTAINERS}" \
    > "${RUNDIR}/raw/${run}/verify.log"
done

echo "== analyses"
cd "${A}"
mkdir -p "${AN}"
python3 accuracy.py --baseline "${BASELINE_RUN}" --proposed "${PROPOSED_RUN}" --out "${AN}/accuracy" > "${AN}/accuracy.log"
python3 analyze_e4.py --run "${RUNDIR}/raw/e4-llm-alone" --reference-run "${PROPOSED_RUN}" --out "${AN}/e4" > "${AN}/e4.log"
CAP="$(python3 -c "import json;print(json.load(open('${AN}/e4/e4-summary.json'))['recommendations_per_min'])")"
python3 analyze_e5.py --run "${RUNDIR}/raw/${E5}" --out "${AN}/e5" --container-stats "${CONTAINERS}" --llm-capacity "${CAP}" > "${AN}/e5.log"
cp "${RUNDIR}/raw/${E5}/replay-errors.json" "${AN}/e5/replay-errors.json" 2>/dev/null || true
python3 analyze_e6.py --run "${RUNDIR}/raw/${E6}" --mac-samples "${MAC}" --container-stats "${CONTAINERS}" --out "${AN}/e6" > "${AN}/e6.log"
python3 analyze_e7.py --run "${RUNDIR}/raw/${E7}" --out "${AN}/e7" > "${AN}/e7.log"
python3 analyze_e3.py --run "${RUNDIR}/raw/${E3}" --container-stats "${CONTAINERS}" --out "${AN}/e3" > "${AN}/e3.log"

echo "== ledger growth (request and decision counts from the run files, checked against the backend trace)"
MODEL_EVIDENCE="${MODEL_EVIDENCE}" python3 - "${RUNDIR}" "${E5}" "${E6}" "${E7}" "${E3}" <<'EOF'
import glob, json, os, sys
rundir, e5, e6, e7, e3 = sys.argv[1:6]
def rows(path):
    return [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
def counted(name):
    rs = rows(os.path.join(rundir, "raw", name, "requests.jsonl"))
    return (sum(1 for r in rs if r.get("submitStatus") == 202), sum(1 for r in rs if r.get("decisionStatus") == 201))
add = lambda a, b: (a[0] + b[0], a[1] + b[1])
smoke_report = json.load(open(os.environ["MODEL_EVIDENCE"]))
smoke_rows = smoke_report["rows"]
smoke = (sum(r.get("submitStatus") == 202 for r in smoke_rows),
         sum(r.get("decisionStatus") == 201 for r in smoke_rows))
# Each stopped E6 attempt left its written rows on the ledger plus the requests still open when it stopped
# (not written as rows; counted from the backend trace into its ABORTED.json). All of them were closed with a
# decision before the reported E6 started.
aborted = (0, 0)
for folder in glob.glob(os.path.join(rundir, "raw", "*ABORTED*")):
    note = json.load(open(os.path.join(folder, "ABORTED.json")))
    n = sum(1 for r in rows(os.path.join(folder, "requests.jsonl")) if r.get("submitStatus") == 202)
    n += note["requests_on_ledger_not_in_rows"]
    aborted = add(aborted, (n, n))
e3rows = rows(os.path.join(rundir, "raw", e3, "transactions.jsonl"))
e3n = (sum(1 for r in e3rows if r.get("round") == "W1" and r.get("ok")),
       sum(1 for r in e3rows if r.get("round") == "W2" and r.get("ok")))
after_e5 = add(smoke, counted(e5))
after_e6 = add(add(after_e5, aborted), counted(e6))
after_e7 = add(after_e6, counted(e7))
after_e3 = add(after_e7, e3n)
# Everything up to E7 went through the backend, whose trace logs every successful ledger write.
trace = {"CreateAccessRequest": 0, "SubmitAuditorDecision": 0}
for event in rows(os.path.join(rundir, "raw", "backend-trace.jsonl")):
    if event.get("event") == "fabric.submit" and event.get("successful") and event.get("fn") in trace:
        trace[event["fn"]] += 1
check = (trace["CreateAccessRequest"], trace["SubmitAuditorDecision"])
print("after E7 from run files:", after_e7, "| from the backend trace:", check)
if check != after_e7:
    sys.exit("ledger count check failed: the run files and the backend trace disagree")
counts = {label: {"requests": value[0], "decisions": value[1]} for label, value in
          [("after-e5", after_e5), ("after-e6", after_e6), ("after-e7", after_e7), ("after-e3", after_e3)]}
json.dump(counts, open(os.path.join(rundir, "raw", "probes", "counts.json"), "w"), indent=2)
print(counts)
EOF
python3 ledger_growth.py --probes "${RUNDIR}/raw/probes/probes.jsonl" --counts "${RUNDIR}/raw/probes/counts.json" --out "${AN}/growth" > "${AN}/growth.log"
python3 capacity_figure.py --analysis "${AN}" > "${AN}/capacity.log"
python3 testbed_diagram.py --out "${AN}/testbed"

echo "== manifest"
python3 "${REPO}/testbed/scripts/capture_manifest.py" --out "${RUNDIR}/manifest.json" \
  --chaincode-definition "${CHAINCODE_DEFINITION}" --model-evidence "${MODEL_EVIDENCE}"
# The previous report/manuscript generators contain September-specific system
# descriptions. Keep them for archived reproduction; new v3 reporting belongs
# to steps 17–18 and must be derived from this run's manifest and summaries.
echo "== done: structured results in ${AN}, provenance in ${RUNDIR}/manifest.json"
