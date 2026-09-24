# Evaluation

What has been measured, on what, and what each number does and does not support.

## Test suites

| Suite | Result | What it covers |
| --- | --- | --- |
| Chaincode | **211 passing** | request and decision logs, the LLM-agreement rule for dynamic authorizations, exact reuse, revocation and expiry, the public case-file index, plus the architecture guard that proves the deployed package excludes every SEAL-era policy module and loads no recommendation or provenance module |
| Backend | **168 passing** | the backend recommender, off-chain review store, recommendation worker, LLM agreement, routes (case-file lookup, officer administration guard), commit-conflict retries, the backend/chaincode method-compatibility guard, the require-graph architecture guard |
| Policies | **27 passing** | bundle hashing, the offline oracle, precedence, and that the specification and open-questions document are current for this bundle hash |
| Frontend | **39 passing** | the DIAS view model (including LLM agreement and the committed-decision view), navigation checked against the chaincode's organisation and role rules, form patterns as browsers compile them, and the frontend/backend route-compatibility guard |
| Dataset & evaluation | **93 passing** | generator determinism, every dataset check's ability to **fail**, the metrics, the ablations, the subsets, and the V6 adapter |

Counts as of 2026-09-15, after the repository bug sweep
(`reports/iteration/iter_047_dias_bug_sweep.md`) and the auditor/decision-log
round (`reports/iteration/iter_048_auditor_decision_and_public_log.md`).

Passing unit tests are not evidence that the system works end to end. That is
what the live suites are for.

## Live API suite

`make smoke` (`backend/test/api.live.test.js`): **16 passing** against the running
backend, `diasrecords` 2.2 and the model server — request validation, the public
case-file lookup from another station, the request log without the
justification, the backend recommendation, a FORCE_DENY decision log with the
agreement the backend derived (a browser-supplied value is ignored), both trail
views, authorization routes, and that the retired explanation and LLM-request
routes are gone. Every decision it records is FORCE_DENY, so it creates no
dynamic authorization and can be repeated.

## Live Fabric acceptance

**14 scenarios, 81 checks, all passing**, through the backend HTTP API against
`diasrecords` 2.2 on the five-organization `diaschannel`, with the untuned
Qwen3-14B-4bit model served to the backend. Evidence:
`experiments/runs/20260916_dias_backend_llm_acceptance_054757/` (with its
`runner.log`); narrative:
`reports/iteration/iter_048_auditor_decision_and_public_log.md`. The same 14
scenarios passed unchanged against 2.1
(`experiments/runs/20260915_dias_backend_llm_acceptance_170525/`) and 2.0.

The scenarios cover the request log; the recommendation kept in the backend; all
four auditor/LLM combinations and the agreement value each writes to the
decision log; automatic reuse and the four near misses; revocation and expiry;
the two chaincode refusals (an auditor deciding their own request, and a
decision on facts that changed); a decision with no recommendation; the
application access log; and a search of all 14 ledger trails for any
recommendation, reason or justification field.

The 2.0 run (`experiments/runs/20260915_dias_backend_llm_acceptance/`,
`reports/iteration/iter_046_dias_backend_llm.md`) was the third attempt:
attempts 1 and 2 failed because of harness defects — a check that matched the
field name `provenanceSource`, a scenario that found no LLM ALLOW to override,
and a generation number that assumed an empty ledger. They are kept with their
notes in `attempt-1/` and `attempt-2/`. No DIAS code changed between those
attempts.

Recommendation latency is descriptive only, one request at a time on one Mac
that was also running other work: 11 live recommendations took 2.39–7.48 s of
inference (median 3.36 s) in the 2.0 run and 4.63–8.58 s (median 6.78 s) in the
2.1 run. No controlled latency measurement or comparison with the retired design
was run.

The earlier run of **15 scenarios and 72 checks**
(`experiments/runs/20260912_dias_live_fabric/`,
`reports/iteration/iter_036_dias_live_fabric.md`) tested the retired design with
an AI organization, signed recommendations and a listener. It is kept as
evidence for that design and does not describe the current system.

## Model evaluation

### Sets

Six held-out sets from `data-v2-binary`, described in
`reports/iteration/iter_035_dias_v2_dataset.md`. They are **deliberately
overlapping views of one held-out pool**, so their metrics are not statistically
independent and must not be pooled as though they were.

### Metrics, and two decisions behind them

- **An unparseable answer is an absent decision, not a wrong one.** Counting it
  as DENY would make a model that fails on every DENY example look perfect on
  the safety metric. Schema validity is reported separately.
- **False ALLOW and false DENY are never averaged.** A false ALLOW recommends
  releasing protected material; a false DENY delays legitimate work. Both are
  reported as counts and as rates over the examples that could produce them.

Balanced accuracy and macro-F1 accompany plain accuracy everywhere, because
several sets are deliberately imbalanced and a class-biased model scores well on
plain accuracy alone.

Proportions carry Wilson intervals: a figure from a few hundred examples cannot
support a comparison quoted to three decimals.

### Untuned Qwen3-14B baseline

`mlx-community/Qwen3-14B-4bit` at revision `a4d9b2df…`, temperature 0, top_p 1,
thinking disabled, through the **same recommender the live service uses**.

Partial results (three of six sets complete at the time of writing) are in
`experiments/plans/20260912_dias_v7_completion.md`. The headline finding: the
base model is strongly DENY-biased — safe, and close to useless. It denies
roughly three quarters of the requests the policy would allow, while its false
ALLOW rate stays under 5%.

### V7

Not yet trained at the time of writing. Acceptance gates were **predeclared**
in the completion plan before the model existed, and a model that trains
successfully but fails a gate is not activated.

### V6 reference

V6 is a historical reference, not a peer. It was trained on a three-class
contract and is **not shown the action or the purpose** — the SEAL prompt
withheld them by design — while V7 receives them as verified facts. Its
`escalate` maps to *no recommendation*, never to DENY.

All adaptations are recorded in the run artifact, and the comparison is labelled
REFERENCE ONLY.

## Ablations

Prompt ablations remove exactly one component and leave the rest byte-identical:
requester attributes, record attributes, action and purpose, the governance
policy, and the user justification. A removed block is replaced by an explicit
withheld marker rather than deleted, so a model is not simply handed a shorter
prompt.

Two **training-data** ablations the plan also calls for — training without
adversarial examples and without multi-rule examples — require separate training
runs. They are separate work and are reported as such.

## What none of this shows

- The data is synthetic and the governance policy is a synthetic research
  policy. No result here transfers to a real jurisdiction.
- No production prevalence is known, so no set is production-like.
- The dataset is **not** human-reviewed.
- Fabric strengthens identity, provenance, freshness and tamper evidence. It
  cannot make an incorrect recommendation correct — which is why the auditor,
  not the model, decides.
