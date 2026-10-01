# Evaluated baseline, 2026-10-01

Step 1 of `experiments/plans/20261001_integrity_v3_plan.md`. This folder fixes what "before" means for every later comparison.

## Checkpoint

- Tag `eval-baseline-2026-10-01` points to commit `2336bb4` on `main`.
- That commit contains:
  - the code that produced the reported testbed numbers (chaincode `diasrecords` 2.3 and the backend image of 2026-09-24/25), committed in `0dcf039`;
  - the testbed scripts and the run evidence, committed in `94f27e5`;
  - the alignment audit `reports/paper_code_alignment_audit.md`.
- The working tree was clean at capture (`environment.json`).

## The deployed code equals the tag

Source: `deployed-code-check.txt`.

- **Chaincode installed on the testbed:** identical to `chaincode/crimerecords`. The only differences are the five legacy policy modules that `deployCC.sh` leaves out by design, and the tests.
- **Backend image:** `backend/`, `chaincode/crimerecords/lib`, `policies/lib`, `policies/reference-oracle`, `testbed/seed` and `testbed/load` are identical.
- **Frontend:** 7 files changed after the image was built: three CSS files, `index.html`, and layout code in `login.js`, `shell.js` and `request-access.js`. The load generators call the API, not the UI, so no reported number depends on these files.

## Tests on the tag

Logs are in `tests/`, exit codes in `tests/exit-codes.tsv`, and the machine in `environment.json`.

| Suite | Command | Result |
|---|---|---|
| Chaincode | `cd chaincode/crimerecords && npm test` | 211 passing; 92.29% statement coverage |
| Backend | `cd backend && npm test` | 184 passing |
| Policies | `cd policies && npm test` | 27/27 |
| Frontend | `cd frontend && npm test` | 39/39 |
| Dataset | `cd experiments/dias-finetuning/v2 && npm test` | 93/93 |
| Dataset validator | `cd experiments/dias-finetuning/v2 && node validate.js` | 25/25 checks |

The test run changed no tracked file.

## Evidence that a clean checkout cannot see

`external-evidence.sha256.tsv` has one row per file (root, path, bytes, SHA-256). `external-evidence.summary.json` gives the totals and one manifest digest per root.

| Root | Files | Size | Contents |
|---|---|---|---|
| `~/dias-testbed` | 241 | 236.6 MB | Runtime folder of the multi-VM testbed: raw results, logs, staged code, configs |
| `~/Downloads/DIAS_results_20260925` | 167 | 8.0 MB | Copy of the testbed results, one folder per experiment |
| Git-ignored files in this repository | 50 | 1.96 GB | LoRA adapter weights (`*.safetensors`, V7 and earlier) and model-server logs (`experiments/runs/**/server.log`) |

- Crypto material (`~/dias-testbed/organizations/`), key files and `backend.env` are not hashed. They are not evidence.
- To check the evidence later, rerun the same hashing and compare `manifest_sha256` for each root.

## Superseded results

Labelled on 2026-10-01 with a `SUPERSEDED.md` file next to each artifact.

| Artifact | Replaced by | Reason |
|---|---|---|
| `experiments/runs/20260912_dias_scope_ablation/` | `experiments/runs/20260925_reuse_100_users/` | Offline replay; approvals were drawn again in each condition (`analysis/RESULTS.md`, line 30) |
| `experiments/runs/20260916_dias_scope_workload_sweep/` | Same | Same replay; source of the 23.75% figure, which must not be cited |
| `results/tables/dias_scope_ablation.csv`, `dias_scope_workload_sweep.csv`, `dias_fingerprint_ablation.csv` | Same | Tables from the same replay |
| `experiments/runs/20260916_dias_concurrent_users/`, `results/tables/dias_concurrent_users.csv` | E5: `results/tables/dias_testbed_e5_levels.csv` | Single-host test with 1–12 users and 81 workflows; E5 ran 780 workflows on the four-VM testbed |

These were already labelled before this step:

- `experiments/runs/20260912_dias_qwen3_lora_v7_r8/INVALID_EVALUATION.md`;
- the two aborted E6 attempts, named `-ABORTED-not-used`.

## Validity of the current results

- Every result in the repository up to this tag was produced by the baseline system, and stays valid for this tag.
- The v3 changes alter what the ledger stores and checks. Any number cited for v3 must come from a new run on the v3 code.
