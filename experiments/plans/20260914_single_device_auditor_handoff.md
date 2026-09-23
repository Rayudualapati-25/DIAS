# Single-device auditor handoff and access-log correction

Date: 2026-09-14

## Problem

The requester can submit a DIAS request, but the auditor must independently
discover it in the auditor queue. On the single-device research setup this
makes the intended handoff look incomplete. The access-log view also omits the
record and request identifiers, and a direct case-file lookup currently shows a
success card without first proving that the identifier exists.

## Security invariant

The policy model remains advisory. A requester session must never receive
auditor privileges. An exact active dynamic authorization may grant access;
otherwise only an authenticated AuditMSP auditor may record FORCE_ALLOW or
FORCE_DENY.

## Smallest working implementation

1. Pre-open a separate, credential-clean auditor window from the requester's
   explicit access-request click so browser popup blocking cannot lose the
   handoff.
2. When the request reaches `awaiting-auditor`, route that window to the exact
   request. After auditor sign-in, automatically open the existing review
   dialog containing the LLM recommendation and FORCE_ALLOW/FORCE_DENY.
3. Rename the ambiguous requester action to `Request access` and verify direct
   record identifiers through a public lookup endpoint before presenting it.
4. Attach the committed request ID to the application access event and show
   record/request target fields in the access-log table.
5. Preserve a manual `Open auditor window` fallback and the existing `Check
   current status` control.

## Acceptance checks

- An access-request click opens a separate waiting window without copying the
  requester token.
- An auditor can sign in there and is taken directly to the correct review.
- The review visibly distinguishes advisory LLM output from the auditor's final
  authority and exposes both FORCE_ALLOW and FORCE_DENY.
- A nonexistent record is not displayed as found.
- Fabric application logs show the searched record and the DIAS request ID.
- Backend and frontend unit tests, syntax checks, and a browser smoke test pass.
- Full LLM inference is not started or redirected while the already-running V7
  evaluation owns the model process.

## Evidence to retain

Test output and browser observations will be recorded in the corresponding
iteration report. Any flow that cannot be exercised while the V7 evaluation is
running will be reported as not tested rather than inferred.

## Status

Implemented and verified on 2026-09-14. The browser smoke test, structured run
record, comparison table and limitations are recorded in:

- `experiments/runs/20260914_single_device_auditor_handoff/browser-smoke.json`
- `results/tables/dias_frontend_handoff_checks.csv`
- `reports/iteration/iter_041_single_device_auditor_handoff.md`
