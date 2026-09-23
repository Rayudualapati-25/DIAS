# Plan — DIAS without an AI organization (LLM in the backend)

Date: 2026-09-15
Branch: `dias-backend-llm`
Before-change sources: `experiments/runs/20260915_dias_backend_llm/before/`

## Researcher decisions (2026-09-15)

1. The LLM runs in the application backend. Its recommendation is shown on the
   auditor screen through the backend; the AI organization is removed.
2. The blockchain keeps only two access logs, both submitted through the
   chaincode:
   - who sent the request for which record;
   - the auditor decision and whether it agreed with the LLM.
3. The dynamic authorization stays ("the most impactful part of the research").
4. The AI organization is removed from the network by creating a new
   five-organization DIAS channel; the existing `crimechannel` stays untouched.

## Design consequences

- Decision log values: `AGREED`, `NOT_AGREED`, and `NO_RECOMMENDATION` (the model
  failed or no recommendation was prepared). The backend derives the value from
  its stored recommendation; the browser never supplies it.
- A dynamic authorization is created only by `FORCE_ALLOW` + `NOT_AGREED`, which
  means the LLM recommended DENY.
- The request log keeps action and purpose because the exact scope needs them.
- Off-chain in the backend review store: the justification, the LLM
  recommendation with its explanation and provenance, and the auditor's reason.
- Removed: the AI listener, signed attestations, model and policy registration on
  the ledger, the private data collection for request text.
- What the ledger can prove changes: who requested which record, what the auditor
  decided, and the agreement value the backend reported — not what the LLM said.

## Untouched by design

Files whose SHA-256 is pinned by the v2 dataset manifest:
`chaincode/crimerecords/lib/dias/verifiedRequest.js`,
`chaincode/crimerecords/lib/dias/recommendationSchema.js`,
`backend/src/dias/recommendationPrompt.js`,
`backend/src/dias/policyContextProvider.js`, and the policy bundle, bundle loader
and reference oracle. The SEAL V6 model server on port 8080 and `wt-dias` are not
touched.

## Verification

1. Unit suites: chaincode, backend, policies, frontend, dataset (`make test`),
   plus `make check`.
2. Channel `diaschannel` created with five organizations; `diasrecords` 2.0
   committed; users, departments, cases and records seeded.
3. Live acceptance through the backend HTTP API
   (`scripts/dias/run-backend-acceptance.js`): request log, backend-only LLM
   recommendation, the four agreement combinations, exact reuse, near misses,
   revocation and expiry, self-decision, changed facts, no recommendation, the
   application access log, and no LLM data on the ledger.
4. Browser check of the auditor review and audit trail screens.

## Out of scope

- Paper text changes beyond the Methodology opening already in progress.
- Model training or activating a fine-tuned adapter.
