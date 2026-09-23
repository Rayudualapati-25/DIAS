# Standalone LLM extraction experiment plan

## Objective

Separate the learned policy engine from the earlier distributed-ledger
prototype and demonstrate that Qwen3-14B can receive registered user/resource
attributes plus a natural-language query and directly emit `allow`, `deny`, or
`escalate`.

## Acceptance criteria

1. No live blockchain or Hyperledger Fabric dependency.
2. Registered user and resource attributes are not inferred from the query.
3. The V4 adapter bytes match the retained digest.
4. Strict JSON and fixed reason-code validation are enforced.
5. One expected allow, deny, and escalate request passes through live Qwen.
6. Baseline, proposed, and subject-ablation evidence remains retained.
7. The interface works at desktop and 375-pixel mobile width.

## Evidence to retain

- `experiments/runs/20260902_standalone_extraction/live_decision_smoke.json`
- `experiments/runs/20260902_standalone_extraction/dataset_audit_v4_passed.json`
- `experiments/runs/20260902_qwen3_policy_engine_eval_v4/`
- `results/tables/qwen3-policy-engine-v4/`
- `results/plots/qwen3-policy-engine-v4/`

## Next experiment

Evaluate on independently authored requests and real organizational policy
cases, introduce a calibrated abstention threshold, and report whether the
false-allow rate falls without materially increasing unnecessary escalation.
