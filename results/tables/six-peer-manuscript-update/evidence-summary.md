# SEAL six-peer manuscript evidence summary

Date: 2026-09-05

This table records the quantitative evidence used in `papers/final_paper/SEAL_latest_full_manuscript.md`. Scope notes are part of each result and must remain attached when numbers are reused.

| Evidence | Result | Scope and source |
|---|---|---|
| Live application peers | 6 running; height 70; identical current block hash | Local inspection recorded in `experiments/runs/20260905_six_peer_manuscript_update/verification.json` |
| Chaincode lifecycle | `crimerecords` 3.2, sequence 3, approved by six organizations | Same verification snapshot |
| Current model smoke | `ALLOW/POLICY_SATISFIED`, 2,581 ms | One compliant policy-v2 invocation; operational smoke only |
| V4 decision accuracy | 91.39% | 360-case predominantly single-condition policy-v1 held-out suite |
| V4 joint accuracy | 88.06% | Same retained suite |
| V4 raw false allows | 22/300 (7.33%) | Expected non-allow cases in same retained suite |
| V4 model latency | median 2,306.31 ms; p95 2,483.04 ms | Same retained suite; model inference, not full Fabric workflow |
| Guarded replay | 0/300 false allows; 43/360 referrals; 90.83% decision accuracy | Post-hoc deterministic replay, not universal safety proof |
| Full-context ablation arm | 93.33% decision; 90.00% joint | Comparable retained 60-case subset |
| No-subject ablation arm | 66.67% decision; 46.67% joint | Same 60-case subset with authenticated subject block removed |
| V4 on harder V5 suite | 57.22% decision; 42.22% joint; 45/300 false allows | Multi-condition cross-evaluation |
| V5 on retained V4 suite | 60.83% decision; 53.06% joint; 82/300 false allows | Candidate comparison; V5 rejected |
| V5 on harder V5 suite | 60.83% decision; 46.94% joint; 100/300 false allows | Candidate comparison; V5 rejected |
| Chaincode tests | 133 passing; 91.62% statement coverage | Current component test run |
| Frontend tests | 7 passing | Current component test run |
| Backend unit tests | 57 passing | Full command still failed before live API cases because `aud.qureshi` was not registered |
| Policy-v2 precision data | 1,200 train; 100 validation; 200 test; 10 reasons; 22 roles | Dataset generated; V6 training and evaluation not completed |

The older five-organization interface latency study is not evidence for the current six-organization Qwen workflow and is excluded from this summary.
