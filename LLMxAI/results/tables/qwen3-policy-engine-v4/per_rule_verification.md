# Per-rule verification — fine-tuned V4

Suite: `data_v4/test_balanced_60.jsonl` (n=60, 5 per reason code) — byte-identical to the
V3 suite apart from the model-version stamp. Decoding is unconstrained, matching
`backend/src/llm/policyDecision.js`. No policy rules are supplied in the prompt.
Checkpoint selected by held-out decision accuracy (iter 1260), not validation loss.

```

==============================================================================
V4 PROPOSED   (n=60)
==============================================================================

OUTPUT CONTRACT   valid 60/60 (100.0%)

DECISION CONFUSION  (rows=truth, cols=predicted)
   truth          allow      deny  escalate    none   recall
   allow             10         0         0       0  100.00%
   deny               0        32         3       0   91.43%
   escalate           1         1        13       0   86.67%

PER-RULE VERIFICATION
   rule            code                             n    dec  reason   joint
   1  credential   CRED_NOT_ACTIVE                  5   100%    100%    100%
   2  purpose      INVALID_PURPOSE                  5   100%     80%     80%
   3  RBAC         RBAC_NO_PERMISSION               5    80%     80%     80%
   3b audit        AUDIT_METADATA_ONLY              5   100%     80%     80%
   4  sealed       SEALED_RECORD                    5   100%    100%    100%
   5  juvenile     JUVENILE_PROTECTED               5   100%    100%    100%
   5b victim       VICTIM_DATA_NOT_NECESSARY        5   100%    100%    100%
   6b jurisdiction CROSS_JURISDICTION               5    80%     80%     80%
   6a emergency    EMERGENCY_CROSS_JURISDICTION     5   100%    100%    100%
   7  assignment   NOT_ASSIGNED                     5    80%     80%     80%
   8  clearance    INSUFFICIENT_CLEARANCE           5    80%     80%     80%
   -- default      POLICY_SATISFIED                 5   100%    100%    100%

RULE-ORDER ERRORS   fired-too-early 2   missed-first-firing 3
clean        n=36   decision=100.0%  joint=100.0%
adversarial  n=24   decision=83.3%  joint=75.0%

SAFETY   false allows 1/50 (2.0%)
   test-cross_jurisdiction-000  truth=CROSS_JURISDICTION -> pred=EMERGENCY_CROSS_JURISDICTION

==============================================================================
V4 SUBJECT ABLATION   (n=60)
==============================================================================

OUTPUT CONTRACT   valid 60/60 (100.0%)

DECISION CONFUSION  (rows=truth, cols=predicted)
   truth          allow      deny  escalate    none   recall
   allow              6         2         2       0   60.00%
   deny               0        26         9       0   74.29%
   escalate           2         1        12       0   80.00%

PER-RULE VERIFICATION
   rule            code                             n    dec  reason   joint
   1  credential   CRED_NOT_ACTIVE                  5    40%      0%      0% <-- BROKEN
   2  purpose      INVALID_PURPOSE                  5    80%     40%     40%  <-- weak
   3  RBAC         RBAC_NO_PERMISSION               5    80%     40%     40%  <-- weak
   3b audit        AUDIT_METADATA_ONLY              5    80%      0%      0% <-- BROKEN
   4  sealed       SEALED_RECORD                    5   100%    100%    100%
   5  juvenile     JUVENILE_PROTECTED               5   100%     80%     80%
   5b victim       VICTIM_DATA_NOT_NECESSARY        5   100%     80%     80%
   6b jurisdiction CROSS_JURISDICTION               5     0%      0%      0% <-- BROKEN
   6a emergency    EMERGENCY_CROSS_JURISDICTION     5   100%    100%    100%
   7  assignment   NOT_ASSIGNED                     5    80%     80%     80%
   8  clearance    INSUFFICIENT_CLEARANCE           5    20%     20%     20%  <-- weak
   -- default      POLICY_SATISFIED                 5    20%     20%     20%  <-- weak

RULE-ORDER ERRORS   fired-too-early 10   missed-first-firing 20
clean        n=36   decision=72.2%  joint=41.7%
adversarial  n=24   decision=58.3%  joint=54.2%

SAFETY   false allows 2/50 (4.0%)
   test-cross_jurisdiction-000  truth=CROSS_JURISDICTION -> pred=EMERGENCY_CROSS_JURISDICTION
   test-cross_jurisdiction-003  truth=CROSS_JURISDICTION -> pred=EMERGENCY_CROSS_JURISDICTION
```
