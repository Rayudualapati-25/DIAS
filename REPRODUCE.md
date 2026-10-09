# Reproducing DIAS

This page says what can be reproduced from a clean clone, with which commands,
and what each command should print. It separates what runs on any Linux or
macOS machine from what needs the author's Mac (Fabric testbed and the MLX
model). Status: 2026-10-09, branch `feat/dias-v3-integrity`, source label 3.0.

## 1. What you need

| Tool | Version used | Needed for |
|---|---|---|
| Git | any recent | clone; `experiments/v3/integrity-offline.js` reads the baseline commit with `git archive` |
| Node.js | 22 (22.22.0 in the last check) | all JavaScript tests and the offline experiment |
| Python | 3.13 | analysis scripts, figure rebuild, repository checks |
| Docker, Lima, Fabric 2.5.16, MLX | see `testbed/README.md` | only the live experiments (section 5) |

## 2. Offline tests (any machine, about 1 minute)

```bash
git clone <repository> DIAS && cd DIAS   # full clone: the offline experiment needs the baseline commit 2336bb4
make install                      # npm ci in chaincode/crimerecords, then backend
make test
node experiments/dias-finetuning/v2/validate.js
```

Expected:

| Suite | Passing |
|---|---|
| chaincode | 342 |
| backend | 313 |
| policies | 27 |
| frontend | 77 |
| dataset (`experiments/dias-finetuning/v2`) | 104 |
| dataset validator | 25/25 checks |

The backend prints a `JWT_SECRET not set` warning during tests; that is expected.

## 3. Python analysis (any machine, about 1 minute)

```bash
python3 -m venv .venv-analysis
.venv-analysis/bin/pip install -r testbed/analysis/requirements.txt
.venv-analysis/bin/python -m pytest -q testbed/analysis testbed/scripts/test_capture_manifest.py
```

Expected: `20 passed`. `experiments/cross-dataset/` uses only the standard
library (`experiments/cross-dataset/requirements.txt`).

## 4. Results that can be rebuilt offline

### 4.1 v3 integrity experiment (step 17, about 30 seconds)

```bash
for s in 20261009 20261010 20261011; do
  node experiments/v3/integrity-offline.js --seed "$s" --out /tmp/dias-integrity/seed-$s
done
node experiments/v3/integrity-tables.js --run /tmp/dias-integrity --prefix /tmp/dias-integrity/table
```

Compare with `experiments/runs/20261009_v3_integrity_offline/` and
`results/tables/20261009_v3_integrity_*.csv`. Byte counts, tamper detection
and policy invalidation must match exactly; timings depend on the machine.
These are mock-stub and microbenchmark results, not live Fabric results.

### 4.2 Archived September testbed analysis

```bash
PATH="$PWD/.venv-analysis/bin:$PATH" bash testbed/analysis/rebuild_archived.sh /tmp/dias-rebuilt
```

It rebuilds from tracked raw data and compares with
`experiments/runs/20260924_testbed_multivm/analysis/`:

| Part | Rebuilt from tracked data? |
|---|---|
| E1/E2 accuracy tables and figures | yes; numbers identical (the new file adds a `source_runs` field; the CSV differs only in line endings) |
| E4 model alone | yes; identical apart from an added `reference_file` field |
| E7 faults | phases yes; the 6.18 s leader-election time **no** — it was read from orderer container logs (`docker logs`), which are not in the repository |
| E3, E5, E6 | **no** — they read machine CPU/memory and Fabric metrics from the testbed's Prometheus, whose database is not in the repository |
| Ledger growth, testbed diagram | yes |

### 4.3 Cross-dataset scores

```bash
python3 experiments/cross-dataset/score.py
git diff --stat experiments/runs/20260924_cross_dataset/   # only generatedAtUtc changes
git checkout experiments/runs/20260924_cross_dataset/comparison.json
```

`score.py` rewrites the run's `comparison.json` in place; restore it afterwards.

## 5. Needs the author's Mac (not reproducible from the repository alone)

- The Fabric testbed (four Lima VMs), the MLX model server, the Android
  emulator and the live UI checks.
- The review-store encryption key and the recommendation signing key (never in
  the repository).
- The plan and expected runtimes: `experiments/plans/20261009_step17_mac_run_checklist.md`.
- Build and run steps: `testbed/README.md`.

## 6. Repository checks

```bash
make repo-check
python3 scripts/release/home-path-inventory.py --out docs/release/home-paths.csv
```

- `make repo-check` currently fails on one retained raw log larger than 50 MiB:
  `experiments/runs/20260924_testbed_multivm/raw/e3-ledger-20260925T043602Z/transactions.jsonl`
  (69.8 MiB). It is kept until the author decides what to do with it.
- The check also rejects absolute home-directory paths outside recorded
  evidence. The evidence files that still contain such paths are listed, not
  edited: `docs/release/home-paths.csv`.

## 7. Data, licences and removed files

- Licences and data sources: `docs/release/licences.md`.
- Third-party papers are no longer in the repository:
  `docs/release/removed-third-party-pdfs.csv` lists each file with its source
  and SHA-256. `scripts/download-reference-library.sh` downloads the open-access ones.
- Legacy material: `archive/README.md`.
