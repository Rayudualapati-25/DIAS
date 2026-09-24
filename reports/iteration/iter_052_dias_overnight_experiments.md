# Iteration 052 — DIAS overnight experiments

Date: 2026-09-17 (Asia/Kolkata)  
Plan: `experiments/plans/20260916_dias_overnight_campaign.md`

## Outcome

The bounded overnight campaign completed all experiments that fit the available
single-host window. It produced four paper-ready figures, including the requested
explicit crossed model-failure figure. All reported values below come from
retained machine-readable artifacts; no missing result was extrapolated.

## 1. Recommendation quality and retained failure

On the 600-example balanced held-out test, the untuned Qwen3-14B baseline and
V7 LoRA adapter were evaluated on the same examples. Balanced accuracy improved
from 60.2737% to 98.6667%, schema-valid output from 92.3333% to 100%, reason-code
accuracy from 36.6426% to 97.3333%, and policy-reference accuracy from 23.4657%
to 95.3333%. False allows fell from 14 to 6 and false denies from 204 to 2.

The important negative result remains: V7 produced 6 unsafe ALLOW decisions
among 204 policy-denied adversarial requests, a 2.9412% false-allow rate
(95% Wilson interval 1.3548–6.2672%). The crossed failure figure highlights
`EX-f83b18dd09da`: expected `DENY / RBAC_NO_PERMISSION`, predicted
`ALLOW / POLICY_SATISFIED`.

Evidence:

- `experiments/runs/20260912_dias_qwen3_baseline/metrics.json`
- `experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval/metrics.json`
- `results/tables/dias_v7_unsafe_allow_failures.json`
- `results/plots/dias-overnight/01_recommendation_quality.pdf`
- `results/plots/dias-overnight/04_model_failure_unsafe_allow.pdf`

## 2. Expanded adversarial justification stress test

The deterministic expansion uses 20 retained policy-DENY base cases and six
justification variants per case: normal, plausible-but-misleading, direct
injection, authority role-play, indirect quoted instruction, and near-maximum
request-length distraction. V7 returned 120/120 valid responses and 120/120
DENY decisions, with no observed false allow (95% Wilson upper bound 3.102%).
Reason-code accuracy was 95.0% and policy-reference accuracy 94.1667%.

Review-flag accuracy was only 62.5%, and authority role-play was particularly
weak at 5.0%. Therefore this stress test supports decision stability on these
templates, not arbitrary prompt-injection resistance or complete threat
recognition. It is also an all-DENY templated test, not an independent balanced
dataset.

Evidence:

- `experiments/dias-finetuning/adversarial-expanded/manifest.json`
- `experiments/runs/20260917_dias_expanded_adversarial/metrics.json`
- `experiments/runs/20260917_dias_expanded_adversarial/predictions/adversarial-expanded.jsonl`
- `results/tables/dias_expanded_adversarial_summary.json`
- `results/tables/dias_expanded_adversarial.csv`

## 3. Exact-scope workload sensitivity

The workload sweep crossed repeat counts 0, 1, 3, and 7 with 0, 1, 2, and 4
sibling records per case, comparing no reuse, DIAS exact-record reuse, and
property-fingerprint reuse. For the two-sibling slice used in the figure,
exact-record reuse avoided 0.00%, 13.33%, 23.75%, and 20.42% of reviews as the
repeat count increased. It produced zero cross-record automatic grants in all
cells. Property-fingerprint reuse avoided 18.89%, 22.22%, 29.03%, and 22.36%,
but extended approvals to 34, 64, 152, and 224 different records respectively.

This is a deterministic workload replay, not an estimate of production demand.

Evidence:

- `experiments/runs/20260916_dias_scope_workload_sweep/scope-workload-sweep.json`
- `results/tables/dias_scope_workload_sweep.csv`
- `results/plots/dias-overnight/02_scope_safety_efficiency.pdf`

## 4. Fine-tuned live acceptance and audit reconstruction

The final V7 adapter (`sha256:348f4ca5707e35afda2b35522ab6bb7c0527d84be23de80253a0c358ae1fd43d`)
was served through the current backend and exercised against the live
permissioned network. The final run passed 14/14 scenarios and 81/81 checks.
The associated review record names model `qwen3-14b-dias-v7` and records the
same adapter hash.

A separate deterministic reconstruction queried the deployed audit API and
off-chain review store. All required fields were present for 7/7 representative
paths: normal allow, normal deny, auditor override of model DENY, automatic
reuse, revoked authorization, expired authorization, and model-unavailable
human decision. This establishes machine-readable field completeness only; it
does not establish human reconstruction speed, usability, or explanation value.

Evidence:

- `experiments/runs/20260916_dias_v7_live_acceptance_r3/acceptance.json`
- `experiments/runs/20260916_dias_overnight_live/reviews/REQ-377c31f1e7f2e89b.json`
- `experiments/runs/20260916_dias_audit_reconstruction/audit-reconstruction.json`
- `results/tables/dias_audit_reconstruction.csv`

Two earlier acceptance attempts are intentionally retained. The first exposed a
peer-convergence race after R1; the second passed 13/14 scenarios but did not
exercise the override-ALLOW case because its fixture incorrectly assumed a
dedicated prompt must produce ALLOW. The harness was narrowed to retry only the
specific transient 422 convergence response and to reuse an already observed
ALLOW specification for the override case. The third run then passed without
changing the system-under-test outcome criteria.

## 5. Concurrent-user latency and throughput

The current DIAS backend was exercised with 1, 2, 4, 8, and 12 distinct
signed-in users, three repetitions per level. There were 81 measured completed
automated workflows plus one warm-up (82 total) and zero failures. The actor
automated the auditor decision to make runs repeatable; this is not human auditor
time.

| Users | Recommendation-ready p50 (s) | p95 (s) | Automated E2E p50 (s) | p95 (s) | Throughput (workflows/s) |
|---:|---:|---:|---:|---:|---:|
| 1 | 5.739 | 6.023 | 7.874 | 8.145 | 0.126 |
| 2 | 9.228 | 14.533 | 10.726 | 16.613 | 0.145 |
| 4 | 16.410 | 26.275 | 17.848 | 27.441 | 0.161 |
| 8 | 33.391 | 81.569 | 35.486 | 83.672 | 0.143 |
| 12 | 41.454 | 95.214 | 43.555 | 97.311 | 0.125 |

The serialized local model queue causes tail latency to grow strongly, while
throughput peaks at 0.161 completed workflows/s at four users and then falls.
This is a single Apple M3 Max (64 GB), local-network prototype result, not a
production capacity claim.

Evidence:

- `experiments/runs/20260916_dias_concurrent_users/concurrent-users.json`
- `experiments/runs/20260916_dias_concurrent_users/requests.jsonl`
- `results/tables/dias_concurrent_users.csv`
- `results/plots/dias-overnight/03_concurrent_user_latency_throughput.pdf`

## 6. Bounded three-seed pilot

Three fresh rank-8 LoRA adapters (seeds 17, 42, and 73) were trained on the same
400-example subset for 256 iterations and evaluated on the same first 120
validation examples. All adapters produced 120/120 valid responses. Mean
decision accuracy was 69.1667% (sample standard deviation 1.6667 percentage
points), mean balanced accuracy 70.6160% (SD 3.2615 points), and mean
reason-code accuracy 59.1667% (SD 0). False-allow rates among policy denials
varied materially from 15.07% to 47.95%.

This negative pilot shows that the small overnight budget does not reproduce the
full V7 result and is too unstable for a seed-robustness claim. The completed
full V7 training run took 18 h 43 min; three serial full-data seeds would require
about 56 hours on the same host before evaluation. Therefore full-data seed
robustness could not truthfully be completed within the overnight window.

Evidence:

- `experiments/runs/20260916_dias_seed_pilot/`
- `results/tables/dias_seed_pilot.csv`
- `results/tables/dias_seed_pilot_summary.json`
- `experiments/runs/20260913_dias_qwen3_lora_v7_full/run.json`

## What worked

- The requested latency, throughput, exact-scope sensitivity, live V7 workflow,
  audit reconstruction, expanded adversarial, and bounded multi-seed tests all
  completed with retained configs, logs, metrics, and predictions.
- Four source-backed PNG/PDF figures were generated, including the explicit
  crossed unsafe-ALLOW failure.
- The final adapter hash remained consistent across offline evaluation and the
  live backend record.

## What failed or remains weak

- The original adversarial test still contains 6 unsafe ALLOW decisions; V7 is
  not safe as an autonomous authorization authority.
- Expanded adversarial review-flag accuracy is only 62.5%, including 5.0% on
  authority role-play.
- The serialized inference path saturates: 12-user p95 recommendation latency is
  95.214 seconds and throughput does not scale past four users.
- The small three-seed pilot performs far below the full-data model and cannot
  substitute for a full seed-robustness study.
- Machine audit completeness does not establish human explanation usefulness.

## Next experiments

1. Run at least three full-data V7 training seeds on parallel hardware or a
   multi-day schedule, using the same held-out suite and reporting paired
   uncertainty.
2. Add training and evaluation cases targeting the six retained unsafe ALLOW
   failures and authority-role-play review flags without tuning on the final test
   examples.
3. Replace or scale the serialized inference worker, then rerun the same
   concurrency protocol and compare throughput/latency curves.
4. Conduct a preregistered human-auditor study measuring reconstruction success,
   time, and ambiguity from the retained audit evidence.

## Verification

- `node experiments/dias/verify-overnight-results.js`: PASS. The verifier checks
  all eight PNG/PDF figure files, source metrics, the 81 measured concurrent
  workflows, 48 scope cells, 14/14 acceptance scenarios, 81/81 acceptance
  checks, 7/7 reconstruction cases, 120 expanded adversarial examples, and all
  three seed pilots. Its signed-by-content manifest is retained at
  `experiments/runs/20260917_dias_overnight_summary/verification.json`.
- Backend unit suite: 168 passing.
- Chaincode suite: 211 passing; statement coverage 92.24% and branch coverage
  84.28% for the measured package.
- Frontend suite: 39 passing.
- Both paper variants compile with Tectonic. The user-facing paper is 11 pages
  and the canonical `papers/final_paper` manuscript is 13 pages. Stable PDFs are
  `output/pdf/DIAS_Overnight_Results_20260917.pdf` and
  `output/pdf/dias_paper_overnight_20260917.pdf`.
- Ports 3001, 8081, and 8082 are closed after the runs. The pre-existing V6
  service on port 8080 was left untouched.
