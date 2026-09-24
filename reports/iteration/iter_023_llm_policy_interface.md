# Iteration 023 — Direct registered-user LLM policy interface

## Objective

Provide a professor-demo interface in which a registered user signs in, selects a protected record, enters a natural-language query, and receives an explainable `ALLOW`, `DENY`, or `ESCALATE` decision made by the fine-tuned Qwen3:14B policy model.

## Implemented

- Added `Ask the LLM` as the first signed-in screen.
- Made the authenticated user's registered name, username, organization, and role visible beside the request form.
- Added Fabric-backed case and protected-record selectors.
- Added one natural-language query box that invokes `POST /api/access/llm-request`.
- Added an explainable result view containing the decision, reason code, decisive attributes, counterfactual, model and policy versions, inference time, and ledger decision ID.
- Reworked the sign-in selector to show all 14 registered demo identities by name and role.
- Upgraded the live Fabric chaincode from sequence 1 to sequence 2 and activated the V4 adapter registration.

## Evidence

- Structured run record: `LLMxAI/experiments/runs/20260902_llm_policy_interface/run.json`
- Live scenario table: `LLMxAI/results/tables/llm-policy-interface/live-scenarios.csv`
- Desktop result: `LLMxAI/results/plots/llm-policy-ui/professor-demo-decision-desktop.png`
- Mobile result: `LLMxAI/results/plots/llm-policy-ui/professor-demo-decision-mobile.png`
- Query screen: `LLMxAI/results/plots/llm-policy-ui/professor-demo-query.png`
- Full 360-case model evaluation: `LLMxAI/experiments/runs/20260902_qwen3_policy_engine_eval_v4/proposed_full360.json`

The live interface produced all three required decisions and committed each result to Fabric:

| Registered user | Trusted condition exercised | Decision | Reason |
|---|---|---|---|
| Insp. A. Sharma | active, assigned, same jurisdiction | allow | `POLICY_SATISFIED` |
| Insp. V. Rathore | revoked credential attribute | deny | `CRED_NOT_ACTIVE` |
| Insp. P. Singh | cross-district jurisdiction | escalate | `CROSS_JURISDICTION` |

Browser verification found 14 registered account cards, the direct `#/llm-policy` route, no console errors, no failed requests, and no horizontal overflow at 1440 px or 375 px. Backend unit verification passed 39 of 39 tests.

## What worked

- The query path now visibly combines a human request with trusted Fabric identity and record attributes.
- The result identifies the fine-tuned LLM as decision authority and preserves a ledger transaction identifier for audit.
- The same input produces different outcomes for different registered users because the authenticated attributes differ.
- The mobile layout stacks the identity, query, and explanation sections cleanly.

## Weak or failed

- The first live check exposed that the network was still on chaincode sequence 1; `GetLLMAccessContext` did not exist until the sequence-2 upgrade was committed.
- This is a local custodial identity selector for research demonstration, not production client-held-key authentication.
- The V4 full test set reaches 91.39% decision accuracy and has a 7.33% false-allow rate among expected non-allow cases. The interface works, but the model still requires further safety improvement before a real deployment.

## Next refinement

Prioritize hard-negative training and targeted ablations for `RBAC_NO_PERMISSION`, `NOT_ASSIGNED`, and `INSUFFICIENT_CLEARANCE`, then repeat the full held-out evaluation. Do not describe the model as production-ready until the false-allow result is materially reduced and independently reproduced.
