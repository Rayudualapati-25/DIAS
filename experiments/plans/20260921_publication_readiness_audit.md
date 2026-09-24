# Plan — publication-readiness audit and reproduction (2026-09-21)

Owner: publication-readiness audit, at the author's request.
Scope: verify the evidence behind the canonical DIAS manuscript, fill gaps that
can be filled on this machine without new training, and record what cannot.

## Constraints carried over from earlier decisions

- No new model training and no data regeneration: training stays frozen
  (reports/iteration/iter_041_single_device_auditor_handoff.md). V7 is evaluated
  offline only; it is not served as the backend's live model.
- The shared Fabric network (containers belong to the `wt-dias` compose project)
  is down and must not be brought up, seeded or torn down without the author.
  Live experiments are therefore validated from retained records, not rerun.
- The author's manuscript wording is preserved; edits are surgical, evidence
  driven and listed in `papers/final_paper/AUDIT_CHANGES.md`.

## Experiments

### E1. Reproduction of the V7 offline evaluation (inference only)

- Hypothesis: with the retained adapter (sha256 `348f4ca5…fd43d`), the cached
  base revision `a4d9b2df…`, mlx-lm 0.31.3 and greedy decoding, the current
  checkout reproduces the 2026-09-14 predictions on `test-decision-balanced`
  (600) and `test-adversarial` (389).
- Command: `scripts/dias/reproduce-eval.sh LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7 experiments/runs/20260921_dias_v7_reproduction 8083 test-decision-balanced,test-adversarial`
- Smoke first: same command with `limit 20` into `…_smoke`.
- Metrics: per-example agreement of decision, reason code, policy references and
  full response; recomputed balanced accuracy, false ALLOW/DENY, latency.
- Acceptance: identical decisions on all shared examples. Any difference is
  reported with the example ids; it is not averaged away.
- Failure handling: if the server cannot load offline, record the blocker; do not
  fall back to a different model revision.

### E2. Reproduction of the untuned baseline on the balanced test (inference only)

- Hypothesis: the untuned Qwen3-14B-4bit reproduces the 2026-09-12 baseline
  predictions on `test-decision-balanced` (600).
- Command: `scripts/dias/reproduce-eval.sh none experiments/runs/20260921_dias_baseline_reproduction 8083 test-decision-balanced`
- Same metrics and acceptance rule as E1.

### E3. Offline statistics and trivial baselines (no inference)

- Recompute every manuscript number from raw predictions with
  `scripts/audit/recompute_paper_metrics.py`.
- Add uncertainty: Wilson intervals for rates, bootstrap intervals (10,000
  resamples, seed 20260921) for balanced accuracy, and an exact McNemar test for
  paired baseline-vs-V7 decisions on the same 600 examples.
- Trivial reference baselines on the same test set: always-DENY, always-ALLOW,
  and the class-prior expectation of a random recommender.
- Acceptance: every manuscript number either matches a recomputed value or is
  flagged in the claim-evidence matrix.

### E4. Offline replay of the scope/workload sweep

- Re-run `experiments/dias/run-scope-workload-sweep.js` into a scratch output
  and compare byte-for-byte (or cell-for-cell) with
  `experiments/runs/20260916_dias_scope_workload_sweep/`.

### Not run (blocked or out of scope), with reasons

- Full-data multi-seed V7 training: about 56 h serial on this host and blocked
  by the training freeze. The three-seed 400-example pilot is the retained
  fallback.
- Live Fabric acceptance, concurrency and audit-reconstruction reruns: the shared
  network is down and may not be started without the author.
- Human-auditor study: requires participants and ethics approval.

## Expected artifacts

`experiments/runs/20260921_*` run records, `results/tables/dias_audit_*`,
`reports/repository_audit/*`, `reports/iteration/iter_054_publication_readiness.md`,
`reports/PUBLICATION_READINESS.md`.
