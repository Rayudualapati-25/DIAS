# Iteration 070 — verified counterfactual explanations

- **Date:** 2026-10-08.
- **Plan step:** 14; requirements M25 and I08.
- **Outcome:** implemented and running on the local host. The original LLM
  explanation stays unchanged. A separate panel explains hypothetical changes
  under the project's written research policy. It grants nothing.
- **Plan:** [step 14](../../experiments/plans/20261008_counterfactuals.md).
- **Run:** [evidence](../../experiments/runs/20261008_counterfactuals/).

## What changed

1. `backend/src/dias/counterfactuals.js` enumerates up to two distinct changed
   facts. The reference policy must return ALLOW after the change. Any set with
   a sufficient proper subset is dropped. Graded facts use the lowest sufficient
   clearance or sensitivity reclassification. The generator does not read the
   LLM answer, justification, emergency claim or auditor note.
2. The permitted facts are action, purpose, credential status, assignment,
   clearance, sensitivity, sealed status, juvenile protection and victim
   protection. Each sentence labels REQUESTER, ADMINISTRATIVE or LEGAL authority.
   Identity, district, role, record type and case are never changed.
3. The recommendation-detail API adds `counterfactuals`, bound to the ledger
   request's v3 schema, verified-context digest and policy version/hash. Missing,
   changed, unsupported or mismatched data yields unavailable hints, rather than
   guessing. The API reads as the caller and uses the existing visibility rule:
   the requester only after an auditor denial; audit district heads for other
   people's requests. An auditor who requested a record is still its requester.
4. The requester explanation, decision-log detail and auditor review include a
   separate policy panel. A policy ALLOW proposes no change and does not pretend
   to explain an auditor denial. Hints can be removed with
   `DIAS_COUNTERFACTUALS=off`, without changing model advice or access decisions.
5. The architecture guard permits oracle reachability only through the new
   explanation module. Model generation, signing and worker graphs remain
   isolated. No chaincode was changed or redeployed.

## Verification

Evidence paths here are relative to the run directory.

| Check | Result | Evidence |
| --- | --- | --- |
| Existing backend baseline, excluding only the unfinished missing module | 319 passed | `backend-baseline.log` |
| Full backend after implementation | 341 passed | `backend-tests-02.log`, final confirmation in `backend-tests-03.log` |
| Frontend | 82 passed; syntax passed | `frontend-tests-02.log`, `frontend-syntax-02.log` |
| Policy package | 27 passed | `policies-tests.log` |
| Unchanged chaincode suite | 341 passed | `chaincode-tests.log` |
| Unchanged dataset suite | 104 passed | `dataset-tests.log` |
| Real API checks on existing synthetic decisions | 11 passed, zero failed | `live/live.json` |
| Real browser detail | Auditor panel displays verified policy ALLOW and no invented change for a denied request | `auditor-policy-panel.txt`, `auditor-policy-panel.png` |

The backend checks include Claude's 12 unfinished generator tests plus two
additional generator checks, seven API detail checks and one configuration
check. Changed architecture expectations are deliberate: the old blanket oracle
ban is replaced with an explanation-only reachability guard. All other baseline
expectations remain. Counts describe the current worktree, including the earlier
uncommitted mobile tests; a clean-clone validation is not claimed.

The live check reads request `REQ-09b823865a80b449`, allowed request
`REQ-24601cfdab132c5f`, and the existing own-request decisions for `judge.rana`
and `dj.north`. It confirms unchanged LLM text and decision against a retained
pre-restart API response, requester/auditor visibility, other-organization and
anonymous refusal, and invalid-ID refusal. No new access request, decision or
authorization was submitted; sensitive reads produce the normal access-log
transactions. Only the backend was restarted. Model and Fabric services were
left running.

The browser check exercised the actual auditor decision-log panel. A new waiting
auditor dialog and a requester history screen were not exercised live; their
pure presentation/visibility behavior is covered by tests. The existing browser
session had no requester history, so no record was created merely to populate it.

## Baseline and ablations

The deterministic grid contains 4,096 synthetic v3 contexts spanning four roles,
credential, assignment, jurisdiction, clearance/sensitivity, three protection
flags, action and purpose. There are 117 policy ALLOW and 3,979 policy DENY
contexts. The baseline suggests all unverified single-fact candidates. The
proposed generator filters and keeps minimal one/two-fact sets.

| Variant | Offered sets | Sets satisfying policy | Covered denied contexts | Authority labels |
| --- | ---: | ---: | ---: | --- |
| Unverified one-fact baseline | 32,333 | 975 (3.02%) | 348 / 3,979 (8.75%) | present |
| Verified one/two-fact generator | 2,935 | 2,935 (100%) | 820 / 3,979 (20.61%) | present |
| Pair search removed | 975 | 975 (100%) | 348 / 3,979 (8.75%) | present |
| Verification removed, full candidate universe | 134,187 | 6,308 (4.70%) | 820 / 3,979 (20.61%) | present |
| Authority labels removed | 2,935 | 2,935 (100%) | 820 / 3,979 (20.61%) | absent |
| Whole component disabled | 0 | not applicable | 0 / 3,979 | not applicable |

All 2,935 retained sets were independently reapplied by the experiment and
checked for inclusion-minimality. This uses the same oracle, so the result is
consistency evidence, not independent policy correctness or legal feasibility.
The unverified ablation is an offline measurement only; no runtime mode can
disable verification while exposing suggestions. Removing labels preserves
policy consistency but removes the indication of who may make a change. No
user study of those labels or natural-language quality was performed.

Source: [config and metrics](../../experiments/runs/20261008_counterfactuals/offline/metrics.json),
[per-context record](../../experiments/runs/20261008_counterfactuals/offline/cases.json).
Table: [comparison](../../results/tables/20261008_counterfactuals.csv).

## What failed and what is weak

- The unfinished generator and new detail/frontend tests failed before their
  implementations existed. The original architecture guard then correctly
  failed the new oracle path, before its specified exception was added. Those
  logs are retained.
- One added test initially assumed a constable was blocked by the victim-data
  clause. The bundle actually blocks lab analysts/directors. The fixture was
  corrected to a forensics lab analyst; the failed full-suite run is retained.
- Only 20.61% of denied grid contexts have a suggestion. Unchangeable facts and
  requests requiring more than two changes remain unresolved. Unresolved does
  not mean no real-world solution exists.
- Legal flag changes are hypothetical policy conditions. The generator cannot
  establish that a court may remove protection or that an administrator may
  reclassify a particular record. Purpose changes must reflect a legitimate
  actual purpose, not rewording to evade controls.
- Hints describe the committed request-time facts, not current user/record
  state. They do not predict the next request or the auditor's decision.
- The model's original reason is preserved, not checked or rewritten by the
  generator. No LLM explanation accuracy, fine-tuned V7, legal accuracy, latency
  or four-VM experiment claim follows from these checks.
- API hints are computed off-chain when read. They have no separate signed
  ledger commitment. The backend and its configured policy remain trusted.
- Demo login and the previously recorded privacy/trust limits still apply.

## Reproduce and next work

After installing the normal backend/chaincode dependencies, run `npm test` in
backend, frontend, policies, chaincode/crimerecords and experiments/dias-finetuning/v2.
Run `npm run check` in frontend. Then:

```sh
node experiments/evaluate-counterfactuals.js NEW_OUTPUT_DIRECTORY
node experiments/check-counterfactuals-live.js NEW_LIVE_DIRECTORY DENIED_ID ALLOWED_ID
```

The live command requires the configured host and existing demo decisions. The
optional trailing arguments are a court own-request ID, auditor own-request ID
and a pre-change detail file. Tokens stay in memory and are not saved. Configs,
source digests, logs and failure attempts are retained with this run.

What worked: verified, minimal hypotheticals with explicit authority, immutable
facts, digest/policy binding and the existing visibility boundary. What is weak:
limited coverage and no independent validation of policy or prose. Next: step 15
updates the testbed scripts, legacy acceptance runner and final contract label
before any experiment rerun. Mobile synchronization remains separate work.
