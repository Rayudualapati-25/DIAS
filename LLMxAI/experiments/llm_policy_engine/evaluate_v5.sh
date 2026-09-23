#!/usr/bin/env bash
#
# Post-training pipeline for the V5 adapter:
#   1. checkpoint selection on data_v5/valid_selection_120.jsonl
#   2. promote the selected checkpoint to adapters/qwen3-14b-seba-lora-v5-best
#   3. evaluate V5-best and V4-best on the retained V4 suite and the new V5 suite
#      (balanced-60 metrics are derived from the full-360 rows by subset, not re-run)
#   4. V5 subject-ablation on the V5 balanced-60 suite
# Run from the LLMxAI directory with the MLX server up on :8080.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENGINE=experiments/llm_policy_engine
ADAPTER_V5=$ENGINE/adapters/qwen3-14b-seba-lora-v5
BEST_V5=$ENGINE/adapters/qwen3-14b-seba-lora-v5-best
BEST_V4=$ENGINE/adapters/qwen3-14b-seba-lora-v4-best
SELECT_RUN=experiments/runs/20260904_qwen3_policy_engine_select_v5
EVAL_RUN=experiments/runs/20260904_qwen3_policy_engine_eval_v5
MLX="${MLX_URL:-http://127.0.0.1:8080}"
mkdir -p "$EVAL_RUN"

echo "### 1. checkpoint selection"
LLM_POLICY_MODEL_VERSION=qwen3-14b-seba-lora-v5 \
  bash $ENGINE/select_checkpoint.sh "$ADAPTER_V5" $ENGINE/data_v5/valid_selection_120.jsonl "$SELECT_RUN"
STEP=$(node -e "console.log(require('./$SELECT_RUN/selection_by_accuracy.json').selectedStep)")
PADDED=$(printf '%07d' "$STEP")

echo "### 2. promote checkpoint $STEP -> $BEST_V5"
mkdir -p "$BEST_V5"
cp "$ADAPTER_V5/adapter_config.json" "$BEST_V5/adapter_config.json"
cp "$ADAPTER_V5/${PADDED}_adapters.safetensors" "$BEST_V5/adapters.safetensors"
shasum -a 256 "$BEST_V5/adapters.safetensors" | cut -d' ' -f1 > "$BEST_V5/adapter.sha256"
echo "adapter sha256: $(cat "$BEST_V5/adapter.sha256")"

run_eval() { # run_eval <model-version> <adapter> <arm> <data> <output>
  if [ -s "$5" ]; then echo "skip $(basename "$5"): exists"; return; fi
  LLM_POLICY_MODEL_VERSION="$1" node $ENGINE/evaluate.js --provider openai --url "$MLX" \
    --model mlx-community/Qwen3-14B-4bit --adapter "$2" --arm "$3" --data "$4" --output "$5" | tail -1 >/dev/null
  node -e "const m=require('./$5').metrics; console.log('$(basename "$5")', 'decision', m.decisionAccuracy, 'joint', m.jointDecisionReasonAccuracy, 'falseAllow', m.falseAllowRateAmongNonAllow, 'adv', m.adversarialJointAccuracy)"
}

echo "### 3. evaluation arms"
run_eval qwen3-14b-seba-lora-v5 "$BEST_V5" no-rules $ENGINE/data_v4/test.jsonl "$EVAL_RUN/v5_on_v4test_full360.json"
run_eval qwen3-14b-seba-lora-v5 "$BEST_V5" no-rules $ENGINE/data_v5/test.jsonl "$EVAL_RUN/v5_on_v5test_full360.json"
run_eval qwen3-14b-seba-lora-v4 "$BEST_V4" no-rules $ENGINE/data_v5/test.jsonl "$EVAL_RUN/v4_on_v5test_full360.json"
echo "### 4. V5 subject ablation (balanced 60)"
run_eval qwen3-14b-seba-lora-v5 "$BEST_V5" subject-ablation $ENGINE/data_v5/test_balanced_60.jsonl "$EVAL_RUN/v5_on_v5balanced60_subject_ablation.json"
echo "### done"
