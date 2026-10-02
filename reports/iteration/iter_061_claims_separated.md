# Iteration 061 — verified facts separated from requester claims

- **Date:** 2026-10-02
- **Plan step:** 5. It also includes the canonical-hash module from step 9, built first because the new context and claims digests use it.
- **Requirements:** M02, M03, I05

## What changed

- **Hashing.** `lib/dias/commitments.js` implements dias-commitment-hash-v1: strict canonical JSON and domain-separated SHA-256.
  - 26 tests, including digests computed with the shell, independently of JavaScript.
- **Verified context C** (`dias-verified-context-v3`) holds requester facts, record facts, action and purpose. Its digest uses the `context` domain.
  - The self-declared emergency is now a **requester claim** (`lib/dias/requesterClaims.js`, `{emergencyDeclared}`, with its own digest `h_K`), stored next to C, not inside it.
  - `approvalTokenPresent`, which no mechanism ever set, is removed.
- **Request input.** The contract takes `{action, purpose, emergencyDeclared}`. The old `emergencyFlag` is refused as an unknown field.
- **Backend:**
  - `parseAccessRequest` refuses `emergencyFlag` with a pointer to `emergencyDeclared`;
  - the review store keeps the claims, and the worker checks both digests before prompting;
  - the recommender has a prompt mode: v2 is live; v1 is for reproducing the published evaluation.
- **Prompt v2** adds a "REQUESTER CLAIMS (stated by the requester, not verified)" block and one system line saying claims are not facts. Every other line is unchanged.
- **Prompt v1 is frozen.** `lib/dias/verifiedRequestV1.js` and `buildRecommendationMessagesV1` keep the historical text. The dataset tools now name the v1 functions explicitly.
- **Evaluation.**
  - `evaluate.js --prompt v1|v2`; `v3InputsFor` converts a v1 dataset case into v3 inputs.
  - `--help` now prints usage and exits; it previously started a real evaluation.
- **Frontend.** The auditor view shows "Emergency declared (requester claim, not verified)" from the claims record.

## Tests

- Chaincode: 262 passing.
  - Schema tests now expect the v3 request group.
  - New tests: claims, the frozen v1 module, and the hash domain.
- Backend: 217 passing. Prompt tests run for both versions; new tests cover claims, the claims-hash mismatch in the worker, and the request parser.
- Dataset package: 104/104; validator 25/25.
  - New `promptV1Frozen.test.js` rebuilds every tracked prompt with prompt v1 and matches all recorded prompt digests.
  - New `v3Inputs.test.js`.
- Frontend: 39/39.
- **Replaced expectations (intended v3 change):**
  - `diasSchema.test.js` and `diasAccessSecurity.test.js` expected `emergencyFlag` and `approvalTokenPresent` inside the verified request;
  - `diasRecommender.unit.test.js` expected prompt v1 in live provenance.

## Evidence

`experiments/runs/20261002_v3_label_invariance/`: the policy oracle gives identical verdicts for all 8,013 dataset cases with and without the two flags, and reproduces every stored label.

## What is weak

- V7 was trained on prompt v1. Its behavior under prompt v2 is unknown until it is re-evaluated (NOT RUN: needs the MLX server on the Mac).
- The browser form still has no control for declaring an emergency. Only API clients can set the claim.

## Next

- Step 6: define and measure access logging.
- The remaining parts of step 9 (`h_J` with the request, `h_N` with the decision) follow with steps 9–11.
