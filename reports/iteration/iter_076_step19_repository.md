# Iteration 076 — step 19: prepare the public repository

Date: 2026-10-09. Plan: `experiments/plans/20261009_step19_repository.md`.
Evidence: `experiments/runs/20261009_step19_repository/`. No release tag.

## What changed

1. **`REPRODUCE.md`** at the root: offline tests, Python analysis, the offline
   integrity experiment, the archived-analysis rebuild, cross-dataset scoring,
   repository checks, and what needs the author's Mac. `README.md` was **not**
   edited (uncommitted work on the Mac); it does not yet link to `REPRODUCE.md`.
2. **Pinned Python.** `testbed/analysis/requirements.txt` pins 16 packages,
   anchored on matplotlib 3.10.7 (the version recorded on the author's Mac).
   `experiments/cross-dataset/requirements.txt` records that it needs only the
   standard library.
3. **Figures from tracked data.** `testbed/analysis/rebuild_archived.sh`
   rebuilds the September testbed analysis into a separate directory, and
   `compare_archived.py` compares it with the archive (results below).
4. **Licence notes:** `docs/release/licences.md`.
5. **Third-party PDFs.** 50 PDFs (92.3 MiB) removed from the tree and added
   to `.gitignore`: the reference library (42), related-work sources (7) and
   `LLMxAI/2511.20284v2.pdf`. Each one's source and SHA-256 are in
   `docs/release/removed-third-party-pdfs.csv`. They match the September
   audit's list of third-party PDFs exactly. They are still in Git history.
6. **Home-directory paths.** Fixed in 10 tracked scripts and configurations:
   - `testbed/scripts/render_compose.py` and `testbed/compose/m1–m4.json`: now `${HOME}/dias-testbed`, which Compose fills in. The rendered files are byte-identical apart from the path.
   - `testbed/scripts/run_fault_test.py`: `TB` from the environment, default `~/dias-testbed`.
   - `scripts/dias/train-v7.sh`: `V6_ADAPTER` can be set; default under `${HOME}`.
   - `scripts/download-reference-library.sh`: repository root from the script's location; user library from `REFERENCE_USER_LIBRARY`; the manifest records `user-library/<file>`.
   - `papers/reference_library/manifest.csv`: the 5 user-library rows.
   - `LLMxAI/README.md`: run commands use a relative path.

   259 evidence files keep their paths and are listed in
   `docs/release/home-paths.csv` (`scripts/release/home-path-inventory.py`).
   `scripts/check-repository.py` now rejects home paths outside recorded evidence.
7. **Legacy content.** `scripts/release/archive-dependency-check.py` was run on
   six candidates first. Four were moved with `git mv` (see `archive/README.md`):
   `paper experiment results/`, `outputs/20260917_google_sheets_experiments/`,
   `_figpreview.svg` and `test-refs.bib`. For the first, the only references were two
   tooling path lists, and both were updated. `solidity-frontend/` (linked from
   `README.md`) and `paper-tests/` were not moved.

## Test results

| Check | Result |
|---|---|
| `make test` in the working tree | chaincode 342, backend 313, policies 27, frontend 77, dataset 104; 0 failures |
| Clean clone of the step's tree before its evidence was added (local commit `8f6a393`, later amended into `b7e9f19`; the two differ only in the 8 evidence and report files) | `make install` ok; same counts; validator 25/25; Python tests 20 passed in a fresh venv |
| Offline integrity run from the clean clone | tamper and policy results byte-identical to iteration 075; write-set bytes identical |
| `make repo-check` | fails only on the retained 69.8 MiB raw log (unchanged, by decision) |
| Home-path inventory | 259 files, 0 outside recorded evidence |

### Archived-analysis rebuild

| Part | Result |
|---|---|
| E1/E2 accuracy | rebuilt; numbers identical (new `source_runs` field; CSV line endings differ) |
| E4 model alone | rebuilt; identical apart from a new `reference_file` field |
| E7 faults | phases rebuilt; leader-election time (6.18 s) **not** rebuilt: it came from `docker logs` of the orderers, which are not tracked |
| E3, E5, E6 | **not rebuilt**: they query the testbed's Prometheus; its database is not in the repository |
| Capacity figure | not rebuilt (needs E3) |
| Ledger growth, testbed diagram | rebuilt |
| Cross-dataset scores | identical apart from the timestamp; `score.py` rewrites the archived file, which was restored |

## Worked, weak, next

- **Worked:** a clean clone installs and passes every offline suite; the
  offline experiment reproduces exactly; scripts no longer carry home paths.
- **Weak:**
  - several September figures depend on data that is not in the repository (Prometheus, container logs);
  - `analyze_e4.py` writes an absolute `reference_file` path into new outputs;
  - `score.py` writes into an archived run.
- **Next:** the author's decisions below, then steps 16–17 on the Mac and step 18.

## Needs the author

1. **Pulling this branch on the Mac deletes the 50 PDFs from the working tree.**
   Copy `papers/reference_library/` (and the two related-work source folders)
   aside first, or restore them afterwards without tracking them:
   `git archive c58a4fd papers/reference_library reports/research/20260905_related_work LLMxAI/2511.20284v2.pdf | tar -x`.
2. The OrgAccess copies need their MIT notice. Hugging Face was blocked from
   the cloud session.
3. Add the base model's licence from its model card.
4. Decide on 3 saved third-party HTML pages under `reports/research/20260905_related_work/`.
5. Decide on the 69.8 MiB raw log, kept as instructed.
6. Choose a data licence for the synthetic datasets, or keep Apache-2.0.
7. To keep these figures reproducible in the v3 reruns, export the Prometheus
   query results and the orderer logs into the run directory. This is a change
   to `finalize.sh`; it is proposed here and not made.
8. Link `REPRODUCE.md` from `README.md` once the mobile work is committed.
