# Iteration 41 — Single-device auditor handoff and accurate request logs

Date: 2026-09-14

## Goal

Make the intended DIAS interaction visible on the single-device demonstration:
the requester searches for a case file, explicitly submits an access request,
and a separate auditor window presents the advisory LLM result plus the final
Force Allow and Force Deny controls. Make the application access log correlate
that action with the committed Fabric request.

## Root cause of the confusing access log

Three separate behaviors looked like one missing log. A search was only a
public lookup and did not create an access request; the UI called the next step
`Get detail`, so that boundary was unclear. When a request was created, its
application event did not yet know the Fabric-generated request ID, and the
access-log table did not display the structured target at all. During the live
check, the API had also been started with the repository's legacy
`crimerecords` default rather than the separate `diasrecords` deployment. The
live API was restarted against `diasrecords`; no chaincode was redeployed or
modified for that correction.

## What changed

- Search is now explicit about its boundary: lookup is public and logged, while
  `Request access` starts DIAS and commits an access request.
- A direct case-file number is verified through a public-index backend endpoint;
  a nonexistent identifier is no longer displayed as found.
- The request click synchronously prepares a separate window, clears its copied
  session storage, and later routes it to the exact committed request.
- After an independent AuditMSP login, the auditor-review module automatically
  opens that request's existing review dialog. It does not transfer requester
  credentials or auditor authority.
- The post-response access logger now receives the Fabric-generated request ID.
  Its structured target includes the record, action, purpose and processing
  path, but never the user's free-text justification.
- The access-log UI gained a `Record / request` column and readable labels for
  current DIAS routes.

## Verification evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Frontend unit suite | PASS | 27/27 tests; syntax check passed |
| Backend unit suite | PASS | 175/175 tests |
| Request-to-auditor handoff | PASS | Request `REQ-ce193a12f3eaa10e` opened directly after independent auditor sign-in |
| Auditor decision UI | PASS | Model status, verified request facts, Force Allow and Force Deny rendered; blank-reason validation worked |
| Access-event correlation | PASS | Fabric transaction `c7a8cc93124eaeb95b0db231facfc28612401e1dc5a040de57a8e9fd44406a68` contains record `12345`, request ID, action and purpose |
| Access-log table | PASS | The correlated target rendered in the new column |
| Access-log refresh | PASS | The newest ledger read appeared after Refresh |
| Fabric integrity description | PASS | UI reported `intact` for 235 events on `diasrecords` |
| Dynamic-authorization inspection | PASS | Creation and revocation lifecycle events rendered for `AUTH-0fc08dfa8f18d5ca` |
| Safe primary navigation | PASS | Twelve navigation controls opened their expected screens without a visible load failure |
| Browser console | PASS | No warnings or errors after the smoke flow |
| Fresh V7 live inference | NOT RUN | The already-running final V7 evaluation owned port 8082; application inference on 8081 was not started or redirected |

The full structured run record is
`experiments/runs/20260914_single_device_auditor_handoff/browser-smoke.json`.

The navigation smoke covered Cases, File a record, Search case files, Evidence,
Audit trail, Payload integrity, Departments, Register an officer, Officer
directory, Ask the LLM, Auditor review and Access log. It intentionally did not
submit data-changing forms.

## What worked

The missing request-log evidence is now present on Fabric and readable in the
frontend. The exact request, record, action and purpose can be correlated using
one transaction. Existing genuine ALLOW and DENY recommendations render in the
auditor interface, while the deliberately exercised no-model path remains
fail-closed and still reaches the auditor with both final controls.

## What failed or remains weak

- The application model endpoint was unavailable during this iteration because
  the final V7 evaluation was already using the model runtime. Therefore this
  run proves the existing-recommendation UI and the UNAVAILABLE/fail-closed path,
  not a new V7 recommendation generated through the application.
- The synthetic browser request remains `awaiting-auditor`. No final decision
  was recorded because clicking Force Allow or Force Deny would create a real,
  immutable governance event. Only the mandatory-reason validation was tested.
- Revoke was not clicked for the same reason; its read-only history view was
  tested instead.
- Historical access-log rows retain their original generic action labels because
  Fabric history is immutable. New rows use the corrected DIAS labels.

## Next experiment

After the current V7 evaluation finishes, keep training stopped as requested.
Start an application model endpoint only with a model/adapter identity that
matches the Fabric registration, then submit one new ALLOW-oriented and one new
DENY-oriented request through the frontend. Record latency, raw recommendation,
auditor decision, transaction IDs and the resulting request trails. Do not
register V7 or treat it as the live model until its completed evaluation
artifacts satisfy the documented gates.
