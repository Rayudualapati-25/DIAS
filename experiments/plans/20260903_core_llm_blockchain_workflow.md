# Core LLM–Fabric workflow experiment plan

## Objective

Build and verify the smallest complete user journey:

1. A signed-in user enters a case-file number.
2. The fine-tuned Qwen3-14B-4bit adapter returns `ALLOW`, `DENY`, or `ESCALATE` from trusted Fabric attributes.
3. Fabric validates the model provenance and records the decision.
4. Metadata is released only to the exact requester after a grant.
5. `ESCALATE` is resolved only by an `AuditMSP` auditor or ombudsman.
6. After a grant, the requester can request a complete PDF; the owning police station uploads it off-chain and Fabric records its hash and release authorization.

## Safety invariant

The model must never create an automatic grant when its decision or reason disagrees with the deterministic policy evaluator. A disagreement becomes `ESCALATE` and enters the `AuditMSP` queue.

## Comparisons and ablations

- Baseline: retained fine-tuned V4 predictions with the safety guard disabled.
- Proposed: the same retained predictions with the policy-disagreement guard enabled.
- Input ablation: retained V4 evaluation without trusted subject attributes.
- Live workflow: exercise requester decision, auditor approval, gated metadata, PDF request, owner upload, requester read, and wrong-identity rejection.

## Acceptance criteria

- All chaincode tests pass.
- All backend unit and live-network integration tests pass.
- Live `ALLOW`, `DENY`, and `ESCALATE` decisions are present on Fabric.
- Only `AuditMSP` resolves escalations.
- Metadata excludes the private off-chain reference.
- The exact requester can read an uploaded PDF and another identity cannot.
- Desktop and 375 px browser checks show no page-level horizontal overflow, no unlabeled form controls, and visible review/PDF actions.
- Results and limitations are recorded under `experiments/runs/`, `results/tables/`, and `reports/iteration/`.

## Known limitation to measure honestly

The retained 360-case V4 evaluation is not perfect. The guard is evaluated as a safety layer, not as evidence that the model itself became more accurate.
