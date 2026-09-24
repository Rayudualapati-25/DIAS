#!/usr/bin/env bash
# Untuned Qwen3-14B-4bit baseline over every DIAS v2 held-out set.
#
# Run under nohup so losing a terminal does not lose six hours of inference.
# Each set is a separate invocation, so a failure costs at most one set, and
# --skip-existing reuses completed prediction files on a rerun.
set -u
cd "$(dirname "$0")/../../.."
OUT="experiments/runs/20260912_dias_qwen3_baseline"
URL="${DIAS_BASELINE_URL:-http://127.0.0.1:8081/v1}"

for SET in validation-balanced test-decision-balanced test-reason-balanced \
           test-adversarial test-ood-paraphrase test-multi-rule; do
  echo "=== $(date -u +%FT%TZ) $SET ==="
  node experiments/dias-finetuning/v2/eval/evaluate.js \
    --label untuned-qwen3-14b-4bit \
    --url "$URL" \
    --sets "$SET" \
    --skip-existing \
    --out "$OUT" || echo "!!! $SET failed with exit $?"
done

echo "=== $(date -u +%FT%TZ) recomputing combined metrics ==="
node experiments/dias-finetuning/v2/eval/evaluate.js \
  --label untuned-qwen3-14b-4bit --url "$URL" --skip-existing --out "$OUT"
echo "=== $(date -u +%FT%TZ) done ==="
