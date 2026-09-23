#!/usr/bin/env bash
# Train and identically evaluate the three bounded overnight seed pilots.
# This is intentionally not the full 5,254-example robustness experiment.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${1:-${REPO}/experiments/runs/20260916_dias_seed_pilot}"
PORT="${2:-8081}"
mkdir -p "${ROOT}"
cd "${REPO}" || exit 1

for SEED in 17 42 73; do
  CONFIG="experiments/dias-finetuning/pilot-seed-${SEED}.yaml"
  RUN_DIR="${ROOT}/seed-${SEED}/training"
  echo "=== $(date -u +%FT%TZ) train seed ${SEED} ==="
  if ! scripts/dias/train-v7.sh "${CONFIG}" "${RUN_DIR}"; then
    echo "seed ${SEED} training failed; stopping rather than repeating a systemic failure"
    exit 1
  fi
done

for SEED in 17 42 73; do
  ADAPTER="${REPO}/LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-pilot-seed-${SEED}"
  EVAL_DIR="${ROOT}/seed-${SEED}/evaluation"
  mkdir -p "${EVAL_DIR}"
  HASH="$(shasum -a 256 "${ADAPTER}/adapters.safetensors" | cut -d' ' -f1)"
  echo "=== $(date -u +%FT%TZ) evaluate seed ${SEED} adapter ${HASH} ==="
  .venv-qwen-policy/bin/mlx_lm.server \
    --model mlx-community/Qwen3-14B-4bit \
    --adapter-path "${ADAPTER}" \
    --host 127.0.0.1 --port "${PORT}" --max-tokens 512 \
    --chat-template-args '{"enable_thinking":false}' \
    > "${EVAL_DIR}/server.log" 2>&1 &
  SERVER_PID=$!
  READY=false
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      READY=true
      break
    fi
    sleep 2
  done
  if [ "${READY}" != true ]; then
    kill "${SERVER_PID}" 2>/dev/null
    echo "seed ${SEED} model server did not become ready"
    exit 1
  fi
  node experiments/dias-finetuning/v2/eval/evaluate.js \
    --label "qwen3-14b-dias-pilot-seed-${SEED}" \
    --url "http://127.0.0.1:${PORT}/v1" \
    --model-id "qwen3-14b-dias-pilot-seed-${SEED}" \
    --adapter-id "qwen3-14b-dias-pilot-seed-${SEED}" \
    --adapter-hash "${HASH}" \
    --adapter-path "${ADAPTER}" \
    --sets validation-balanced --limit 120 \
    --out "${EVAL_DIR}" > "${EVAL_DIR}/evaluation.log" 2>&1
  STATUS=$?
  kill "${SERVER_PID}" 2>/dev/null
  wait "${SERVER_PID}" 2>/dev/null
  if [ "${STATUS}" -ne 0 ]; then
    echo "seed ${SEED} evaluation failed; see ${EVAL_DIR}/evaluation.log"
    exit "${STATUS}"
  fi
done

echo "=== $(date -u +%FT%TZ) all seed pilots complete ==="

