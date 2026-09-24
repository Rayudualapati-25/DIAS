# DIAS Qwen3-14B LoRA training plan

Date: 2026-09-11
Status: ON HOLD since 2026-09-11. Do not run. Training waits for the researcher's
architecture, policy, and dataset review; this plan will be revised after those decisions.
Dataset: `dias-recommendation-dataset-v1` (`experiments/dias-finetuning/data-v1`)
Output contract: `modelVersion` `dias-recommender-v1`, `policyVersion` `crime-policy-v2`

## Objective

Train the first Qwen3-14B adapter on the DIAS recommendation dataset. The
adapter stays advisory: it never grants access and is not deployed by this
iteration. Training and validation loss alone support no accuracy or safety
claim.

## Arms

1. **Baseline:** retained `qwen3-14b-seba-lora-v6-best`
   (`5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe`), served
   with its deployed model-version contract.
2. **Proposed:** `qwen3-14b-dias-lora-v1`, a new LoRA trained only on
   `data-v1/train.jsonl`.

The proposed adapter starts from the base weights, not from V6, so the
comparison measures DIAS-matched training rather than additional V6 updates.
A warm start from V6 is a separate later ablation.

## Fixed training configuration

`experiments/dias-finetuning/train-v1.yaml` keeps the retained V4-V6
hyperparameters; only the data, the initialization, and the iteration count
change.

- Base `mlx-community/Qwen3-14B-4bit`, revision
  `a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4`; MLX 0.32.2, MLX-LM 0.31.3.
- LoRA rank 8, scale 20, dropout 0.05 on the last 16 layers; Adam, constant
  learning rate 1e-5; seed 42 (NumPy batch order and MLX initialization).
- Batch size 1, gradient accumulation 4, prompt-masked loss, gradient
  checkpointing.
- 3,000 iterations = one epoch. MLX-LM 0.31.3 counts `iters` in micro-batches
  and applies an optimizer update every fourth iteration (750 updates).
- `max_seq_length` 1536. The longest example is 1,152 tokens under the Qwen3
  chat template, so nothing is truncated; only the 45-54 completion tokens
  (empty think block, JSON object, end token) contribute to the loss.
- Validation loss every 300 iterations on 100 randomly drawn validation
  examples; checkpoints every 600 iterations.

The V5 config comment calls 1,800 iterations one epoch of 7,200 examples. V4
and V5 both ran MLX-LM 0.31.3 (their `run.json` files), where that is one
quarter of an epoch (450 updates); V4's 1,260 iterations over 5,040 examples
were likewise one quarter. The retained configs and results are unchanged;
this note only prevents repeating the sizing error.

## Checkpoint selection (fixed before training)

Evaluate checkpoints 600, 1200, 1800, 2400, and 3000 with
`experiments/policy-v2-precision/evaluate.js` on its reason-balanced 210-example
validation subset (21 per reason code, every example of the rarest classes).
Select by joint action, purpose, decision, and reason accuracy; then fewer false
allows; then decision accuracy; then the later checkpoint. Validation loss is
recorded but not used because fixed JSON formatting tokens dominate it. The
test split is never consulted during selection.

## Evaluation and ablations (after selection)

On all 1,000 held-out test examples, with identical serving (temperature 0,
192 maximum tokens, thinking disabled):

- proposed versus baseline;
- proposed with the subject, record, and request-context blocks each ablated.

Report schema-valid rate, decision accuracy, joint accuracy, per-reason
accuracy, false allows among non-allow cases, adversarial joint accuracy, and
median and p95 latency.

## Stop conditions

- Stop if the smoke run truncates an example, reports a non-finite loss, or
  runs out of memory.
- Training does not change the deployed V6 adapter, `.env`, the backend
  model-version setting, or the on-chain model registration. Serving the new
  adapter later requires `LLM_POLICY_MODEL_VERSION=dias-recommender-v1`, its
  adapter hash, and a new model activation.

## Evidence

- `experiments/runs/20260911_dias_qwen3_lora_smoke_v1/`: smoke run record and log.
- `experiments/runs/20260911_dias_qwen3_lora_train_v1/`: sequence-length
  preflight, run record, and complete training log.
- Adapter weights are excluded from Git and identified by SHA-256 in the
  selection record.
