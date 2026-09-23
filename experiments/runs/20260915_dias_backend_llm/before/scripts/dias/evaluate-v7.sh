#!/usr/bin/env bash
#
# Serve a trained V7 adapter and evaluate it on the held-out suite.
#
# V7 gets its own port (8082 by default) so the untuned baseline server on 8081
# stays available for re-runs, and the V6 service on 8080 is never touched.
#
#   nohup scripts/dias/evaluate-v7.sh <adapter-dir> <run-dir> [port] > /dev/null 2>&1 &
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADAPTER="${1:?usage: evaluate-v7.sh <adapter-dir> <run-dir> [port]}"
RUN_DIR="${2:?usage: evaluate-v7.sh <adapter-dir> <run-dir> [port]}"
PORT="${3:-8082}"
cd "$REPO" || exit 1

# mlx_lm.server 0.31.3 does not reliably apply its CLI default adapter when a
# request names `default_model`. Send the adapter explicitly on every request
# and record the absolute path in the evaluation descriptor.
case "$ADAPTER" in
  /*) ;;
  *) ADAPTER="${REPO}/${ADAPTER}" ;;
esac
mkdir -p "$RUN_DIR"
LOG="${RUN_DIR}/evaluation.log"

if [ ! -f "${ADAPTER}/adapters.safetensors" ]; then
  echo "no adapter weights at ${ADAPTER}" | tee -a "$LOG" >&2
  exit 1
fi

ADAPTER_SHA="$(shasum -a 256 "${ADAPTER}/adapters.safetensors" | cut -d' ' -f1)"
echo "=== $(date -u +%FT%TZ) serving ${ADAPTER} (sha256 ${ADAPTER_SHA}) on :${PORT} ===" >> "$LOG"

.venv-qwen-policy/bin/mlx_lm.server \
  --model mlx-community/Qwen3-14B-4bit \
  --adapter-path "${ADAPTER}" \
  --host 127.0.0.1 --port "${PORT}" --max-tokens 512 \
  --chat-template-args '{"enable_thinking":false}' >> "${RUN_DIR}/server.log" 2>&1 &
SERVER_PID=$!
# Stop the server however this script exits, so a failed evaluation does not
# leave a 8 GB process holding the GPU.
trap 'kill "${SERVER_PID}" 2>/dev/null' EXIT

# Wait for it to answer rather than sleeping a guessed interval.
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then break; fi
  sleep 5
done
if ! curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
  echo "server did not become ready on :${PORT}" | tee -a "$LOG" >&2
  exit 1
fi
echo "=== $(date -u +%FT%TZ) server ready ===" >> "$LOG"

for SET in test-decision-balanced test-adversarial test-ood-paraphrase test-multi-rule validation-balanced test-reason-balanced; do
  echo "=== $(date -u +%FT%TZ) ${SET} ===" >> "$LOG"
  node experiments/dias-finetuning/v2/eval/evaluate.js \
    --label qwen3-14b-dias-v7 \
    --url "http://127.0.0.1:${PORT}/v1" \
    --model-id qwen3-14b-dias-v7 \
    --adapter-id "$(basename "${ADAPTER}")" \
    --adapter-hash "${ADAPTER_SHA}" \
    --adapter-path "${ADAPTER}" \
    --sets "${SET}" \
    --skip-existing \
    --out "${RUN_DIR}" >> "$LOG" 2>&1 || echo "!!! ${SET} failed" >> "$LOG"
done

echo "=== $(date -u +%FT%TZ) combined metrics ===" >> "$LOG"
node experiments/dias-finetuning/v2/eval/evaluate.js \
  --label qwen3-14b-dias-v7 --url "http://127.0.0.1:${PORT}/v1" \
  --model-id qwen3-14b-dias-v7 --adapter-id "$(basename "${ADAPTER}")" \
  --adapter-hash "${ADAPTER_SHA}" \
  --adapter-path "${ADAPTER}" \
  --sets test-decision-balanced,test-adversarial,test-ood-paraphrase,test-multi-rule,validation-balanced,test-reason-balanced \
  --skip-existing --out "${RUN_DIR}" >> "$LOG" 2>&1

echo "=== $(date -u +%FT%TZ) prompt ablations ===" >> "$LOG"
node experiments/dias-finetuning/v2/eval/run-ablations.js \
  --label qwen3-14b-dias-v7 --url "http://127.0.0.1:${PORT}/v1" \
  --adapter-path "${ADAPTER}" \
  --set test-decision-balanced --limit 200 --skip-existing \
  --out "${RUN_DIR}/ablations" >> "$LOG" 2>&1 || echo "!!! ablations failed" >> "$LOG"

echo "=== $(date -u +%FT%TZ) done ===" >> "$LOG"
