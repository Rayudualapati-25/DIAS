# DIAS fine-tuning dataset plan

Date: 2026-09-11

## Objective

Create a new, deterministic, model-portable synthetic dataset for fine-tuning
the off-chain DIAS recommendation model. The dataset must represent the complete
governed subject, request, and record context used by the pivoted architecture.
It does not grant access and it does not train the on-chain dynamic-policy
matcher. Final authority remains with an auditor unless an active exact dynamic
rule matches.

The existing `policy-v2-precision` dataset and selected Qwen adapter are retained
unchanged as the reproducible baseline.

## Hypothesis and stopping rule

If a future model is fine-tuned with complete DIAS request contexts, then it
should produce more reliable structured recommendations on held-out identities,
cases, phrasings, and adversarial requests because the training representation
matches the deployed request model.

No improvement is claimed by dataset generation alone. A future model may be
adopted only after a fixed held-out evaluation compares it with the retained
Qwen baseline and after the required feature ablations are run.

## Dataset products

1. Chat-format `train.jsonl`, `valid.jsonl`, and `test.jsonl` for supervised
   fine-tuning.
2. Raw `*.cases.jsonl` files with source fields, expected recommendation,
   explanation evidence, provenance, and group identifiers.
3. A workflow-only test set for sequential auditor/dynamic-policy evaluation.
   It must not be mixed into recommendation-model training.
4. A manifest containing deterministic seeds, counts, class distributions,
   source hashes, output hashes, and stated limitations.

## Split contract

- No username, case ID, record ID, or structural fingerprint may cross splits.
- Natural-language templates are split-specific.
- Training and validation are balanced by recommendation decision so the model
  cannot minimize loss by learning the majority `DENY` class. The held-out test
  set is balanced by reason code for interpretable per-reason reporting.
- At least 20 percent of examples contain untrusted-text attacks or misleading
  identity claims.
- Synthetic usernames are never a causal label feature.

Initial fixed split sizes are 3,000 training examples (1,000 per decision), 500
validation examples (approximately equal per decision), and 1,000 held-out test
examples (100 per reason code). These sizes are an engineering starting point,
not a claim of statistical sufficiency. Learning curves and error analysis must
determine whether later expansion is useful.

## Required coverage

- all operational roles and organizations;
- allow, deny, and escalate recommendations;
- every current recommendation reason code;
- all DIAS fingerprint subject, request, and record fields;
- simple, multi-condition, and adversarial prompts;
- ordered workflow sequences for every auditor/LLM decision combination;
- exact repeats, one-field near misses, rule revocation, and LLM failure.

## Verification

- generate twice with the same seed and compare hashes;
- validate JSONL structure and exact output schema;
- validate split isolation and class quotas;
- run repository tests after adding the data tooling;
- record results under `experiments/runs/`, `results/tables/`, and
  `reports/iteration/`.

## Known limitation

All labels are synthetic reference recommendations generated from the documented
research policy. Simulated auditor decisions are workflow fixtures, not evidence
of real human judgment. Publication claims about real governance require a
separately approved, expert-reviewed dataset.
