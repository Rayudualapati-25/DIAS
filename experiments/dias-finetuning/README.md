# DIAS synthetic fine-tuning data

This package creates model-portable supervised chat data for the off-chain DIAS
recommendation model. It is intentionally separate from the dynamic-policy
workflow fixtures: the LLM recommends, the auditor decides, and active exact
rules are ledger state rather than learned model weights.

## Generate and validate

From the repository root:

```bash
node experiments/dias-finetuning/generate.js --output experiments/dias-finetuning/data-next
node experiments/dias-finetuning/validate.js
```

The default deterministic output is `data-v1/`:

- `train.jsonl`, `valid.jsonl`, `test.jsonl`: three-message chat examples;
- `*.cases.jsonl`: raw governed inputs, labels, provenance, and explanation
  references;
- `workflow-evaluation.jsonl`: sequential system tests, never training data;
- `manifest.json`: counts, hashes, source versions, and limitations.

Use `--output /path/to/new-version --seed N` to create another retained version.
The generator refuses to overwrite a non-empty directory unless `--force` is
explicitly supplied.

## Fine-tuning contract

Each chat example contains:

1. a grounded system prompt;
2. a user prompt with the authenticated subject, ledger record, trusted request
   context, and untrusted natural-language request;
3. one compact JSON recommendation.

The target schema is:

```json
{
  "action": "view",
  "purpose": "investigation",
  "decision": "allow",
  "reasonCode": "POLICY_SATISFIED",
  "policyVersion": "crime-policy-v2",
  "modelVersion": "dias-recommender-v1"
}
```

A replacement model must be measured on the untouched `test.jsonl` split before
deployment. Compare it with the retained Qwen adapter and run subject, record,
and request-context ablations. Do not cite a new model result until its config,
logs, and metrics are retained under `experiments/runs/`.

## Evidence boundary

The labels are synthetic recommendations from the documented offline policy
oracle. They are suitable for reproducible engineering and controlled model
comparison, not claims about actual auditor judgment or real production access
patterns. Training and validation are decision-balanced, while the held-out test
is reason-balanced; neither distribution is an estimate of production traffic.
