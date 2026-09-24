# SEAL precision and end-to-end verification plan

Date: 2026-09-06

## Objective

Improve the active SEAL authorization path without changing its research boundary: Qwen interprets untrusted natural-language intent, authoritative Fabric state supplies security attributes, deterministic policy determines whether the compact model classification is safe, controlled templates construct the explanation, the AI operator signs the artifact, and Fabric validates the signed state transition.

## Source-of-truth trace

The active path to verify is `CreateAccessRequest` with a transient private query, `AccessRequestCreated`, the AIOrg decision listener, the active Qwen adapter, compact classification validation, deterministic policy comparison, deterministic explanation materialization, Ed25519 attestation, `SubmitLLMDecision`, ledger state transition, escalation review, and requester-bound record access.

## Baseline

1. Record repository and service state without modifying user work.
2. Evaluate the currently active Qwen adapter and current prompt on the retained policy-v2 test set.
3. Preserve raw rows, run configuration, hashes, metrics, and logs under `experiments/runs/20260906_seal_precision_e2e/`.

## Proposed changes

Only make changes supported by a demonstrated defect:

- make the active prompt explicit, policy-grounded, compact, and resistant to requester claims;
- keep strict parsing and reject malformed or unknown output before authorization;
- retain the raw compact advisory classification in the signed inference artifact;
- independently recompute policy in chaincode and accept only either exact agreement or a correctly derived `MODEL_POLICY_DISAGREEMENT` escalation;
- require deterministic explanation fields to match the controlled reason template;
- correct any template text that contradicts policy-v2 outcomes;
- add regression tests for every defect fixed.

## Ablations

Compare the current short prompt against the grounded policy prompt, and measure the safety guard separately with and without enforcement. Report schema validity, action/purpose/decision/reason joint accuracy, false allows, referrals, latency, and per-reason results. Do not promote a prompt solely from aggregate accuracy if it weakens safety.

## Verification

1. Run backend and chaincode unit/regression suites.
2. Build/redeploy chaincode only if the protocol validation changes.
3. Verify all six peers, deployed definition, active policy/model registration, adapter hash, model server, backend, and AI listener.
4. Run exactly three final successful real end-to-end scenarios: one ALLOW, one DENY, and one ESCALATE. Complete the human review inside the escalation scenario when practical.
5. Capture the private request, trusted context, advisory classification, deterministic result, effective result, explanation, attestation verification, transaction, and final ledger state for each scenario.

## Acceptance and evidence

Evidence will be retained in:

- `experiments/runs/20260906_seal_precision_e2e/`
- `results/tables/seal-precision-e2e/`
- `reports/iteration/iter_029_seal_precision_e2e.md`

No benchmark, end-to-end result, or cryptographic claim will be reported unless its corresponding artifact exists.
