#!/usr/bin/env bash
#
# Evaluate every saved LoRA checkpoint of one training run on the validation
# selection suite and report the best by decision accuracy (ties: joint accuracy,
# then lower false-allow rate, then the later checkpoint). Mirrors the V4 procedure.
#
# Usage: select_checkpoint.sh <adapter-dir> <selection-jsonl> <run-dir>
#   env: LLM_POLICY_MODEL_VERSION (must match the dataset), MLX_URL (default :8080)
set -euo pipefail

ADAPTER_DIR="$1"; SELECTION="$2"; RUN_DIR="$3"
MLX_URL="${MLX_URL:-http://127.0.0.1:8080}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$RUN_DIR"

for weights in "$ADAPTER_DIR"/[0-9]*_adapters.safetensors; do
  step="$(basename "$weights" | cut -d_ -f1)"
  ckpt="$RUN_DIR/ckpt_${step}"
  mkdir -p "$ckpt"
  cp "$ADAPTER_DIR/adapter_config.json" "$ckpt/adapter_config.json"
  cp "$weights" "$ckpt/adapters.safetensors"
  if [ -s "$RUN_DIR/valid_${step}.json" ]; then
    echo "skip ${step}: already evaluated"; continue
  fi
  echo "== evaluating checkpoint ${step} =="
  node "$HERE/evaluate.js" --provider openai --url "$MLX_URL" \
    --model mlx-community/Qwen3-14B-4bit --adapter "$ckpt" --arm no-rules \
    --data "$SELECTION" --output "$RUN_DIR/valid_${step}.json" | tail -3
done

node - "$RUN_DIR" <<'JS'
const fs = require('fs'); const path = require('path');
const runDir = process.argv[2];
const rows = fs.readdirSync(runDir).filter((f) => /^valid_\d+\.json$/.test(f)).map((f) => {
  const { metrics } = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
  return { step: Number(f.match(/\d+/)[0]), ...metrics };
}).sort((a, b) => a.step - b.step);
for (const r of rows) {
  console.log(`step ${String(r.step).padStart(5)}  decision ${(r.decisionAccuracy*100).toFixed(1)}%  joint ${(r.jointDecisionReasonAccuracy*100).toFixed(1)}%  falseAllow ${(r.falseAllowRateAmongNonAllow*100).toFixed(1)}%  adversarial ${(r.adversarialJointAccuracy*100).toFixed(1)}%`);
}
const best = [...rows].sort((a, b) => (b.decisionAccuracy - a.decisionAccuracy)
  || (b.jointDecisionReasonAccuracy - a.jointDecisionReasonAccuracy)
  || (a.falseAllowRateAmongNonAllow - b.falseAllowRateAmongNonAllow)
  || (b.step - a.step))[0];
fs.writeFileSync(path.join(runDir, 'selection_by_accuracy.json'), JSON.stringify({
  selectedAtUtc: new Date().toISOString(), criterion: 'decisionAccuracy, jointDecisionReasonAccuracy, -falseAllowRate, step',
  selectedStep: best.step, candidates: rows,
}, null, 2) + '\n');
console.log(`\nSELECTED step ${best.step}`);
JS
