# DIAS V7 completion plan

**Date:** 2026-09-12
**Branch:** `dias-v7-completion`
**Status:** phases 0–6 complete; the 1,600-example candidate and corrected evaluation are complete, and the fresh 5,254-example run finished successfully at 2026-09-14T04:24:29Z. Iteration 4,500 was selected using validation loss only; frozen held-out evaluation of both the final and selected checkpoints is in progress. The candidate failed the false-ALLOW activation gates and remains undeployed.

## Objective

Finish the DIAS implementation and train a fresh V7 advisory recommender, with
every claim backed by an artifact in the repository.

The architecture is fixed and non-negotiable: the model recommends ALLOW or
DENY, a human auditor decides, and only an auditor's override of a model DENY
creates a reusable exact-record authorization.

## Phases

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Preserve and audit the existing work | done — `20260912_dias_v7_completion_preflight/` |
| 1 | Wire `backend/src/dias/` into the runtime; fix the method mismatch | done — commit `3f4c3e1` |
| 2 | Complete the policy package | done — commit `4d32db1` |
| 3 | Binary dataset v2 | done — commit `a020f7f` |
| 4 | Live Fabric deployment and acceptance | done — commit `b573ff9`, 15/15 scenarios |
| 5 | Untuned Qwen3-14B baseline | done — 2,699 evaluations |
| 6 | V7 training configuration and run | done — fresh 5,254-example run completed with exit code 0 in `20260913_dias_qwen3_lora_v7_full/` |
| 7 | Evaluation, ablations, V6 reference | corrected candidate evaluation and six prompt ablations done; final and validation-selected full-data checkpoint evaluation in progress |
| 8 | Activation, gated on evidence | not started |

## The measured constraint that shapes phases 6 and 7

One pass over the full 5,254-example training pool is **10,586,206 tokens**,
because the prompt carries the complete governance policy — the same prompt the
live service sends, deliberately, so training and serving cannot drift.

The smoke run measured **0.050–0.055 iterations/second** while sharing the GPU
with the baseline evaluation. Even assuming that doubles once the GPU is free,
one pass over the full pool is many hours, and a full learning curve plus a
hyperparameter sweep plus three seeds is not affordable on one machine inside
this work.

This is a real constraint, and the plan responds to it explicitly rather than
quietly running less and reporting as though it ran more:

- **Training count is chosen, not assumed.** Nested, stratified,
  coverage-repaired subsets (400/800/1600/3200) exist. The candidate run uses
  1,600 with checkpoints every 200 micro-batches and validation every 100, so
  the validation curve itself shows whether more data was still helping.
- **Checkpoint selection replaces a multi-run sweep** where it can: one run
  yields a checkpoint series, all selected on validation only.
- **Whatever is not run is reported as not run.** No variance figure is quoted
  for seeds that were never trained.

## Acceptance gates for V7 (predeclared)

These are engineering gates, not results. They were written before V7 existed.

| Gate | Threshold |
| --- | --- |
| Beats the untuned base on held-out decision accuracy | strictly greater on `test-decision-balanced` |
| Beats the untuned base on macro-F1 | strictly greater |
| Does not worsen the false-ALLOW rate | ≤ the untuned base's rate on the same set |
| Schema-valid JSON | ≥ 0.98 |
| Adversarial robustness | no unexplained false ALLOW on `test-adversarial` |
| OOD phrasing | accuracy within 0.10 of the in-domain decision set |
| Latency | p95 within the same order as the base (single-request, local) |

A model that trains successfully but fails a gate is **not activated**, and the
reason is reported.

## Baseline, as measured so far

The untuned base is strongly DENY-biased — it is safe and close to useless:

| Set | Valid JSON | Decision acc. | Balanced acc. | False ALLOW | False DENY |
| --- | --- | --- | --- | --- | --- |
| `validation-balanced` | 0.925 | 0.581 | 0.577 | 7 (3.7%) | 148 (80.9%) |
| `test-decision-balanced` | 0.923 | 0.606 | 0.603 | 14 (5.0%) | 204 (74.5%) |
| `test-reason-balanced` | 0.943 | 0.880 | 0.597 | 19 (4.2%) | 42 (76.4%) |

`test-reason-balanced` is 89% DENY by construction, so its 0.880 plain accuracy
is what a DENY-biased model scores on an imbalanced set — balanced accuracy
0.597 is the honest figure, and reporting both is why the difference is visible.

Reason-code accuracy is 0.36–0.48 and policy-reference accuracy 0.23–0.24: the
base model frequently reaches a defensible decision by the wrong clause.

That gives V7 a clear and measurable target: recover ALLOW recall without
raising false ALLOW.

## What will not be claimed

- No production prevalence is known for this system, so no evaluation set is
  production-like and none is described as such.
- The dataset is synthetic and **not** human-reviewed.
- V6 is a historical reference under documented schema adaptations, not a fair
  head-to-head: it is not shown the action or the purpose.
- On-chain provenance proves a registered model produced an output because the
  operator signed for it; it cannot re-run the inference.
