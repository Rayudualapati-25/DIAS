# Iteration 060 — grant re-check at the final document download

- **Date:** 2026-10-01
- **Plan step:** 4
- **Requirements:** A01, and M20 apart from the policy binding (step 8)

## What changed

- **`RecordContract.AuthorizeRequestedDocumentRead`** now runs the same grant check as the other release paths (`_requireGrantedDecision`):
  - the decision belongs to the caller, is granted, and is for `view`;
  - the requester's ledger profile and certificate are both active;
  - for a reused grant, the dynamic authorization is still active and unexpired.
- **Reused grants** also have their scope compared with the grant, field by field:
  - requester, record, case, action and purpose.
  - This applies to every release path, because they share `_requireCurrentGrantBasis`.
- **Backend:** the download handler moved into `releaseDocument()` in `backend/src/routes/records.js`, so it can be tested.
  - Its order is unchanged: ledger re-check, then vault read, then content-hash comparison, then delivery.

## Tests

- **Written first:** `chaincode/crimerecords/test/diasRelease.test.js`, 9 tests over the real workflow (request, decision or reuse, full-document request, owner upload, download).
  - Before the change, 7 failed: suspended profile, revoked profile, revoked certificate, revoked authorization, expired authorization, scope mismatch, decision no longer granted.
  - The 2 that already passed: a normal release, and refusal to another identity.
- **Also written first:** `backend/test/documentRelease.unit.test.js`, 4 tests.
  - The vault is read only after the ledger re-check; nothing is read when the ledger refuses; a hash mismatch gives 409; a malformed id gives 400.
- **Fixture update:** `recordContract.test.js` "release re-checks the grant basis".
  - Its hand-built authorization had no scope, which the contract never writes.
  - It now carries the scope a real authorization has.
  - The behavior it tests is unchanged.
- **Full suites:** chaincode 230 passing (92.12% statements); backend 201 passing.

## What is weak

- A policy change between approval and download is not tested yet: the policy binding arrives in step 8.
- Release is checked by an evaluate call, so the release itself is not a ledger transaction. The access log records it (`document.release`).

## Next

Step 5: separate requester claims from verified facts.
