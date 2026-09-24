# Iteration 046 — DIAS without an AI organization (LLM in the backend)

**Date:** 2026-09-15
**Branch:** `dias-backend-llm` (no commits made)
**Plan:** `experiments/plans/20260915_dias_backend_llm.md`
**Before-change sources:** `experiments/runs/20260915_dias_backend_llm/before/`
**Live evidence:** `experiments/runs/20260915_dias_backend_llm_acceptance/`
**Result:** 14/14 live scenarios pass, 81/81 checks (third attempt; the first two
attempts are kept with their harness defects).

## 1. What the researcher asked for

1. Run the LLM inside the application backend and show its recommendation on the
   auditor screen. Remove the AI organization.
2. Keep only two access logs on the blockchain, both written by the chaincode:
   - who sent the request, for which record;
   - the auditor decision, and whether it agreed with the LLM.
3. Keep the dynamic authorization ("the most impactful part of the research").
4. Remove the AI organization by creating a new five-organization channel.

## 2. What changed

### Ledger (chaincode `diasrecords` 2.0 on `diaschannel`)

- **Request log** (`CreateAccessRequest`): requester identity, record, case,
  action, purpose, verified facts and their hash. No justification and no
  private data collection. Action and purpose stay because the exact scope of a
  dynamic authorization needs them.
- **Decision log** (`SubmitAuditorDecision`): auditor identity, `FORCE_ALLOW` or
  `FORCE_DENY`, and `llmAgreement` = `AGREED`, `NOT_AGREED` or
  `NO_RECOMMENDATION`. The decision carries the verified-request hash and is
  refused if the facts changed or if the auditor raised the request.
- **Dynamic authorization:** created only by `FORCE_ALLOW` with `NOT_AGREED`,
  which means the LLM recommended DENY. Exact scope
  `stableUserId · recordId · caseId · action · purpose` plus the conditions
  hash; revocation, expiry and generations are unchanged.
- **Removed from the chaincode:** `PolicyContract` (policy and model
  registration), recommendation records, signed attestations, the AI identity
  checks, the private collection `accessRequestQuery`, and
  `VerifyRecommendationReason`.
- **Retired lifecycle events:** everything about recommendations. The v2 events
  are `ACCESS_REQUEST_SUBMITTED`, `DYNAMIC_AUTHORIZATION_CHECKED`,
  `AUDITOR_REVIEW_SKIPPED`, `AUDITOR_DECISION_RECORDED`,
  `DYNAMIC_AUTHORIZATION_CREATED/SUPERSEDED/REVOKED/EXPIRED` and
  `ACCESS_OUTCOME_RECORDED`.

### Backend

- `backend/src/dias/runtime.js` builds the recommender, an off-chain review store
  and a recommendation worker inside the API process. There is no AI listener.
- `backend/src/dias/reviewStore.js`: one JSON file per request under
  `backend/data/dias-reviews/` (git-ignored), written atomically, holding the
  justification, the LLM recommendation with its explanation and provenance, and
  the auditor's note.
- `backend/src/dias/recommendationWorker.js`: answers pending requests one at a
  time, each once, re-checks the verified-request hash before prompting, and
  resumes unfinished entries when the server restarts.
- `backend/src/dias/agreement.js`: the backend derives `llmAgreement` from the
  stored recommendation and the auditor's decision. A value sent by the browser
  is ignored. A decision is refused (409) while the recommendation is still being
  prepared, and a reason is required unless the decision is `AGREED`.
- The recommender, prompt, policy context and response schema are the same
  files the dataset manifest pins; their SHA-256 values are unchanged.

### Frontend

- The auditor screen shows the recommendation (or "being prepared", or "no
  recommendation"), states what the ledger will record before the click, and
  whether a dynamic authorization will be created.
- The audit trail separates the request log, the decision log, the ledger
  lifecycle and, for reviewers only, the off-chain review.

### Network and tooling

- `network/configtx/configtx.yaml`: new `DiasChannel` profile with Police,
  Forensics, Prosecution, Court and Audit. `crimechannel` was not modified.
- `Makefile`: `dias-all`, `dias-channel`, `dias-deploy`, `dias-seed`,
  `dias-model`, `dias-backend`, `dias-acceptance`. The AI, key, registration and
  old scenario targets are gone.
- Retired scripts: policy/model registration, signing-key setup, the AI listener
  supervisor, and the fifteen-scenario harness of the old design.
- New harness: `scripts/dias/run-backend-acceptance.js` with
  `acceptance-client.js`, `acceptance-scenarios.js`, `acceptance-safeguards.js`.
  It refuses an output folder that already holds a run, and
  `make dias-acceptance` adds the UTC time to each folder name, so a repeat run
  cannot overwrite earlier evidence (checked: the refusal left this run's
  `acceptance.json` and `scenarios.csv` byte-identical).

## 3. Deployment

- `diaschannel` created with five organizations, one peer each.
- `diasrecords` 2.0 approved by all five MSPs and committed (majority
  endorsement, three of five).
- Seeded: 20 users, 5 departments, 2 cases, 3 records.
- Model server: `mlx-community/Qwen3-14B-4bit`, untuned, on port 8081. No
  adapter was served. V7 stays unactivated.
- Left alone: the SEAL V6 model server on port 8080, `wt-dias`,
  `crime-records-network`, and the `crimerecords` deployment on `crimechannel`.
  The old AI listener process was stopped because the new design has no listener.

## 4. Unit suites

| Suite | Result |
| --- | --- |
| Chaincode | 206 passing |
| Backend | 153 passing |
| Policies | 27 passing |
| Frontend | 29 passing |
| Dataset & evaluation | 93 passing |

`make test` and `make check` both exit 0 (re-run after the harness fixes).

## 5. Live acceptance through the backend API

Every scenario goes through the HTTP API a user would call, against the live
network. R12 uses a second backend on port 3002 whose model URL points to a
closed port, so the model cannot answer.

| Id | Scenario | Checks |
| --- | --- | --- |
| R1 | Request log: who requested which record | 5/5 |
| R2 | LLM recommendation in the backend, not on the ledger | 5/5 |
| R3 | Auditor agrees with an LLM ALLOW | 5/5 |
| R4 | Auditor overrides an LLM DENY (creates the authorization) | 7/7 |
| R5 | Exact repeat is granted automatically | 4/4 |
| R6 | Near misses (record, action, purpose, user) are not reused | 4/4 |
| R7 | Auditor agrees with an LLM DENY | 16/16 |
| R8 | Auditor overrides an LLM ALLOW | 4/4 |
| R9 | Revocation and expiry stop reuse | 5/5 |
| R10 | An auditor cannot decide their own request | 2/2 |
| R11 | A decision on changed facts is refused | 4/4 |
| R12 | No LLM recommendation: the auditor still decides | 4/4 |
| R13 | Application access log: request and decision | 2/2 |
| R14 | No LLM recommendation, reason or justification on the ledger | 14/14 |

Selected evidence from `acceptance.json`:

- **Four agreement combinations all occurred.** Of 14 requests, 2 were granted
  automatically by a dynamic authorization (R5, and R9 before expiry) and never
  reached the model. The other 12 were decided by an auditor: 8 `AGREED`,
  3 `NOT_AGREED`, 1 `NO_RECOMMENDATION`.
- **R4:** LLM DENY (`CROSS_JURISDICTION`) on `REQ-8b071cc32a612441`; an override
  without a reason was refused with 400; the override with a reason committed
  `NOT_AGREED` and created `AUTH-4d4d278f92e0a4db`.
- **R5:** the exact repeat matched `AUTH-4d4d278f92e0a4db`; the lifecycle
  recorded `AUDITOR_REVIEW_SKIPPED`, and no off-chain review exists, so the LLM
  was not called.
- **R8:** LLM ALLOW overridden with `FORCE_DENY` → `NOT_AGREED`, request denied,
  no authorization created.
- **R9:** after revocation the repeat returned to review as `REVOKED`; the
  renewal was the next generation with a 90-second expiry; the repeat before
  expiry matched; the repeat after expiry returned to review as `EXPIRED`.
- **R10, R11:** refused by the chaincode ("a requester cannot decide their own
  request"; "verified request facts changed since the request was submitted").
- **R12:** the backend stored `UNAVAILABLE` (`server_unreachable`); a decision
  without a reason was refused; with a reason it committed `NO_RECOMMENDATION`
  and created no authorization.
- **R13:** the application access log names the requester and record for the
  request (tx `87c82ee7…`) and the auditor and `NOT_AGREED` for the decision
  (tx `2a65cb49…`).
- **R14:** none of the 14 ledger trails contains a recommendation, reason code,
  policy references, review flags, missing evidence, provenance, attestation or
  justification field.

### Model latency in this run (descriptive only)

The 11 recommendations the live model produced took 2.39–7.48 s of inference,
median 3.36 s (untuned Qwen3-14B-4bit on this Mac, one request at a time, from
the provenance stored in the review store). The model recommended DENY 9 times
and ALLOW twice. This is not a comparison with the retired AI-organization
design: no controlled latency comparison was run.

## 6. Harness defects (attempts kept as evidence)

- **Attempt 1** (`attempt-1/`): 11/14 scenarios, 62/77 checks.
  - R2 and R14 were false failures: the "no LLM data" check matched the field
    name `provenanceSource` that every ledger trail carries. The check now
    matches the LLM field names exactly.
  - R8 was not exercised: all four near misses received DENY, so no ALLOW was
    available to override. The scenario now raises a dedicated request the
    policy allows.
- **Attempt 2** (`attempt-2/`): 13/14 scenarios, 80/81 checks. R9 expected the
  renewal to be generation 2, but attempt 1 had already created earlier
  generations for the same scope on this ledger. The chaincode incremented the
  generation correctly; the check now expects exactly one generation after the
  revoked authorization.
- **Attempt 3** (root of the run folder): 14/14, 81/81.

No DIAS code changed between the three attempts; only the harness did.

## 7. What the ledger can and cannot prove now

- It proves who requested which record, with which action and purpose; what the
  auditor decided; the agreement value the backend reported; every dynamic
  authorization with its full lifecycle; and every outcome.
- It does **not** prove what the LLM recommended. The recommendation, the
  justification and the auditor's reason are in the backend review store, which
  is not replicated and has no tamper evidence.
- The chaincode trusts the backend's agreement value. A compromised backend
  could report `NOT_AGREED` for an LLM ALLOW and so create an authorization after
  an auditor's `FORCE_ALLOW`. The auditor role, the self-decision rule and the
  facts check are still enforced on-chain, and this demo backend already holds
  the users' signing keys.
- The auditor's reason is written to the review store after the ledger commit.
  If that write fails, the decision is on the ledger but the reason is lost.

## 8. Left as it was

- The 2026-09-12 fifteen-scenario live run
  (`experiments/runs/20260912_dias_live_fabric/`) and
  `reports/iteration/iter_036_dias_live_fabric.md` describe the retired design
  and are kept unchanged.
- `docs/ai-as-network-participant.md` is marked historical.
- Paper sections other than the Methodology opening still describe the AI
  organization and six organizations; they need the researcher's rewrite.
- Smoke request `REQ-91d034e8fe30e5d9` (insp.sharma · annotate · REC-FIR-001,
  LLM ALLOW) is still waiting in the auditor queue for a UI try-out.
