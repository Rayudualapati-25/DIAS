# Policy-v2 precision experiment

Date: 2026-09-05. Status: running. No accuracy claim is made before evaluation.

## Problem and scope

V4/V5 retained data encode policy v1; the running source now uses policy v2 and expanded roles. The chaincode decision protocol also still maps two v2 denial reasons to escalation. Correct that contract drift, then measure policy-aligned inference and a new adapter. Preserve old datasets, adapters and results.

## Fixed experiment

- Source of labels: current chaincode policy evaluator; hash its source and tables.
- New synthetic dataset: 1,200 training, 100 validation, 200 untouched test examples; reason-stratified, all current roles, isolated and interacting restrictions, held-out query templates and identifiers. Labels are software-policy labels, not legal judgments.
- Baseline: current V4 with current short runtime prompt.
- Prompt-only arm: same V4, explicit ordered policy plus the requesting role's complete permission row and exception lists.
- Candidate V6: continue V4 LoRA on new training data with the explicit policy prompt, 300 steps, rank/layers unchanged, seed 42. Keep checkpoints at 150 and 300. Choose using validation, never final test.
- Ablations: candidate without explicit policy; candidate without trusted subject (validation subsets). Compare prompt-only against candidate to isolate training benefit.
- Retain raw predictions, strict schema failures, action/purpose errors, decision+reason joint accuracy, ALLOW precision, false ALLOW count/denominator, guard referrals, and inference latency. Score the raw model separately from the guarded pipeline.
- Promotion requires zero observed guarded false allows, better joint accuracy than the short-prompt baseline, no regression against prompt-only on validation and final test, no extra raw false allows, valid output contract, and integration checks. Zero observed failures is not a universal safety proof. No model promotion if any gate fails.

## Reproduction and retention

Scripts and new data live under `experiments/policy-v2-precision/`; run artifacts under `experiments/runs/20260905_policy_v2_precision/`; comparison CSV under `results/tables/policy-v2-precision/`; iteration report 026. Historical evaluations are not rescored under the changed policy. Training and test queries are synthetic and contain no real case content.

## Follow-up if weak

Treat explanations for regression (capacity, redundant target tokens, curriculum) as hypotheses. Test them independently in later experiments rather than claiming the cause from training loss or character counts.
