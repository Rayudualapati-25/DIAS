#!/usr/bin/env bash
# Evaluate the frozen V7 adapter on the deterministic expanded adversarial set.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADAPTER="${1:-${REPO}/LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7}"
RUN_DIR="${2:-${REPO}/experiments/runs/20260917_dias_expanded_adversarial}"
PORT="${3:-8082}"
cd "${REPO}" || exit 1

case "${ADAPTER}" in
  /*) ;;
  *) ADAPTER="${REPO}/${ADAPTER}" ;;
esac
mkdir -p "${RUN_DIR}"

if [ ! -f "${ADAPTER}/adapters.safetensors" ]; then
  echo "missing adapter weights at ${ADAPTER}" >&2
  exit 1
fi

HASH="$(shasum -a 256 "${ADAPTER}/adapters.safetensors" | cut -d' ' -f1)"
echo "=== $(date -u +%FT%TZ) serving V7 ${HASH} on :${PORT} ===" >> "${RUN_DIR}/evaluation.log"
.venv-qwen-policy/bin/mlx_lm.server \
  --model mlx-community/Qwen3-14B-4bit \
  --adapter-path "${ADAPTER}" \
  --host 127.0.0.1 --port "${PORT}" --max-tokens 512 \
  --chat-template-args '{"enable_thinking":false}' \
  > "${RUN_DIR}/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null; wait "${SERVER_PID}" 2>/dev/null' EXIT

READY=false
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 2
done
if [ "${READY}" != true ]; then
  echo "server did not become ready on :${PORT}" | tee -a "${RUN_DIR}/evaluation.log" >&2
  exit 1
fi

node experiments/dias-finetuning/v2/eval/evaluate.js \
  --label qwen3-14b-dias-v7-expanded-adversarial \
  --url "http://127.0.0.1:${PORT}/v1" \
  --model-id qwen3-14b-dias-v7 \
  --adapter-id qwen3-14b-dias-lora-v7 \
  --adapter-hash "${HASH}" \
  --adapter-path "${ADAPTER}" \
  --dataset experiments/dias-finetuning/adversarial-expanded \
  --sets adversarial-expanded \
  --out "${RUN_DIR}" >> "${RUN_DIR}/evaluation.log" 2>&1

echo "=== $(date -u +%FT%TZ) expanded adversarial evaluation complete ===" >> "${RUN_DIR}/evaluation.log"
