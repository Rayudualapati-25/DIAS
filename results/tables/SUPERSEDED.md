# Superseded tables — do not cite

Labelled on 2026-10-01 (baseline tag `eval-baseline-2026-10-01`). The files are kept as history.

| Table | Replaced by | Reason |
|---|---|---|
| `dias_scope_ablation.csv` | `experiments/runs/20260925_reuse_100_users/analysis/RESULTS.md` | Offline replay that drew the auditor's approvals again in each condition |
| `dias_scope_workload_sweep.csv` | Same | Same replay; source of the 23.75% saving. The live run reaches at most 21.0% (504 of 2,400). |
| `dias_fingerprint_ablation.csv` | Same | Same replay; the live run replays the fingerprint rule on fixed approvals |
| `dias_concurrent_users.csv` | `dias_testbed_e5_levels.csv` | Single-host test with 1–12 users and 81 workflows; E5 ran 780 workflows on the four-VM testbed |
