# Iteration 071 — keep the LLM explanation only

- **Date:** 2026-10-08.
- **Author instruction:** remove counterfactual explanations and any additional explanation generated from ledger facts. The existing LLM account is sufficient for the requested system.
- **Plan:** `experiments/plans/20261008_counterfactual_removal.md`.
- **Run:** `experiments/runs/20261008_counterfactual_removal/`.
- **Historical baseline:** commit `dd099b7` and its retained run. It is superseded by this removal.

## What changed

1. Removed the runtime generator and its reference-oracle path. The recommendation-detail API returns its original LLM account, without a `counterfactuals` field, policy-bundle load or hypothetical search.
2. Removed the panel from requester explanations, decision-log detail and auditor review. Removed the second explanation-detail fetch added when opening auditor review; its existing review response already contains the model account.
3. Removed the feature toggle and feature-specific tests. Restored the architecture guard that forbids the reference oracle from all live backend entry points. Existing ledger authorization, integrity checks, LLM text and auditor decisions remain in place.
4. Retired the two counterfactual experiment entry points. Their source and feature tests are preserved under this run's `removed-source/`; the earlier results, configs and logs remain unchanged. Reproduce the earlier experiment in a separate checkout of `dd099b7`.
5. Updated the design, traceability and plan to withdraw M25 and step 14. Iteration 070 and its plan now carry historical labels. The separate manuscript still needs its contribution claim removed during the planned manuscript revision.

## Verification and removal ablation

| Check | Result | Evidence within this run |
| --- | --- | --- |
| Restored oracle guard against the previous implementation | 13 passed, 1 expected failure: oracle reachable from server and access route | `architecture-before.log` |
| Backend after removal | 319 passed, including runtime architecture and existing explanation/privacy checks | `backend-tests.log` |
| Frontend after removal | 77 passed | `frontend-tests.log` |
| Frontend syntax | passed | `frontend-syntax.log` |
| Ten modified runtime/config/test files restored | byte-for-byte equal to the parent of the feature commit | `static-checks.json` |
| Extra auditor detail request and active counterfactual references | absent | `static-checks.json` |
| Live API checks | 11 passed, zero failed | `live/live.json` |
| Original LLM fields and committed decision | exactly match the saved current pre-removal response | `live-before.json`, `live/live.json` |
| Browser auditor decision detail | original written reason visible; counterfactual panel absent | `llm-only-panel.txt`, `llm-only-panel.png` |

The backend/frontend totals fall by 22 and 5 respectively because tests for the
withdrawn feature were removed; the remaining suites pass. Counts include the
older uncommitted mobile tests in this worktree. No clean-clone result is claimed.
No chaincode was edited or redeployed, so its previously passing suite was not
repeated. No model invocation or training change was needed.

This is the whole-component removal ablation. The comparison table records
observable component presence, oracle reachability, API field presence and the
additional fetch in the review source. It does not report milliseconds or an
end-to-end latency reduction. The former experiment only established consistency
with its own checker; its metrics do not establish independent explanation
quality or support.

Table: `results/tables/20261008_counterfactual_removal.csv`.

Live checks use existing synthetic denied/allowed decisions and the existing
own-request decisions of `judge.rana` and `dj.north`. They verify unchanged LLM
content and decision, allowed-request withholding, authorized auditor access,
other-organization refusal, anonymous refusal and malformed-ID refusal. Tokens
stay in memory. No new business request, decision or grant was submitted;
sensitive reads append normal Fabric access-log events.

Only the backend was restarted. The model on port 8081 and the Fabric network
were preserved. Older uncommitted mobile/host files remain outside this change.

## What worked, limits and next work

- **Worked:** complete removal from runtime and UI; the original LLM account and existing privacy behavior pass unit and live regression checks. The extra auditor fetch is removed.
- **Weak or unmeasured:** no controlled end-to-end latency measurement, no LLM explanation-accuracy evaluation and no four-VM rerun. A waiting auditor dialog and requester history were not exercised live; their source was restored and existing suites pass. The live browser check exercised the auditor decision-log detail.
- **Next:** proceed with step 15's integration/acceptance scripts under the LLM-only explanation design before testbed reruns. No new explanation layer is planned.

## Reproduce

Run `npm test` in backend and frontend, and `npm run check` in frontend. With
the normal demo host and existing request IDs:

```sh
node experiments/check-llm-detail-only-live.js NEW_OUTPUT_DIRECTORY DENIED_ID ALLOWED_ID BASELINE_DETAIL_FILE COURT_OWN_ID AUDITOR_OWN_ID
```

The last two IDs are optional. Output directories must be new. The baseline
detail file is a saved response without a bearer token. Its recorded explanation
and decision fields are compared exactly with the new response.
