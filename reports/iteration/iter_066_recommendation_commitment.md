# Iteration 066 — pre-review recommendation commitment κ

- **Date:** 2026-10-02
- **Plan step:** 10. The chaincode half of step 12 (the signer registry) is included, because κ cannot be verified without it. The separate service process stays in step 12.
- **Requirements:** M07, M08, M09, M12, M14, M15, M18, M22, M26 done; M10 done in the backend and the browser (screen check in step 15); M13, M19, I07 and A05 partly.

## What changed

- **Contract:**
  - `CommitRecommendation(requestId, commitmentJson)` stores κ before review. It checks, writing nothing on any failure:
    - the request is v3, awaiting review and before its deadline;
    - the active policy is the request's policy;
    - the context, claims and justification digests equal the request's;
    - status and value are consistent;
    - the signer key is registered and active, and the Ed25519 signature verifies.
  - An identical resubmission is a safe retry that writes nothing; a different κ for the same request is refused (`DIAS_COMMITMENT_CONFLICT`).
  - `SubmitAuditorDecision(requestId, decision, noteHash, validUntilUtc)` has no recommendation parameter. The contract reads κ and derives the agreement (paper Eq. 3):
    - no κ: NO_RECOMMENDATION, recorded as `NOT_COMMITTED`;
    - a κ whose status is not OK: NO_RECOMMENDATION with that specific status.
  - The decision, outcome and any authorization carry the κ id, `h_M` and the specific status. An authorization is created only for FORCE_ALLOW over a committed OK DENY.
  - New events: `RECOMMENDATION_COMMITTED` and `AGREEMENT_DERIVED`.
  - New reads: `GetRecommendationCommitment`. `GetAuditorReview` and `QueryPendingAuditorRequests` now return `{request, commitment}`, and the audit trail shows κ.
  - Signer registry (GovernanceContract): `RegisterRecommendationSigner`, `RevokeRecommendationSigner` (a reason is required), `QueryRecommendationSigners`. Only an active AuditMSP district head may change it.
- **Backend:**
  - The recommendation object M (`dias-recommendation-object-v1`) holds the status, the value, the normalized output, the bindings and the model. It holds no timing, so the same model output always gives the same `h_M`.
  - The recommendation service recomputes the context, claims and justification digests and checks its policy before judging.
    - On a mismatch it does not judge: it signs a specific failure status instead.
    - It has no Fabric identity; a guard test checks that it cannot reach the Fabric gateway or the policy oracle.
  - The worker moves each entry through `pending → signed → committed`:
    - `commit-rejected` when the ledger refuses κ for a reason a retry cannot fix;
    - `failed` when the service could not answer.
    - A `signed` entry survives a crash and is resubmitted unchanged; an uncertain submission is settled by reading κ back from the ledger.
  - The decision route reads κ from the ledger. It refuses (409) while κ is still being prepared, or when the stored M does not match κ or is missing. It sends only the note digest `h_N`.
  - Scripts: `scripts/dias/recommender-key.js` creates the key; `scripts/dias/register-recommender-key.js` registers it. `make dias-seed` now includes `seed-recommender`. **Not run against the live network.**
- **Browser:**
  - The auditor screen recomputes `h_M` and checks the value, status and every binding against κ.
  - It shows "Checked against the ledger" with the commitment id, short `h_M` and signer key, or a mismatch warning.
  - The decision buttons stay disabled on a mismatch, a missing object, or a κ not yet on the ledger.
  - Every consequence shown (agreement, authorization, reason required) comes from κ, not from the backend's stored record.
  - The justification panel now also checks the shown text against the ledger's `h_J`.

## Tests

- **Contract:** `diasRecommendationCommitment.test.js`, 22 tests, written before the code:
  - signer registry: 3;
  - acceptance: 4;
  - rejection, including replay onto another request and a commitment changed after signing: 5;
  - Eq. 3: 4 recommendation/decision pairs, 4 failure statuses, the no-κ case, and the removed recommendation parameter.
- **Backend:**
  - new suites: `recommendationObject` (5), `recommendationService` (8), `recommendationIntegrity` (4), `signerRegistration` (3), `diasRuntime` (2);
  - route and worker tests rewritten for v3: 17 new or replaced tests.
- **Browser:** 3 tests: integrity verification, decision blocking, consequences from κ.
- **Changed baseline expectations, each an intended v3 change:**
  - **Event lists** (`diasAccessWorkflow.test.js`): `RECOMMENDATION_COMMITTED` and `AGREEMENT_DERIVED` are now stages (design §6, §7).
  - **Audit trail** (`diasAuditTrail.test.js`): 2 transactions become 3 (request, κ, decision), as in Algorithm 1. The request key history grows from 2 to 3 entries, because `CommitRecommendation` records the κ id on the request.
  - **Decision checks** (`diasAccessSecurity.test.js`): the v2 checks on a caller-supplied `llmRecommendation` are gone with the parameter. Malformed values are now refused when κ is committed.
  - **Pending queue shape:** `{request}` becomes `{request, commitment}`.
  - **Architecture guards:** the v2 rule "no recommendation module or signer at all" becomes:
    - chaincode loads only the commitment module, never a model, parser, prompt or network call;
    - the signing service has no Fabric identity;
    - the retired AI-organization modules stay deleted.
  - **Moved, not dropped:** the v2 worker tests "never prompt the model with facts, claims or justification that do not match their digests" now live in `recommendationService.unit.test.js`. The context and claims cases were restored there in this step after review, so all three cases are tested again.
- **Suites:**
  - chaincode 312 passing (statements 92.66%, branches 85.62%);
  - backend 259 passing (statements 81.74%);
  - frontend 48/48;
  - policies 27/27;
  - dataset 104/104.

## What is weak

- **What a signature proves.** It proves only that the holder of a registered key produced this exact M for this request under this policy. It does not prove the recommendation is right, that an LLM wrote it, or that the configured model ran (design §6.1).
- **Key custody.** Until step 12, the signing key sits in the backend process ("embedded mode"). A compromised backend can therefore sign. The relay can also withhold κ: the decision is then recorded as NO_RECOMMENDATION / `NOT_COMMITTED`, visibly, but it is not prevented.
- **The note is not yet required.** The contract validates `noteHash` but requires it only from step 11. The backend still writes the note after the decision commits, which is the step 11 change.
- **Not run.** Nothing in this step was run on Fabric, the testbed or the model server. The key scripts and `seed-recommender` are untested against a live network.

## Next

Step 11: the contract requires `h_N` for NOT_AGREED and NO_RECOMMENDATION; the backend stages the note durably before submitting, settles uncertain commits, and recovers staged notes on restart.
