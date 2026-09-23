# Structured-explanation audit plan

Date: 2026-09-06

## Objective

Audit and minimally correct active SEAL explanations so every newly committed effective ALLOW, DENY, and ESCALATE has a policy-consistent reason, relevant trusted attributes, a rule-condition counterfactual, and matching sentence.

## Execution and evidence plan

1. Trace executable UI, backend, Qwen, guard, materialization, signing, and Fabric code.
2. Audit every active reason and decision mapping.
3. Retain the frozen V4 baseline, V6 proposed method, and trusted-context ablations in `experiments/runs/20260906_seal_precision_e2e/` rather than inventing or needlessly rerunning metrics.
4. Add ten correctness/tamper tests and exhaustive reason parity checks.
5. Run complete chaincode, backend-unit, and frontend suites.
6. Deploy to all six organizations and run exactly three final real-model scenarios: ALLOW, DENY, and AuditMSP-reviewed ESCALATE.
7. Retain run JSON, comparison CSV, iteration report, limitations, and paper corrections.

## Acceptance conditions

- Qwen free-form explanation fields cannot be accepted.
- Unknown/malformed output cannot authorize.
- Disagreement always becomes ESCALATE with a system reason.
- Fabric re-materializes the effective explanation before commitment.
- Full-field attestation tampering is detected.
- The live artifact contains exactly three passing scenarios.
