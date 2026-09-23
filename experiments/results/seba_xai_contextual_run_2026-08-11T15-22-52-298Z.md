# SEBA-XAI contextual-policy run

Generated: 2026-08-11T15:22:52.298Z

| Scenario | Expected | Role-only ablation | Contextual Fabric | Reason | Commit ms |
|---:|---|---|---|---|---:|
| 1 | allow | allow | allow | POLICY_SATISFIED | 2019.66 |
| 2 | deny | allow | deny | NOT_ASSIGNED | 2077.46 |
| 3 | deny | allow | deny | VICTIM_DATA_NOT_NECESSARY | 2080.07 |
| 4 | escalate | allow | escalate | CROSS_JURISDICTION | 2081.57 |
| 5 | deny | allow | deny | JUVENILE_PROTECTED | 2057.82 |
| 6 | approved-after-escalation | allow-without-approval | approved-after-escalation | CROSS_JURISDICTION | 2047.65 |
| 7 | deny | allow | deny | CRED_NOT_ACTIVE | 2084.61 |
| 8 | deny | allow | deny | AUDIT_METADATA_ONLY | 2075.41 |

Role-only ablation: 1/8 correct on this fixed workload.
Contextual policy: 8/8 correct on this fixed workload.

These are prototype scenario checks, not statistical evidence of real-world effectiveness.
