#!/usr/bin/env bash
#
# Rebuild the analysis tables and figures of the archived September testbed run
# (experiments/runs/20260924_testbed_multivm) from its tracked raw data only.
# Nothing in the archived run is overwritten: output goes to OUT, and
# compare_archived.py checks the rebuilt numbers against the archived ones.
#
# Usage: bash testbed/analysis/rebuild_archived.sh <OUT>
# Needs: Python 3.13 with testbed/analysis/requirements.txt installed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="${REPO}/experiments/runs/20260924_testbed_multivm"
OUT="$(mkdir -p "${1:?usage: rebuild_archived.sh <output directory>}" && cd "$1" && pwd)"
RAW="${RUN}/raw"
E5="e5-burst-20260924T174213Z"
E6="e6-steady-20260925T023853Z"
E7="e7-fault-20260925T043602Z"
E3="e3-ledger-20260925T043602Z"
CONTAINERS="${RAW}/containers/container-stats.csv"
MAC="${RAW}/mac/mac-samples.csv"

cd "${REPO}/testbed/analysis"
FAILED=()
# Run one analysis step; record a failure and continue, so every step that can
# be rebuilt from tracked data is rebuilt.
step() {
  local name="$1"; shift
  if "$@" > "${OUT}/${name}.log" 2> "${OUT}/${name}.err"; then
    rm -f "${OUT}/${name}.err"
  else
    FAILED+=("${name}: $(tail -n 1 "${OUT}/${name}.err")")
  fi
}
# accuracy.py and analyze_e4.py default to the archived evaluation runs
# (20260912_dias_qwen3_baseline, 20260914_dias_qwen3_lora_v7_full_final_eval).
step accuracy python3 accuracy.py --out "${OUT}/accuracy"
step e4 python3 analyze_e4.py --run "${RAW}/e4-llm-alone" --out "${OUT}/e4"
CAP="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['recommendations_per_min'])" "${OUT}/e4/e4-summary.json")"
# E5, E6 and E3 read machine CPU/memory and Fabric metrics from the testbed's
# Prometheus (prom.py, 127.0.0.1:19090). Its database is not in the repository,
# so these steps fail unless that Prometheus is running with the archived data.
step e5 python3 analyze_e5.py --run "${RAW}/${E5}" --out "${OUT}/e5" --container-stats "${CONTAINERS}" --llm-capacity "${CAP}"
step e6 python3 analyze_e6.py --run "${RAW}/${E6}" --mac-samples "${MAC}" --container-stats "${CONTAINERS}" --out "${OUT}/e6"
step e7 python3 analyze_e7.py --run "${RAW}/${E7}" --out "${OUT}/e7"
step e3 python3 analyze_e3.py --run "${RAW}/${E3}" --container-stats "${CONTAINERS}" --out "${OUT}/e3"
step growth python3 ledger_growth.py --probes "${RAW}/probes/probes.jsonl" --counts "${RAW}/probes/counts.json" --out "${OUT}/growth"
step capacity python3 capacity_figure.py --analysis "${OUT}"
step testbed python3 testbed_diagram.py --out "${OUT}/testbed"

echo "== steps that could not be rebuilt from tracked data: ${#FAILED[@]}"
for item in "${FAILED[@]}"; do echo "  ${item}"; done
python3 compare_archived.py --archived "${RUN}/analysis" --rebuilt "${OUT}" || true
