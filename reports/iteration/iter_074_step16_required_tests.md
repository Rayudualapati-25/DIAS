# Iteration 074 — step 16, offline part: required-test matrix

Date: 2026-10-09. Plan: `experiments/plans/20261009_step16_offline_verification.md`.
Evidence: `experiments/runs/20261009_step16_offline/`. Table:
`results/tables/20261009_step16_required_tests.csv`.

All results below are offline unit and contract tests on the mock Fabric stub.
None of them is a live Fabric, testbed or model result.

## What changed

1. Listed every chaincode and backend test title and matched each of the 11
   required step-16 tests to the tests that prove it.
2. Found one partial gap (R16-11, complete audit trail). The existing trail tests
   checked the stages and the three transactions, but not that the committed
   digests can be recomputed from the trail. Added one contract test in
   `chaincode/crimerecords/test/diasAuditTrail.test.js`:
   "reconstructs every commitment of a reviewed request from the trail alone".
   It checks, from the trail only:
   - h_J equals the hash of the justification;
   - h_M equals the hash of the recommendation object;
   - the κ signature verifies with the registered key, and fails for a changed value;
   - h_N in the decision equals the hash of the note;
   - request, κ, decision, outcome and authorization carry the same policy version and hash;
   - the transactions appear in order (request, κ, decision) and a later revocation is shown.
3. No contract or backend code changed.

## Matrix

| ID | Required test | Proven by (main tests) | Status |
|---|---|---|---|
| R16-01 | Inactive auditor rejected | `diasAuditorAuthority.test.js` (suspended, revoked, inactive certificate, no profile) | covered |
| R16-02 | Inactive requester rejected at release | `diasRelease.test.js` (suspended, revoked, inactive certificate); `recordContract.test.js` | covered |
| R16-03 | Revoked and expired authorization rejected at download | `diasRelease.test.js` (revoked, expired, scope changed) | covered |
| R16-04 | Old-policy authorization rejected | `diasPolicyBinding.test.js` (reuse, release, decision) | covered |
| R16-05 | Changed justification, recommendation or note detected | `offChainVerification.unit.test.js`; `recommendationIntegrity.unit.test.js`; `commitments.test.js` | covered |
| R16-06 | Missing, duplicate or wrong commitment rejected | `diasRecommendationCommitment.test.js`; `diasNoteCommitment.test.js` | covered, see note |
| R16-07 | Missing note rejected | `diasNoteCommitment.test.js`; `auditorNote.unit.test.js` | covered |
| R16-08 | Unauthorized explanation access rejected | `diasPrivacy.test.js`; `diasRecommendationDetail.unit.test.js` | covered |
| R16-09 | Pending request expires correctly | `diasRequestLifecycle.test.js`; `expirySweeper.unit.test.js` | covered |
| R16-10 | Recommendation signature verified | `diasRecommendationCommitment.test.js`; `signedRecommendation.unit.test.js` | covered |
| R16-11 | Complete audit trail reconstructed | `diasAuditTrail.test.js` (new test) ; `offChainVerification.unit.test.js` | gap closed |

Note on R16-06: a *missing* commitment is not a hard rejection by design
(design §7). The decision is recorded as NO_RECOMMENDATION with status
NOT_COMMITTED, and it is refused unless a note digest is given. Duplicate
(identical) commitments are a safe retry; conflicting and wrongly bound ones are
rejected without writes.

## Test results

| Suite | Before | After |
|---|---|---|
| Chaincode | 341 | 342 (1 new) |
| Backend | 313 | 313 |
| Policies | 27 | 27 |
| Frontend | 77 | 77 |
| Dataset | 104 | 104 |

Mutation check: changing the expected note text in the new test made it fail.

## Not run - needs the author's Mac

- The same 11 checks on the live v3 network (deploy 3.0, then the testbed acceptance run).
- Multi-VM tests, live UI checks, the Android emulator.

## Worked, weak, next

- **Worked:** every required test maps to at least one test that asserts the outcome.
- **Weak:** all evidence is from the mock stub. The stub does not prove Fabric
  endorsement, MVCC conflicts or history ordering on a real peer.
- **Next:** step 17 offline microbenchmarks (iteration 075).
