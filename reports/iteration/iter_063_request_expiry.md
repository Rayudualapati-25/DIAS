# Iteration 063 — pending-request expiry, cancellation and late decisions

- **Date:** 2026-10-02
- **Plan step:** 7
- **Requirement:** M27

## What changed

- **On-chain parameter:** `pendingReviewTtlSeconds` (`lib/dias/parameters.js`).
  - Default 72 h; allowed 60 s to 30 days.
  - Set with `GovernanceContract.SetDiasParameters` by an active AuditMSP district head; read with `GetDiasParameters`.
- **Deadline:** a request that waits for review now carries `reviewDeadlineUtc`, computed from the transaction timestamp. An automatic grant carries none.
- **Late decision:** `SubmitAuditorDecision` refuses a decision after the deadline with `DIAS_REQUEST_EXPIRED` and writes nothing.
- **New transactions:**
  - `ExpirePendingRequest`: any member, once the deadline has passed. It records status `expired` and outcome EXPIRED (basis `REVIEW_DEADLINE_PASSED`), and an index entry with status `expired` that release refuses.
  - `CancelAccessRequest`: requester only, while pending; outcome CANCELLED.
  - Each closes the request through its own successful transaction, because a rejected transaction cannot write anything.
- **Lifecycle events:** `REQUEST_EXPIRED` and `REQUEST_CANCELLED`.
- **Backend:**
  - an expiry sweeper (`backend/src/dias/expirySweeper.js`, every `DIAS_EXPIRY_SWEEP_SECONDS`, default 300 s) submits `ExpirePendingRequest` for overdue requests;
  - a decision refused as expired triggers the same transaction;
  - new route `POST /access/request/:id/cancel`, logged as a ledger write.
- **Frontend:** expired and cancelled labels; the review deadline and a Cancel button on a pending request.

## Tests

- **Chaincode:** `diasRequestLifecycle.test.js`, 10 tests, all failing before the change. Covers:
  - default and configured deadlines; parameter authority and validation;
  - rejected late decisions; expiry before and after the deadline; repeated expiry;
  - cancellation by requester and by others; cancellation after a decision;
  - no release for expired requests; a new request after expiry.
  - Suite: 272 passing.
- **Fixture update:** `diasAccessWorkflow.test.js` "returns the newest entries first" decided four weeks after submission. Its decision times now fall inside the deadline; the ordering it tests is unchanged.
- **Backend:** sweeper tests, overdue-decision test, cancel-route classification. Suite: 228 passing.
- **Frontend:** status labels. 40/40.

## What is weak

- The sweeper runs as an AuditMSP district head (the sign-in identity). In this prototype the backend holds that key.
- A request expires on the ledger only when someone submits the expiry. Until then, the contract still refuses any decision after the deadline.
- The Cancel button was not checked in a browser: the screen needs the backend, and the backend needs a running Fabric network.

## Next

Step 8: governed policy versions and policy binding, including expiry after a policy change.
