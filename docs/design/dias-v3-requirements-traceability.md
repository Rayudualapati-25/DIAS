# DIAS v3 — requirements traceability

Each requirement traces: paper requirement → current behavior → required change → affected files → tests → evidence → status. It has a stable identifier and an acceptance criterion. A requirement is marked done only when its criterion is met by a test or an artifact named in the row.

- **Sources:**
  - paper v13 (§IV Methodology, Algorithm 1, Tables II and V, §V Implementation, §VII);
  - `reports/paper_code_alignment_audit.md` (2026-09-28);
  - the system verification of 2026-09-24 (gaps: optional expiry, no policy version, backend-trusted agreement), restated in the plan.
- **Baseline:** tag `eval-baseline-2026-10-01` (`2336bb4`). "Current behavior" describes that tag, rechecked against the code on 2026-10-01.
- **Design:** `docs/design/dias-v3-ledger-schema.md` (D-nn refers to its decisions).

**Classification at baseline:**

| Code | Meaning |
|---|---|
| OK | Already implemented and verified |
| PART | Partially implemented |
| MISS | Missing implementation |
| TEXT | Contradictory manuscript description (fix the text, not the code) |
| EXP | Requires a new experiment |
| OUT | Outside the approved scope |

**Progress values:**
- `planned (step n)`;
- `done (step n)` with its tests;
- `prepared, not run` for experiments that need the author's Mac.

## Summary

| ID | Requirement | At baseline | Step | Progress |
|---|---|---|---|---|
| M01 | Exact-match reuse checked first, in the request transaction | OK | — | done (baseline) |
| M02 | Verified context C built from authenticated facts; `h_C` stored | OK | 5 | done (step 5; `diasSchema.test.js`, `diasAccessSecurity.test.js`) |
| M03 | Requester claims kept out of the verified context | MISS | 5 | done (step 5); label invariance 8,013/8,013; V7 re-evaluation NOT RUN |
| M04 | `h_J` recorded on-chain with the request | MISS | 9 | done (step 9; contract, backend, browser recomputation) |
| M05 | Active policy version recorded in the request | MISS | 8 | done (step 8; `diasPolicyBinding.test.js`) |
| M06 | Reuse requires the active policy version | MISS | 8 | done (step 8; `POLICY_CHANGED` miss) |
| M07 | κ committed before review | MISS | 10 | done (step 10; `diasRecommendationCommitment.test.js`, `diasBackendRecommendation.unit.test.js`) |
| M08 | One active κ per request; mismatched `h_C` or `v_P` rejected | MISS | 10 | done (step 10; idempotent retry, conflict and binding rejections write nothing) |
| M09 | Specific generation status on-chain | PART | 10 | done (step 10; all five statuses kept in κ and in the decision) |
| M10 | Auditor interface verifies H(M) = `h_M` and M against κ before deciding | MISS | 10, 15 | backend and browser done (step 10; `recommendationIntegrity.unit.test.js`, `accessDias.unit.test.js`, `dias.test.mjs`); screen check in step 15 |
| M11 | Note stored off-chain before the decision; `h_N` in the transaction | MISS | 11 | done (step 11; `diasNoteCommitment.test.js`, `auditorNote.unit.test.js`) |
| M12 | Contract derives agreement from κ; backend supplies neither q nor g | PART | 10 | done (step 10; Eq. 3 table over every combination; no recommendation parameter) |
| M13 | Fail-closed decision checks | PART | 3, 8, 10, 11 | done (steps 3, 8, 10, 11; each rejection writes nothing) |
| M14 | Authorization only for FORCE ALLOW over a valid DENY | OK | 10 | done (step 10; derived from κ, Eq. 3 table) |
| M15 | Authorization stores `v_P` and the κ reference | PART | 8, 10 | done (steps 8 and 10; κ id and `h_M` on the authorization) |
| M16 | Authorization lifecycle, revocation reason, supersession | OK | — | done (baseline) |
| M17 | Policy change stops reuse; reissue under the new policy | MISS | 8 | done (step 8; reissue supersedes) |
| M18 | Lifecycle events for recommendation commitment and agreement derivation | PART | 10 | done (step 10; `diasAccessWorkflow.test.js`, `diasAuditTrail.test.js`) |
| M19 | Off-chain objects verifiable against on-chain hashes | MISS | 9–11 | done (steps 9–11; `offChainVerification.unit.test.js`: verified, mismatch, missing, not-committed); tamper experiment in step 17 |
| M20 | Release re-checks outcome, credential, authorization and `v_P` | PART | 4, 8 | done (steps 4 and 8; `diasRelease.test.js`, `diasPolicyBinding.test.js`) |
| M21 | Trust model states the backend's role | TEXT/PART | 12 | design text done (design §2, 2026-10-08): the backend asks the LLM and holds the signing key; the paper text still has to change |
| M22 | Ledger keeps value, status and fingerprint if off-chain data is lost | MISS | 10 | done (step 10; κ in the audit trail without the review store) |
| M23 | No self-review | OK | 3 | done (step 3; `diasAuditorAuthority.test.js`) |
| M24 | Auditor authority: AuditMSP district head, active credential, district | PART | 3 | done (step 3; `diasAuditorAuthority.test.js`, `chaincodeErrors.unit.test.js`) |
| M25 | Counterfactual explanation (C3) | MISS | 14 | withdrawn by the author, 2026-10-08; runtime removed and existing LLM account preserved (iteration 071); manuscript claim still needs removal |
| M26 | Two pre-review commits and one atomic final commit (Algorithm 1) | PART | 10, 11 | done (steps 10, 11; three transactions in `diasAuditTrail.test.js`; note staged before the decision) |
| M27 | Pending requests end (expiry, cancellation, late decisions) | MISS | 7 | done (step 7; `diasRequestLifecycle.test.js`, `expirySweeper.unit.test.js`); policy-change expiry in step 8 |
| I01 | Table V contracts and transactions | OK | 15 | planned (table update) |
| I02 | Identity and role from the certificate and committed profile | OK | — | done (baseline) |
| I03 | Success reported only after commit | OK | — | done (baseline) |
| I04 | Access-log entries defined and measured | PART | 6 | done (step 6; `accessLogger.unit.test.js`; replay −47.6% / −68.1% writes) |
| I05 | Prompt marks facts as authoritative and J as untrusted | OK | 5 | done (prompt v2; v1 frozen and checked against every tracked prompt) |
| I06 | Response schema check; failure is a status, not a DENY | OK | — | done (baseline) |
| I07 | Review store tamper-evident and protected | PART | 9, 13 | done: justification, recommendation and note tamper-evident (steps 9–11) and encrypted at rest (step 13) |
| I08 | No written-policy engine in the contract | OK | 14 | done; contract unchanged and reference oracle again forbidden from all live backend entry points (iteration 071) |
| A01 | Final PDF download re-checks the grant | MISS | 4 | done (step 4; `diasRelease.test.js`, `documentRelease.unit.test.js`) |
| A02 | Record history, evidence and decision log restricted | MISS | 13 | done (step 13; `diasPrivacy.test.js`); redeployed on the development host on 2026-10-08 and checked live (`experiments/runs/20261008_step13_redeploy/`) |
| A03 | Explanation and off-chain object access defined and enforced | PART | 13 | done (step 13; requester rule changed by the author on 2026-10-08; `diasRecommendationDetail.unit.test.js`, `offChainVerification.unit.test.js`) |
| A04 | Off-chain review data encrypted | MISS | 13 | done (step 13; `reviewStoreEncryption.unit.test.js`) |
| A05 | Signed recommendation provenance; no AI organization | MISS | 10, 12 | signing, signer registry, revocation and replay rejection done (step 10); the separate process was dropped by the author on 2026-10-08, so the backend holds the key |
| A06 | Maximum authorization validity (null expiry never ends) | OUT | — | open researcher decision |
| A07 | Identity and record id inside C (§IV-C) | TEXT | — | text fix |
| A08 | Result numbers (23.75%, 60.27%, E7 failures, Fig. 13 memory, loss range) | TEXT | — | text fix |
| A09 | Scripted auditor disclosed for every experiment | TEXT/EXP | — | text fix; human study OUT |
| A10 | Reproducibility: prepare-chaincode script, pinned Python, figure scripts, V6 preflight | PART | 15, 19 | deterministic preparation, source staging and observed manifest inputs done (iteration 073); pinned Python and final reproduction remain step 19 |
| A11 | Public-release hygiene: home paths, third-party PDFs, licences, legacy code | MISS | 19 | planned |
| A12 | Model input change re-evaluated | EXP | 17 | planned (prepared, not run) |
| A13 | v3 performance re-measured (reuse, load, faults, resources, ledger growth) | EXP | 17 | planned (prepared, not run) |
| A14 | Integrity cost and tamper detection measured | EXP | 17 | planned (offline) |

## Details

Each entry: current behavior → required change; files; tests; evidence; acceptance criterion.

### M01 — Exact-match reuse first
- **Paper:** §IV, §IV-C, Algorithm 1 lines 3–9.
- **Current:** `CreateAccessRequest` reads the latest authorization for σ and grants on MATCH in the same transaction (`lib/accessContract.js`).
- **Change:** none. v3 adds the policy condition (M06).
- **Tests:** `diasAccessWorkflow.test.js` "reuse of an active dynamic authorization".
- **Acceptance:** a matching request is granted without an auditor decision or κ, with an `AUDITOR_REVIEW_SKIPPED` event.

### M02 — Verified context
- **Paper:** §IV-C; Table II.
- **Current:** C is built from the certificate, ledger profile, case assignment and record; `h_C` is stored (`lib/dias/verifiedRequest.js`).
- **Change:** schema `dias-verified-context-v3`, domain-separated hash (`context`), no requester claims.
- **Tests:** `diasAccessSecurity.test.js`, `commitments.test.js`.
- **Acceptance:** C contains only the listed fact fields; `h_C` is recomputed identically by the contract and the backend.

### M03 — Claims separated from facts
- **Paper:** §IV-C ("verified context ... from committed or authenticated facts"); brief item D.
- **Current:** `emergencyFlag` (self-declared) and `approvalTokenPresent` (constant `false`, no supporting mechanism) sit inside `verifiedRequest.request`.
- **Change:**
  - claims object K `{emergencyDeclared}` with `h_K`, outside C;
  - `approvalTokenPresent` removed;
  - prompt v2 shows K as unverified;
  - the dataset keeps prompt v1.
- **Files:** `lib/dias/verifiedRequest.js`, `lib/accessContract.js`, `backend/src/routes/access.js`, `backend/src/dias/recommendationPrompt.js`, frontend request and auditor screens, `experiments/dias-finetuning/v2/eval/runner.js`.
- **Tests:** chaincode schema test; backend prompt test; label-invariance check.
- **Acceptance:**
  - no verified-context field is supplied by the requester;
  - the policy oracle gives identical labels with and without the removed flags on every dataset case;
  - V7 re-evaluation on prompt v2 is listed as NOT RUN.

### M04 — `h_J` on-chain
- **Paper:** §IV-C, Algorithm 1 lines 2 and 6.
- **Current:** justification hash only in off-chain provenance.
- **Change:** the backend computes `h_J` (domain `justification`) and passes it in the request; the contract validates and stores it.
- **Tests:** chaincode request test; backend route test; tamper test.
- **Acceptance:** an altered justification fails verification against the request's `h_J`.

### M05, M06, M17 — Policy binding
- **Paper:** §IV-C, §IV-F, §IV-G; Algorithm 1 lines 5–6, 24–25, 36; Table II.
- **Current:** no policy version anywhere in the DIAS contract.
- **Change:**
  - governed policy registry (§5 of the design);
  - binding in request, κ, decision, authorization and outcome;
  - match returns `POLICY_CHANGED`;
  - decisions and release refused under a stale policy.
- **Files:** `lib/governanceContract.js`, new `lib/dias/policyRegistry.js`, `lib/accessContract.js`, `lib/dias/authorization.js`, `lib/recordContract.js`, seed scripts.
- **Tests:** policy registry tests (two-person activation, no re-activation); policy-change tests for reuse, decision and release.
- **Evidence:** offline policy-invalidation experiment.
- **Acceptance:** after activation of a new version, no authorization, pending decision or grant from the old version is accepted, and reissue under the new version supersedes the old authorization.

### M07, M08, M09, M12, M18, M22, M26 — Pre-review commitment κ
- **Paper:** §IV-B, §IV-D Eq. (2), §IV-E Eq. (3), §IV-G; Algorithm 1 lines 10–16, 28.
- **Current:** `SubmitAuditorDecision(requestId, decision, llmRecommendation, validUntil)` receives the value at decision time; status collapses to UNAVAILABLE; no κ.
- **Change:**
  - `CommitRecommendation` (design §6);
  - the decision derives agreement from κ;
  - all statuses on-chain;
  - `RECOMMENDATION_COMMITTED` and `AGREEMENT_DERIVED` events.
- **Files:** new `lib/dias/recommendationCommitment.js`, `lib/accessContract.js`, `lib/dias/lifecycle.js`, backend worker.
- **Tests:** commitment tests (missing, duplicate, conflicting, wrong context, wrong policy, wrong claims, wrong justification, inconsistent status); agreement tests for all decision/recommendation combinations.
- **Acceptance:**
  - every combination yields the agreement of Eq. (3);
  - only FORCE_ALLOW over a committed OK DENY creates an authorization;
  - a duplicate commitment is idempotent and a conflicting one is rejected without writes.

- **Done (step 10):**
  - `CommitRecommendation` with the six checks of design §6, each rejection writing nothing;
  - `SubmitAuditorDecision(requestId, decision, noteHash, validUntilUtc)` reads κ through `recommendationOf`;
  - the decision, outcome and authorization carry the κ id, `h_M` and the specific status;
  - `RECOMMENDATION_COMMITTED` and `AGREEMENT_DERIVED` events.
- **Evidence:** `diasRecommendationCommitment.test.js` (signer registry, acceptance, rejection, replay, Eq. 3 over 4 decision/recommendation pairs, 4 failure statuses and the no-κ case).

### M10 — Auditor-side verification
- **Paper:** §IV-D; Algorithm 1 line 16.
- **Current:** no hash check.
- **Change:**
  - the backend review endpoint verifies H(M) against κ and the M fields against κ, and refuses a decision on a mismatch;
  - the frontend recomputes H(M) independently and disables the decision controls on a mismatch.
- **Files:** `backend/src/routes/access.js`, `frontend/js/shared/commitments.js`, `frontend/js/modules/auditor-review.js`.
- **Tests:** backend integrity tests; frontend vector and mismatch tests.
- **Acceptance:** a modified M is reported as a mismatch by both components, and the backend refuses the decision.

### M11 — Note commitment
- **Paper:** §IV-E; Algorithm 1 lines 18, 29–30.
- **Current:** the backend requires a reason but writes it after the commit; the contract takes no note.
- **Change:**
  - `noteHash` parameter, required for NOT_AGREED and NO_RECOMMENDATION;
  - backend staging and reconciliation (design §11).
- **Tests:** contract tests (missing note, malformed hash); backend tests (staging before submit, failed submit, uncertain commit, restart recovery).
- **Acceptance:**
  - the decision is rejected without a required note hash;
  - the note text is durable before the decision transaction is sent;
  - a retry does not create a second decision.

- **Done (step 11):**
  - the contract refuses NOT_AGREED and NO_RECOMMENDATION decisions without `noteHash` (`DIAS_NOTE_REQUIRED`), writing nothing;
  - the backend stages the note before submitting, commits it on success, drops it on a refusal, and keeps it staged when the outcome is unknown (HTTP 503);
  - a lost response is settled by reading the decision back (`GetAuditorReview` now returns it); a retry on a decided request is refused (409) and settles its note;
  - notes left staged by a stopped process are settled at start-up (`reconcileStagedNotes`).

### M13 — Fail-closed decision checks
- **Paper:** §IV-E; Algorithm 1 lines 19–33.
- **Current:** self-review, facts unchanged and expiry rules are implemented; policy, κ and note checks are missing.
- **Change:** steps 3, 8, 10, 11.
- **Tests:** one rejection test per check, each asserting that no state changed.
- **Acceptance:** every listed check rejects with its code and leaves the ledger unchanged.

### M14, M15 — Authorization origin and contents
- **Paper:** §IV-F.
- **Current:** origin rule implemented (from the backend-supplied value); no `v_P` or κ reference.
- **Change:** origin from κ; store the policy and the κ reference.
- **Tests:** `diasAuthorization.test.js`, workflow tests.
- **Acceptance:** the authorization record carries scope, `h_C`, policy, κ id, `h_M`, decision, creator, times and status.

### M16 — Lifecycle
- **Current:** implemented and tested.
- **Change:** none.
- **Acceptance:** existing lifecycle tests still pass.

### M19 — Verifiable off-chain objects
- **Paper:** §IV-G.
- **Change:** `h_J`, `h_M`, `h_N` committed; an audit reconstruction that verifies available off-chain objects.
- **Tests:** audit-trail reconstruction test; tamper experiment.
- **Acceptance:** reconstruction reports `verified`, `mismatch` or `missing` for each object.

### M20 — Governed release
- **Paper:** §IV-G.
- **Current:** metadata, the record read and the PDF request re-check the credential and the dynamic authorization; the final PDF download does not (A01); no policy binding.
- **Change:** steps 4 and 8 (design §9).
- **Tests:** release tests for suspension, revocation, expiry, wrong identity, policy change and scope.
- **Acceptance:** every listed change between approval and download blocks the download.

### M21 — Trust model
- **Paper:** §IV-A omits the backend.
- **Change:**
  - step 12 was changed by the author on 2026-10-08: the backend asks the LLM and signs, so substitution before commitment is not removed; a change after commitment is still detected (κ, `h_M`);
  - the design (§2) states the remaining backend trust;
  - the text fix goes in the reconciliation report.
- **Acceptance:** the design lists every trusted component and what it is trusted for.

### M23, M24 — Auditor authority
- **Paper:** §IV-A, §V-C.
- **Current:** certificate MSP and role only; self-review rejected.
- **Change:** active ledger profile, certificate status, district and clearance (D-03), for decisions and revocations.
- **Tests:** suspended profile, revoked profile, revoked certificate, wrong district, insufficient clearance, self-review.
- **Acceptance:** each case is rejected with no writes.

### M25 — Counterfactuals
- **Paper:** C3 (§II).
- **Current:** withdrawn by the author on 2026-10-08; the active system exposes only the existing LLM explanation.
- **Change:** remove the generator, API field, panels, toggle and additional auditor detail request. Restore the offline-only oracle guard (design §13).
- **Acceptance:** the runtime cannot reach the oracle; existing LLM text, decisions and explanation visibility remain unchanged.
- **Evidence:** iteration 071 and the counterfactual-removal run. Iteration 070 and its metrics remain historical consistency evidence; they do not support independent explanation quality or latency claims.
- **Manuscript follow-up:** remove the counterfactual contribution claim when the separate manuscript is updated.

### M27 — Pending-request lifecycle
- **Paper:** §IV-E says the request "remains unresolved until a valid decision is submitted"; the plan adds expiry.
- **Change:** design §8.
- **Tests:** deadline rejection of κ and decision; `ExpirePendingRequest` after the deadline and after a policy change; cancellation; late decision after expiry or cancellation.
- **Acceptance:** each terminal state persists through its own successful transaction.

### I01 — Table V
- **Change:** the new transactions are listed in the design; the text fix goes in the reconciliation report.

### I04 — Access logging
- **Paper:** §V-C.
- **Current:** one best-effort ledger write after every authenticated API call.
- **Change:** logging classes (design §12).
- **Evidence:** write counts for the real E6 HTTP trace under both modes.
- **Acceptance:** the documented classification is enforced by tests, and the per-workflow write count is reported for both modes.

### I05 — Prompt
- **Change:** prompt v2 (claims block); v1 is kept unchanged for the historical dataset and its tests.

### I07 — Review store
- **Change:** hash commitments (steps 9–11) and encryption (step 13).

### I08 — No policy engine in the contract
- **Change:** none in chaincode. The backend guard again prohibits the reference oracle from all live entry points after the author withdrew counterfactual explanations.

### A01 — Final download
- See M20.
- **Tests:** `recordContract.test.js` additions.

### A02, A03 — Privacy
- **Current:** `GetRecordHistory`, `ListEvidence` and `QueryEvidenceCustody` have no caller checks; the decision log is full for every identity; the structured explanation is readable by every signed-in identity.
- **Change:** design §10.
- **Tests:** direct contract calls and API calls for each object and role.
- **Acceptance:** each object is refused or redacted for every caller outside its column in design §10.

### A04 — Encryption
- **Change:** AES-256-GCM store (design §10).
- **Tests:** round trip; wrong key; tampered ciphertext; file moved to another request; missing key at start.

### A05 — Signed provenance
- **Change:** design §6.1. No AI organization, and no Fabric identity for the service.
- **Tests:** valid signature; invalid signature; revoked signer; unregistered signer; replay to another request or policy.
- **Acceptance:** the contract rejects all four invalid cases; the service's dependency graph contains no Fabric gateway.

### A06 — Maximum authorization validity
- **Status:** the 2026-09-24 verification found that a null expiry never ends. A mandatory or maximum expiry is a research decision that the plan's defaults do not cover. v3 keeps expiry optional, but every authorization now ends at a policy change.
- **Status:** open researcher decision.

### A07, A08, A09 — Manuscript corrections
- Recorded in `reports/v3_methodology_reconciliation.md`.
- No code or metric is changed to match a printed number.

### A10, A11 — Reproducibility and release hygiene
- **Change:** steps 15 and 19.
- **Acceptance:** a clean clone runs every offline suite; the remaining manual prerequisites are listed in `REPRODUCE.md`.

### A12, A13 — Live re-measurement
- Prepared commands and checklists. NOT RUN in this revision: they need the Fabric testbed and the MLX model on the author's Mac.

### A14 — Offline integrity experiments
- **Experiments:**
  - canonicalization, hashing and signature cost;
  - storage overhead v2 against v3;
  - tamper and replay detection;
  - policy-update invalidation;
  - label invariance.
- **Labelling:** microbenchmarks and simulated workflows (mock Fabric stub), never presented as live Fabric results.
