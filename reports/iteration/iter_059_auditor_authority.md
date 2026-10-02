# Iteration 059 — auditor credential, district and clearance

- **Date:** 2026-10-01
- **Plan step:** 3
- **Requirements:** M23, M24 (`docs/design/dias-v3-requirements-traceability.md`)

## What changed

- New `chaincode/crimerecords/lib/dias/auditorAuthority.js`. A decision (`SubmitAuditorDecision`) or a revocation (`RevokeDynamicAuthorization`) now needs:
  - an AuditMSP district-head certificate whose credential is active;
  - a ledger profile that exists, matches the certificate, and is active;
  - the record's district;
  - clearance for the record's sensitivity (design D-03).
- Self-review is still rejected.
- The backend maps the new error codes to HTTP status:
  - `DIAS_AUDITOR_*` and `unauthorized` → 403;
  - timing and state conflicts → 409;
  - other refusals → 422 (`backend/src/util/respond.js`).
- The auditor screen no longer suggests a district head of another district for a self-review handoff.

## Tests

- **Written first:** `chaincode/crimerecords/test/diasAuditorAuthority.test.js`, 10 tests. Before the change, 8 failed and 2 passed: the accepted decision and the self-review refusal.
  - Covers: suspended and revoked profiles, revoked certificate, missing profile, certificate/profile mismatch, other district, low clearance, an accepted decision, self-review, and revocation authority.
  - Each rejection asserts that the request stayed `awaiting-auditor` with no decision record.
- **Also written first:** `backend/test/chaincodeErrors.unit.test.js`, 13 tests.
- **Full suites:**
  - chaincode: 221 passing, 92.09% statement coverage;
  - backend: 197 passing;
  - frontend: 39/39.

## What worked

- No existing test needed changing. The default test auditor is an active district-north head with high clearance.

## What is weak

- Read paths for auditors (pending queue, review, authorization queries) still check only the certificate. Step 13 applies the profile check to them.
- In the prototype the backend holds every auditor's key, so these checks bind the ledger state, not the person at the keyboard.

## Next

Step 4: re-check the grant at the final document download.
