# Iteration 037 — Exact-record versus property-fingerprint authorization scope

**Date:** 2026-09-12
**Artifacts:** `experiments/runs/20260912_dias_scope_ablation/scope-ablation.json`, `results/tables/dias_scope_ablation.csv`
**Deployed design:** exact-record.

## The question

The DIAS rewrite replaced the SEAL-era dynamic rule — a hash over governed
subject, request and record **properties**, deliberately excluding `recordId`
and `caseId` — with an **exact-record** scope:

```
stableUserId · recordId · caseId · action · purpose  (+ the committed conditions hash)
```

The argument for the change was that an approval for one record should not
authorize another. That is an argument, not a measurement, so this experiment
measures it.

## Method

Both designs replay **one identical request stream**, with identical model
labels (taken from the dataset, so no inference is involved) and identical
auditor behaviour (a fixed per-request override decision shared by both arms).
Only the scope key differs, so every difference is attributable to it.

The stream is the 60 workflow-evaluation cases, each given **two sibling
records** — a different record in a different case with identical governed
properties — and then repeated three times so reuse can happen at all. 720
requests across 180 distinct records.

A sibling is the realistic situation the scope decides: the same officer asking
for another FIR of the same type, sensitivity and jurisdiction from the same
station.

## Result

| | exact-record | property fingerprint |
| --- | ---: | ---: |
| Requests | 720 | 720 |
| Model invocations | 549 | **511** |
| Auditor reviews | 549 | **511** |
| Authorizations created | 57 | 19 |
| Automatic grants | 171 | 209 |
| …on the record the auditor approved | 171 | 57 |
| …**on a record the auditor never saw** | **0** | **152** |
| Records covered per approval (mean) | **1** | **3** |
| Approvals reaching more than one record | 0 | 19 of 19 |

The property fingerprint saves **7% of review work** (511 versus 549). In
exchange:

- **152 of its 209 automatic grants — three quarters — are for records no
  auditor ever looked at.**
- Every one of its 19 approvals becomes a standing exception over **three**
  records rather than one.

Under exact-record scope the second figure is zero by construction, and the
first is one, also by construction. That is what "exact" buys, and 7% more
review work is what it costs.

## The honest caveat

With `--siblings 0` — a stream in which no two records share governed
properties — **the two arms are identical**. The difference is conditional on
sibling records existing, not universal. How often that happens in real traffic
is unknown; this measurement bounds the effect, it does not estimate the
frequency.

The workflow-evaluation set as generated contains no siblings, because the
generator makes every case diverse. Siblings had to be constructed
deliberately. That is the case the design decision is about, and constructing it
is the point — but a reader should know it was constructed rather than observed.

## What the tests pin

`experiments/dias-finetuning/v2/test/scopeAblation.test.js` asserts the
comparison is fair before it asserts anything about the result:

- both arms replay the same stream, and a coarser scope can only ever do less
  work, never more;
- every request is either skipped or reviewed, never both and never neither;
- only a model DENY that an auditor overrides creates an authorization, in
  either arm;
- an exact-record approval **cannot** reach a second record, and a property
  fingerprint **can** — the two facts the whole decision rests on.

An earlier version of the test fixture gave every case identical governed
properties, which made the "no siblings" case silently wrong: they were all
siblings of one another. The fixture now varies a governed property per case.

## Conclusion

Exact-record scope is retained. The cost is measured (7% more review work under
this stream) and the benefit is categorical rather than statistical: an approval
covers the record the auditor saw, and nothing else.
