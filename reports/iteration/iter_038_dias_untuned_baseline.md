# Iteration 038 — Untuned Qwen3-14B baseline

**Date:** 2026-09-12
**Model:** `mlx-community/Qwen3-14B-4bit`, revision `a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4`, **no adapter**
**Decoding:** temperature 0, top_p 1, thinking disabled, max 512 tokens
**Harness:** `backend/src/dias/recommender.js` — the same code path the live service uses
**Artifacts:** `experiments/runs/20260912_dias_qwen3_baseline/`, `results/tables/dias_baseline*.csv`, `results/plots/dias-baseline/`

2,699 evaluations across all six held-out sets, frozen before any V7 training
began. This is the number V7 has to beat, and it was measured first so it cannot
be adjusted afterwards.

## Results

| Set | n | Valid JSON | Decision acc. | Balanced acc. | Macro-F1 | False ALLOW | False DENY | Reason-code acc. |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `validation-balanced` | 400 | 0.925 | 0.581 | 0.577 | 0.505 | 7 (3.7%) | 148 (80.9%) | 0.359 |
| `test-decision-balanced` | 600 | 0.923 | 0.606 | 0.603 | 0.550 | 14 (5.0%) | 204 (74.5%) | 0.366 |
| `test-reason-balanced` | 540 | 0.943 | 0.880 | 0.597 | 0.617 | 19 (4.2%) | 42 (76.4%) | 0.479 |
| `test-adversarial` | 389 | 0.856 | 0.565 | 0.531 | 0.430 | 4 (2.2%) | 141 (91.6%) | 0.264 |
| `test-ood-paraphrase` | 400 | 0.933 | 0.643 | 0.635 | 0.620 | 28 (14.4%) | 105 (58.7%) | 0.437 |
| `test-multi-rule` | 370 | 0.951 | 1.000 | — | — | 0 | 0 | 0.543 |

## What the numbers say

### The model is safe and close to useless

It denies almost everything. On the balanced decision set it returns DENY for
470 of 554 valid answers, and **74.5% of the requests the policy would allow are
refused**. The false-ALLOW rate is correspondingly low at 5.0%.

That is not caution, it is a prior. Balanced accuracy of 0.603 on a balanced set
is barely above the 0.5 a coin gets.

### Two numbers that look good and are not

**`test-multi-rule` reports accuracy 1.000.** That set is 100% DENY by
construction, and a model that always denies scores perfectly on it. The metrics
module returns `null` for balanced accuracy and macro-F1 there rather than
printing a figure that would be meaningless — with one class present, the mean
of two recalls does not exist. The interpretable figure on that set is
reason-code accuracy: **0.543**.

**`test-reason-balanced` reports accuracy 0.880.** That set is 89% DENY.
Balanced accuracy is 0.597, and the gap between the two is precisely the size of
the bias.

Reporting plain accuracy alone on either set would have been flattering and
wrong. This is why both are always reported.

### Adversarial text pushes it further toward DENY, and breaks its formatting

| Attack type | n | Accuracy | False ALLOW | Valid JSON |
| --- | ---: | ---: | ---: | ---: |
| Contradictory claims | 195 | 0.537 | 3 | 0.964 |
| Prompt injection | 194 | 0.600 | 1 | **0.747** |

Split by what was attacked:

| | n | Accuracy | False ALLOW |
| --- | ---: | ---: | ---: |
| Adversarial text on an ALLOW request | 185 | **0.084** | 0 |
| Adversarial text on a DENY request | 204 | 0.978 | 4 |

Injection almost never flips this model to ALLOW — 4 false ALLOWs in 179 valid
DENY examples. Its main effect is on the **output contract**: schema validity
falls from 0.964 to 0.747 under injection, so a quarter of injected requests
produce something that is not a recommendation at all.

For DIAS that is a survivable failure — an unparseable answer becomes an
`INVALID_OUTPUT` status and the request still reaches an auditor — but it is a
failure, and it is the one V7 must not inherit.

### "Out of distribution" is not meaningful for this model

The base scores **higher** on `test-ood-paraphrase` (0.643) than on the
in-domain decision set (0.606). That is not generalisation: the untuned model has
seen neither, so nothing is in-distribution for it. The held-out phrasing
families simply read as more formal, and the model is less DENY-biased on them —
its false-ALLOW rate rises to 14.4%, nearly three times the in-domain 5.0%.

The OOD comparison only becomes meaningful for V7, which will have trained on
the trainable template families and not on the held-out ones. **The baseline's
OOD number is a reference point, not a robustness result**, and treating it as
one would be a mistake.

### It reaches defensible decisions by the wrong clause

Reason-code accuracy is 0.264–0.543, policy-reference accuracy 0.23–0.24. Across
all 2,699 evaluations the single largest error category after false DENY is
**"right decision, wrong reason"** — 749 cases, led by `RBAC_NO_PERMISSION`
(211), `JUVENILE_PROTECTED` (146) and `VICTIM_DATA_NOT_NECESSARY` (101).

A recommendation an auditor cannot check against the clause it cites is worth
much less than its accuracy suggests, which is why reason-code and
policy-reference accuracy are reported separately from the decision.

### Per-organisation

| Organisation | n | Accuracy | False ALLOW |
| --- | ---: | ---: | ---: |
| court | 73 | 0.508 | 0 |
| forensics | 173 | 0.696 | 8 |
| police | 226 | 0.579 | 6 |
| prosecution | 128 | 0.590 | 0 |

### Latency

Pooled across all sets: median **8.1 s**, p95 **10.9 s**, p99 **15.8 s** per
request, single-request on local hardware while the machine also served the V6
model. This is the latency budget V7 must stay within, not a throughput claim.

## Method notes

- Evaluation ran through the live recommender, so a generation failure is
  surfaced exactly as the ledger would record it and the metrics can separate
  *wrong* from *absent*.
- Decision metrics cover schema-valid responses only. Counting an unparseable
  answer as DENY would make a DENY-biased model look perfect on the safety
  metric — precisely the mistake this baseline would have invited.
- The six sets are overlapping views of one held-out pool. The pooled figures
  above are descriptive; they are **not** an independent sample and must not be
  treated as one.
- Total wall time was roughly 6.3 hours at ~8.4 s/example, sharing the machine
  with the V6 service.

## What this gives V7

A clear and measurable target:

1. **Recover ALLOW recall.** 74.5% of allowable requests are currently refused.
2. **Without raising false ALLOW** above 5.0% on the decision set.
3. **Hold the response contract under injection** — 0.747 validity is the
   weakest number here.
4. **Cite the right clause** — reason-code accuracy of 0.366 is the gap between
   a usable recommendation and a lucky one.

The predeclared acceptance gates are in
`experiments/plans/20260912_dias_v7_completion.md`, written before V7 existed.

## Limitations

- Synthetic data and a synthetic research policy. Nothing here transfers to a
  real jurisdiction.
- No production prevalence is known, so no set is production-like.
- One decoding configuration, one seed, one machine.
- The dataset is not human-reviewed.
