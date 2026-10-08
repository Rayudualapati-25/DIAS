#!/usr/bin/env bash
#
# Run the remaining testbed experiments back to back, after E6 has finished:
#   replay of the E5 recommendation errors (determinism check), probe after E6,
#   E7 fault test, probe after E7, E4 model alone, E3 ledger alone, probe after E3.
# The chain stops at the first failed step and runs nothing after it, so no test
# runs on a degraded network or is mixed with a failed one.
# Everything is logged to ~/dias-testbed/logs/remaining.log.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="${TB:-${HOME}/dias-testbed}"
RUNDIR="${RUNDIR:?Set RUNDIR to the fresh v3 research run directory}"
E5="$(cat "${TB}/logs/e5-run-name")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
E7="e7-fault-${STAMP}"
E3="e3-ledger-${STAMP}"
E4_OUT="${RUNDIR}/raw/e4-llm-alone"
PEERS='{"police":"peer0.police.example.com:7051","forensics":"peer0.forensics.example.com:8051","prosecution":"peer0.prosecution.example.com:9051","court":"peer0.court.example.com:10051","audit":"peer0.audit.example.com:11051"}'
ADAPTER="${REPO}/LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7"

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "${TB}/logs/remaining.log"; }
fail() { log "FAILED: $*; the remaining steps were not run"; exit 1; }

probe() {
  docker --context lima-dias-m4 run --rm --network diasnet \
    -v "${TB}/organizations:/app/network/organizations:ro" -v "${TB}/results:/results" \
    -e FABRIC_PEER_ENDPOINTS="${PEERS}" -e CHANNEL=diaschannel -e CHAINCODE=diasrecords -e JWT_SECRET=probe \
    dias-backend:testbed node testbed/load/probe-reads.js --label "$1" --out /results/probes \
    >> "${TB}/logs/remaining.log" 2>&1 || fail "probe $1"
  log "probe $1 done"
}

[ -e "${E4_OUT}" ] && fail "${E4_OUT} already exists; move it aside before running E4 again"
log "start (E5=${E5}, E7=${E7}, E3=${E3})"

# 1. Determinism check of the E5 errors (the model server is idle now).
docker --context lima-dias-m4 run --rm --network diasnet \
  -v dias-backend-data:/data:ro -v "${TB}/keys:/run/dias-keys:ro" -v "${TB}/results:/results" --env-file "${TB}/backend.env" \
  -e DIAS_TRACE_FILE= --add-host host.lima.internal:192.168.104.2 \
  dias-backend:testbed node testbed/load/replay-errors.js \
  --rows "/results/${E5}/requests.jsonl" \
  --out "/results/${E5}/replay-errors.json" >> "${TB}/logs/remaining.log" 2>&1 || fail "replay of the E5 errors"
[ -s "${TB}/results/${E5}/replay-errors.json" ] || fail "the replay wrote no replay-errors.json"
log "replay of E5 errors done"

# 2. Ledger size after E6.
probe after-e6

# 3. E7 fault test (it restores every orderer and peer itself, even when it fails).
mkdir -p "${TB}/results/${E7}"
python3 "${REPO}/testbed/scripts/run_fault_test.py" --out "${TB}/results/${E7}" --run-name "${E7}" \
  >> "${TB}/logs/remaining.log" 2>&1 || fail "E7 fault test (see ${TB}/results/${E7}/fault-timeline.json)"
echo "${E7}" > "${TB}/logs/e7-run-name"
log "E7 done: ${E7}"
sleep 30
probe after-e7

# 4. E4 the model alone on the 600 balanced test cases (on the Mac).
(cd "${REPO}" && node experiments/dias-finetuning/v2/eval/evaluate.js \
  --label qwen3-14b-dias-v7-testbed-llm-alone --url http://127.0.0.1:8081/v1 \
  --prompt v2 \
  --model-id qwen3-14b-dias-v7 --adapter-id qwen3-14b-dias-lora-v7 \
  --adapter-hash "$(shasum -a 256 "${ADAPTER}/adapters.safetensors" | cut -d' ' -f1)" \
  --adapter-path "${ADAPTER}" --sets test-decision-balanced \
  --out "${E4_OUT}" >> "${TB}/logs/remaining.log" 2>&1) || fail "E4 model-alone evaluation"
[ -s "${E4_OUT}/metrics.json" ] || fail "E4 wrote no metrics.json"
log "E4 done"
sleep 20

# 5. E3 the ledger alone.
docker --context lima-dias-m4 run --name loadgen-e3 --network diasnet \
  -v "${TB}/organizations:/app/network/organizations:ro" -v "${TB}/results:/results" \
  -e FABRIC_PEER_ENDPOINTS="${PEERS}" -e CHANNEL=diaschannel -e CHAINCODE=diasrecords -e JWT_SECRET=ledger \
  dias-backend:testbed node testbed/load/run-ledger.js --out "/results/${E3}" \
  >> "${TB}/logs/remaining.log" 2>&1 || fail "E3 ledger test"
echo "${E3}" > "${TB}/logs/e3-run-name"
log "E3 done: ${E3}"
sleep 30
probe after-e3

log "ALL REMAINING EXPERIMENTS DONE"
