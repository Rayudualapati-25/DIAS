> **This document describes the SEAL-era (V1–V6) model line and is retained for
> provenance.** It does not describe DIAS.
>
> In SEAL the model was a three-class semantic classifier (`allow` / `deny` /
> `escalate`), the deterministic policy was recomputed by both the AI service and
> the chaincode, and a model/policy disagreement became `ESCALATE`. **DIAS
> removed all of that**: the model recommends `ALLOW` or `DENY` only, nothing
> re-evaluates its answer at runtime, and an auditor decides.
>
> For DIAS, read instead:
> [`../../../docs/architecture.md`](../../../docs/architecture.md),
> [`../../../experiments/dias-finetuning/v2/README.md`](../../../experiments/dias-finetuning/v2/README.md),
> and [`../../../docs/training-configuration.md`](../../../docs/training-configuration.md).
>
> The V6 adapter itself is still live evidence and must not be modified: its
> digest is `5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe`.

# Qwen3-14B policy-engine experiments

This directory contains the training and evaluation package for the standalone
LLMxAI policy model. In SEAL the fine-tuned model is a semantic classifier, not
the unilateral authorization authority. The deployed deterministic policy is
recomputed by the AI service and independently by Fabric chaincode; any compact
model/policy disagreement becomes `ESCALATE`.

## Data and training

The V4 dataset is decision-balanced for training and validation, with a
reason-balanced held-out test. It combines trusted subject attributes, trusted
resource attributes, trusted emergency flags, and an untrusted natural-language
query. The query never supplies identity, role, clearance, assignment, or
resource state.

```bash
SEBA_DATA_DIR=data_v4 SEBA_BALANCE=decision \
  node experiments/llm_policy_engine/generate_dataset.js

SEBA_DATA_DIR=data_v4 \
SEBA_AUDIT_OUTPUT=experiments/runs/new_audit/report.json \
  node experiments/llm_policy_engine/audit_dataset.js

.venv/bin/python experiments/llm_policy_engine/run_training.py \
  --config experiments/llm_policy_engine/train_config_v4.yaml \
  --run-dir experiments/runs/new_training_run
```

The retained selected adapter is
`adapters/qwen3-14b-seba-lora-v4-best/adapters.safetensors`. Verify it before
serving:

```bash
shasum -a 256 \
  experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v4-best/adapters.safetensors
```

Expected SHA-256:
`bdb012513c123311821a8f2a7c10c290dd6dfa52dd51632954484aac2efc873b`.

## Evaluation

From the repository root, start the registered artifact with `make model`.
Retained historical experiments below used the earlier no-rules arm; the active
SEAL runtime now supplies the current ordered policy and authenticated role row
to reduce rule-order errors while preserving the same adapter:

```bash
node experiments/llm_policy_engine/evaluate.js \
  --provider openai \
  --url http://127.0.0.1:8080 \
  --model mlx-community/Qwen3-14B-4bit \
  --adapter experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v4-best \
  --arm no-rules \
  --data experiments/llm_policy_engine/data_v4/test_balanced_60.jsonl \
  --output experiments/runs/new_evaluation/proposed.json
```

Use `--arm subject-ablation` to remove the trusted subject block. The untuned
`no-rules` and `rules-prompt` baselines are retained for comparison. Never cite
metrics unless the corresponding JSON run exists.

Historical manifests and logs may mention the source repository or its earlier
Fabric integration. They are retained as provenance from the actual completed
runs; the current standalone runtime does not use those components.
