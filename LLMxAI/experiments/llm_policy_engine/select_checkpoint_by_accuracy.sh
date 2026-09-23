#!/bin/bash
# Select the V4 checkpoint by held-out DECISION ACCURACY, not validation loss.
# V3 selected on loss, which for a short templated JSON output is dominated by
# formatting tokens rather than the token that carries the decision - and it
# picked the final checkpoint by default.
set -u
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$REPO" || exit 1
export LLM_POLICY_MODEL_VERSION=qwen3-14b-seba-lora-v4
# Run fully offline: the base model is already in the local HF cache and a hub
# lookup with no network would hang or fail the server start.
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1

ADIR="experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v4"
SEL="experiments/llm_policy_engine/data_v4/valid_selection_120.jsonl"
OUT="experiments/runs/20260902_qwen3_policy_engine_select_v4"
PY="$REPO/.venv/bin"
mkdir -p "$OUT"

# 1. materialise every retained checkpoint as its own adapter directory
CKPTS=()
for w in "$ADIR"/[0-9]*_adapters.safetensors; do
  [ -e "$w" ] || continue
  it=$(basename "$w" | cut -d_ -f1)
  d="$OUT/ckpt_$it"
  mkdir -p "$d"
  cp "$ADIR/adapter_config.json" "$d/adapter_config.json"
  cp "$w" "$d/adapters.safetensors"
  CKPTS+=("$it")
done
echo "checkpoints found: ${CKPTS[*]}"

# 2. one server, adapters routed per request
"$PY/mlx_lm.server" --model mlx-community/Qwen3-14B-4bit --adapter-path "$ADIR" \
  --host 127.0.0.1 --port 8080 --max-tokens 192 \
  --chat-template-args '{"enable_thinking":false}' > "$OUT/server.log" 2>&1 &
SPID=$!
for i in $(seq 1 90); do
  curl -s --max-time 3 http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break
  sleep 10
done
curl -s --max-time 300 http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"mlx-community/Qwen3-14B-4bit","messages":[{"role":"user","content":"ok"}],"max_tokens":1}' >/dev/null

# 3. score each checkpoint on the decision-balanced validation subset
for it in "${CKPTS[@]}"; do
  echo "=== [$(date +%H:%M:%S)] scoring checkpoint $it ==="
  node experiments/llm_policy_engine/evaluate.js \
    --provider openai --url http://127.0.0.1:8080 \
    --model mlx-community/Qwen3-14B-4bit \
    --adapter "$OUT/ckpt_$it" --arm no-rules --seed 42 \
    --data "$SEL" --output "$OUT/valid_$it.json" > /dev/null 2>&1
  echo "=== [$(date +%H:%M:%S)] done $it ==="
done
kill $SPID 2>/dev/null; wait $SPID 2>/dev/null

echo "########## CHECKPOINT SELECTION ##########"
python3 - "$OUT" <<'PY'
import json, sys, glob, os, re
out = sys.argv[1]
rows = []
for f in sorted(glob.glob(os.path.join(out, "valid_*.json"))):
    it = int(re.search(r"valid_(\d+)\.json", f).group(1))
    m = json.load(open(f))["metrics"]
    esc = m["perDecision"]["escalate"]["recall"]
    rows.append((it, m["jointDecisionReasonAccuracy"], m["decisionMacroF1"],
                 esc, m["falseAllowCount"], m["adversarialJointAccuracy"]))
print(f"{'iter':>6}{'joint':>9}{'macroF1':>9}{'escalate':>10}{'falseAllow':>12}{'adversarial':>13}")
for r in rows:
    print(f"{r[0]:>6}{r[1]:>9.3f}{r[2]:>9.3f}{r[3]:>10.3f}{r[4]:>12d}{r[5]:>13.3f}")
if len(set(r[1] for r in rows)) == 1 and len(rows) > 1:
    print("\nWARNING: every checkpoint scored identically - per-request adapter routing "
          "is NOT working; the server is serving one adapter for all requests.")
else:
    best = max(rows, key=lambda r: (r[1], -r[4]))
    print(f"\nBEST by joint accuracy: iter {best[0]}  joint={best[1]:.3f}  escalate={best[3]:.3f}")
    json.dump({"selectedIteration": best[0], "selectionCriterion":
               "maximum held-out joint decision+reason accuracy on a decision-balanced "
               "validation subset (120 examples, 36% adversarial); validation loss not used",
               "candidates": [{"iteration": r[0], "joint": r[1], "decisionMacroF1": r[2],
                               "escalateRecall": r[3], "falseAllows": r[4],
                               "adversarialJoint": r[5]} for r in rows]},
              open(os.path.join(out, "selection_by_accuracy.json"), "w"), indent=2)
PY
