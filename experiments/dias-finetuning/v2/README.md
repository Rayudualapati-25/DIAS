# DIAS binary recommendation dataset v2

Supervised fine-tuning and held-out evaluation data for an **advisory** binary
ALLOW/DENY access recommendation model.

The model never grants or denies access. An auditor decides, or an already-active
exact dynamic authorization does. Nothing in this dataset trains the model to
predict an auditor's decision.

## Commands

```bash
node experiments/dias-finetuning/v2/generate.js --seed 20260912
node experiments/dias-finetuning/v2/validate.js
(cd experiments/dias-finetuning/v2 && npm test)
```

Token-length audit (needs the Qwen tokenizer):

```bash
HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/python experiments/dias-finetuning/v2/token_audit.py \
  experiments/dias-finetuning/data-v2-binary experiments/runs/20260912_dias_v7_dataset/token_lengths.json
```

## Layout

| Module | Responsibility |
| --- | --- |
| `lib/rng.js` | Seeded generator with named independent streams |
| `lib/identifiers.js` | Opaque identifiers that encode nothing |
| `lib/world.js` | Districts, stations, role index derived from the bundle |
| `lib/scenarios.js` | Situation constructors, each self-verified against the oracle |
| `lib/justifications.js` | Template families, including the held-out ones |
| `lib/example.js` | One labelled example, prompt built by the live prompt module |
| `lib/families.js` | Scenario families and stable split assignment |
| `lib/plan.js` | How many families of each kind, and the text mix |
| `lib/assemble.js` | Cutting the evaluation sets |
| `lib/writeDataset.js` | Files, manifest, human-review sample |
| `lib/checks.js` | The validator's individual checks |

## Labels

Decision, reason code and policy references come from the offline reference
oracle applied to the verified facts. The two justification-dependent review
flags come from the declaration on the justification family, because the oracle
never sees the text. Both halves are re-derived by the validator from the written
files, so a generator bug fails validation instead of producing a plausible
dataset.

## Output

Each set is written twice: `<set>.jsonl` carries only `messages` (what mlx-lm
reads) and `<set>.cases.jsonl` carries the full audit record — facts, label,
scenario, justification family, hashes. `valid.jsonl` and `test.jsonl` are the
mlx-lm-conventional names for the balanced validation and decision sets.

`manifest.json` records the seed, the policy bundle hash, the prompt and response
schema versions, per-set composition, and the SHA-256 of every source a label
depends on.

`human-review-sample.csv` is a stratified sample prepared for a person to check.
Every row is `pending_manual_review`. **The dataset is not human-reviewed**, and
nothing in this repository says otherwise.

## Known exclusion

`INVALID_PURPOSE` is absent. The API and the chaincode both reject an
out-of-vocabulary purpose before a request is committed, so the live model can
never see one; v1 spent 246 examples on it. See
`docs/policies/policy-open-questions.md` section 7.
