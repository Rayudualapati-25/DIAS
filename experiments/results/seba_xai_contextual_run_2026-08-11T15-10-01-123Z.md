# SEBA-XAI contextual-policy run

Generated: 2026-08-11T15:10:01.123Z

| Scenario | Expected | Role-only ablation | Contextual Fabric | Reason | Commit ms |
|---:|---|---|---|---|---:|
| 1 | allow | allow | allow | POLICY_SATISFIED | 2007.81 |
| 2 | deny | allow | deny | NOT_ASSIGNED | 2071.15 |
| 3 | deny | allow | deny | VICTIM_DATA_NOT_NECESSARY | 2065.7 |
| 4 | escalate | allow | escalate | CROSS_JURISDICTION | 2075.24 |
| 5 | deny | allow | deny | JUVENILE_PROTECTED | 2070.35 |
| 6 | approved-after-escalation | allow-without-approval | approved-after-escalation | CROSS_JURISDICTION | 2079.01 |
| 7 | deny | allow | deny | CRED_NOT_ACTIVE | 2085.92 |
| 8 | deny | allow | deny | AUDIT_METADATA_ONLY | 2077.5 |

Role-only ablation: 1/8 correct on this fixed workload.
Contextual policy: 8/8 correct on this fixed workload.

These are prototype scenario checks, not statistical evidence of real-world effectiveness.
