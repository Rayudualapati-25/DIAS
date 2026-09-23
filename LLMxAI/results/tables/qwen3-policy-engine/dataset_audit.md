# Qwen3 policy dataset audit

Source artifact:
`experiments/runs/20260902_qwen3_policy_dataset_audit/report.json`

| Check | Observed result |
|---|---:|
| Audit status | passed |
| Training examples | 2,880 |
| Validation examples | 360 |
| Held-out test examples | 360 |
| Balanced comparison examples | 60 |
| Terminal reason codes | 12 |
| Examples per reason in training | 240 |
| Examples per reason in validation/test | 30 / 30 |
| Held-out adversarial examples | 120 |
| Unique example identifiers | 3,600 |
| Unique resource and case identifiers | 7,200 |
| Oracle mismatches | 0 |
| Explanation-materialization mismatches | 0 |
| Compact-schema mismatches | 0 |
| Template-attribution mismatches | 0 |
| Cross-split template-family matches | 0 |

The audit establishes internal consistency of the generated synthetic dataset;
it is not evidence that the policy is legally correct or that the examples
represent real agency traffic.
