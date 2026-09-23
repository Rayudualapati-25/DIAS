# Iteration 030 — DIAS pivot and implementation contract

Date: 2026-09-09

## Objective

Translate the confirmed DIAS pivot into an implementation contract before
changing the current authorization behavior.

## Outcome

The implementation is divided into eight user-review gates in
`experiments/plans/20260909_dias_dynamic_access_policy.md`.

The plan fixes the core authority model:

- Qwen is an off-chain recommender and never makes a final first-time decision.
- One authorized auditor makes the final decision on every dynamic-policy miss.
- An exact active dynamic rule is the only path that bypasses Qwen and the
  auditor.
- Only `LLM DENY -> auditor FORCE_ALLOW` creates a rule.
- The auditor may override every denial category in this research prototype.
- Every request attempt creates fresh Fabric request and decision evidence.

## Repository reuse and gap

The prior read-only audit estimated 62% architectural similarity and 75–80%
technical-foundation reuse. Existing Fabric identities, user/record attributes,
off-chain Qwen service, model attestation, explanation artifacts, auditor queue,
audit reconstruction, vault, and PDF release remain useful.

The substantive missing behavior is the dynamic-rule asset and exact lookup,
the rule-minting transition, the no-LLM automatic replay path, and the change
from escalation-only review to auditor-final review for every recommendation.

## What worked

- The clarified user requirements map cleanly onto existing request, decision,
  approval, and policy boundaries.
- The current two-transaction requester/AI flow can be retained on a policy
  miss.
- A dynamic hit can be finalized atomically during request creation, avoiding a
  race with the AI listener.

## Weak or unresolved

- The plan assumes `recordId` and `caseId` do not participate in reusable
  matching; all governed record properties and the relevant assignment value do.
- The current model retains `ESCALATE`; the plan treats it as an advisory result
  that always requires the auditor and never creates a dynamic rule.
- No functional behavior, benchmark result, or dataset claim has been produced
  in this planning step.

## Next step after user approval

Write chaincode tests first for canonical fingerprints, exact hits, one-field
misses, rule provenance, auditor-only rule control, and latest-state/revocation
behavior. Then implement the smallest dynamic-policy chaincode core required to
make those tests pass.
