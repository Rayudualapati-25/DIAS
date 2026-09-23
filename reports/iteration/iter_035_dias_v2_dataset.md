# Iteration 035 — DIAS binary recommendation dataset v2

**Date:** 2026-09-12
**Artifacts:** `experiments/dias-finetuning/data-v2-binary/`, `experiments/runs/20260912_dias_v7_dataset/`, `results/tables/dias_v2_*.csv`
**Status:** dataset generated and validated; **not** human-reviewed.

## 1. What this dataset is for

Supervised fine-tuning and held-out evaluation of an **advisory** binary
ALLOW/DENY access recommendation model. The model never grants or denies access:
an auditor, or an already-active exact dynamic authorization, decides.

Labels come from the versioned written governance policy
(`dias-governance-policy v1`, SHA-256
`796013dd7d8a043891485cbf7bf9d4c54288f3fa7d746fd7dd2fdc693bc9b1c0`) through the
offline reference oracle. **Auditor overrides are never labels.** An override is
an exceptional governance act recorded in the dynamic-authorization system;
training the model to predict one would teach it to imitate exactly the authority
the architecture denies it.

`data-v1` is untouched and remains on disk as prior evidence.

## 2. What was wrong with v1, and what v2 does instead

The v1 audit (`experiments/runs/20260911_dias_design_review/dataset_audit.json`)
found defects that would have made any v1 accuracy figure uninterpretable. Each
is now both fixed and **guarded by a check that provably fails without the fix**
(`experiments/dias-finetuning/v2/test/checks.test.js` injects each defect and
asserts the check reports it).

| v1 defect | Evidence in v1 | v2 |
| --- | --- | --- |
| Usernames contained the role and the split name | 3000/3000 train examples | Opaque salted hashes (`u-3f9c2a7b41`) |
| Each reason code had its own record-number range | e.g. `CROSS_JURISDICTION` = 1626–1750 | Opaque identifiers; a binomial test over prefix buckets, Bonferroni-corrected, would catch a reintroduction |
| Cross-jurisdiction written as `outside-<district>` | surface form gave the label | Two distinct real district names; the comparison must be performed |
| Only `high` and `low` clearance | ordered comparison never exercised | All three levels across all sensitivities |
| Zero multi-rule examples | `multiRuleViolations: 0` | 370 in `test-multi-rule`; 139 distinct clause combinations across the pool |
| `emergencyFlag` false in every example | useless as distractor, untested as non-exception | Drawn independently; ALLOW share 0.466 when true vs 0.444 when false |
| 246 `INVALID_PURPOSE` examples | cannot occur at runtime | Excluded, and the exclusion is recorded in the manifest |
| Paraphrases could cross splits | not checked | Scenario families are assigned to splits as whole units |

## 3. Composition

| Set | Examples | ALLOW | DENY | Families | Purpose |
| --- | --- | --- | --- | --- | --- |
| `train` | 5,254 | 2,627 | 2,627 | 2,815 | Fine-tuning pool |
| `validation-balanced` | 400 | 200 | 200 | 304 | Checkpoint and hyperparameter selection |
| `test-decision-balanced` | 600 | 300 | 300 | 465 | Headline decision metrics |
| `test-reason-balanced` | 540 | 60 | 480 | 412 | Reason-code accuracy, 60 per code |
| `test-adversarial` | 389 | 185 | 204 | 200 | Injection and false-claim resistance |
| `test-ood-paraphrase` | 400 | 200 | 200 | 307 | Unseen phrasing only |
| `test-multi-rule` | 370 | 0 | 370 | 190 | Precedence under several failures |
| `workflow-evaluation` | 60 | 31 | 29 | 60 | Live Fabric scenario inputs |

7,478 distinct examples in total. Reason-code distribution is in
`results/tables/dias_v2_reason_code_distribution.csv`; composition per set is in
`results/tables/dias_v2_dataset_composition.csv`.

**The test sets deliberately overlap**: they are different views of one held-out
pool (528 examples are reused between views). Their metrics are therefore not
statistically independent of one another, and should not be pooled as though
they were. The validator reports the overlap rather than treating it as an error.

## 4. Distribution claim

**Synthetic.** The class balance and scenario mix were chosen for training and
measurement. No production prevalence is known for this system, so no set here is
production-like and none is labelled as such. A real deployment would almost
certainly be dominated by routine ALLOW traffic, which would change every
precision figure; that is a limitation of the evaluation, not a property of the
model.

## 5. Validation

`node experiments/dias-finetuning/v2/validate.js` — **25/25 checks pass**
(`experiments/runs/20260912_dias_v7_dataset/validation.json`).

The checks that carry weight:

- **label-reproduction** — all 7,917 labels re-derived from the facts and the
  justification family. The label is never a stored judgement.
- **feature-leakage** — 4,656 distinct verified-feature sets, none appearing in
  two splits.
- **family-leakage** — 4,261 scenario families, each in exactly one split, so a
  near-miss pair can never be split between train and test.
- **template-leakage** — 5 held-out phrasing families, absent from training;
  `test-ood-paraphrase` uses only those.
- **precedence** — 1,611 multi-clause DENY examples across 139 combinations, all
  citing clauses in precedence order with the reason code from the first.
- **explanation-grounding** — every reason names its decisive clause and cites
  nothing the label omits.
- **irrelevant-field-independence** — `emergencyFlag`, `approvalTokenPresent` and
  `witnessFlag` each take both values and neither predicts the label.

## 6. Token lengths

Measured with the exact Qwen3 tokenizer and the chat template mlx-lm applies
(`experiments/runs/20260912_dias_v7_dataset/token_lengths.json`).

| | tokens |
| --- | --- |
| Longest example, any set | **2,150** |
| Train mean / p99 | 2,015 / 2,102 |
| Longest completion | 193 |
| Total train tokens per epoch | 10,586,206 |

`max_seq_length: 2560` is the smallest candidate that truncates nothing.
Sequences are much longer than v1's (max 1,152) because the v2 prompt renders the
complete policy bundle — the same prompt the live service sends, which is the
point. **One epoch is roughly 9× the token volume of a v1 epoch**, which is the
dominant term in the training-time estimate.

## 7. Human review — NOT DONE

`human-review-sample.csv` holds **161 rows across 55 strata**, every row marked
`review_status = pending_manual_review` with empty `reviewer_verdict`.

**No part of this repository may describe the dataset as human-reviewed until a
person fills those columns in.** The file exists so that review is possible, and
that is the only claim made for it.

## 8. Reproducing it

```bash
node experiments/dias-finetuning/v2/generate.js --seed 20260912
node experiments/dias-finetuning/v2/validate.js --json experiments/runs/20260912_dias_v7_dataset/validation.json
HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/python experiments/dias-finetuning/v2/token_audit.py \
  experiments/dias-finetuning/data-v2-binary experiments/runs/20260912_dias_v7_dataset/token_lengths.json
```

Generation is deterministic from the seed and takes under a second. The manifest
records the SHA-256 of every source a label depends on — the bundle, the oracle,
the prompt, the policy-context provider, the verified-request model, the response
schema, and all eight generator modules — so a dataset produced by different code
is a detectable fact rather than an assumption.

## 9. What worked, what is weak, what is next

**Worked.** Making scenario constructors self-verifying against the oracle caught
a real bug: a multi-clause constructor could apply one mutation that undid
another and still record both clauses as targets. It now returns null and the
caller retries, so `targetClauses` is never a fiction.

**Weak.**
- Justifications are template-generated. The held-out families vary register, but
  none of it is human-written, so OOD performance here is a lower bound on
  template diversity, not a measure of real user language.
- Reason sentences come from one template per clause, so reason-text accuracy
  measures whether the model reproduces a fixed phrasing, not whether it can
  explain well. Reason-**code** accuracy is the meaningful figure.
- `test-multi-rule` is all DENY by construction, so it has no precision figure —
  only recall and reason-code accuracy are interpretable on it.
- Overlapping test views are convenient but correlate the metrics.

**Next.** Untuned Qwen3-14B baseline over every held-out set (Phase 5), then the
V7 training configuration with a learning curve to choose the training count
rather than assuming all 5,254 examples help.
