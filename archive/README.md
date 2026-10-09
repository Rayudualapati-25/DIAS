# Archive

Legacy material moved here on 2026-10-09 (plan step 19). Nothing here is used
by the DIAS v3 code, tests or experiments. Files were moved with `git mv`, so
their history is kept; nothing was deleted or edited.

## Dependency check

Before the move, `scripts/release/archive-dependency-check.py` searched every
tracked text file for each path (and, for single files, the file name).
Result: `experiments/runs/20261009_step19_repository/archive-dependency-check.json`.

| Old path | New path | Files | Code or current-document dependencies | Dated records that mention it |
|---|---|---|---|---|
| `paper experiment results/` | `archive/seal-era-experiment-results/` | 29 | 2, both tooling metadata: the audit's path rules (`scripts/audit/inventory_rules.py`) and the home-path allowlist (`scripts/check-repository.py`); both updated | 4 (`reports/paper_code_alignment_audit.md`, `reports/repository_audit/*`, `results/plots/README.md`) |
| `outputs/20260917_google_sheets_experiments/` | `archive/20260917_google_sheets_experiments/` | 4 | 0 | 2 (`reports/paper_code_alignment_audit.md`, `reports/repository_audit/repository_inventory.csv`) |
| `_figpreview.svg` | `archive/stray/_figpreview.svg` | 1 | 0 | 2 (same two reports) |
| `test-refs.bib` | `archive/stray/test-refs.bib` | 1 | 0 | 2 (same two reports) |

The dated records were not edited; they describe the repository as it was.

## Not moved

| Path | Why it stays |
|---|---|
| `solidity-frontend/` | `README.md` and `docs/github-repository.md` link to it. `README.md` is not edited in this step because the author's Mac holds uncommitted changes to it. |
| `paper-tests/` | `.gitignore` and the home-path allowlist name it; it is earlier evaluation evidence. |

## What is here

- `seal-era-experiment-results/`: latency and ledger-growth study of the
  predecessor (SEAL-era) five-organization network. Its scripts are kept as
  they were and are not maintained.
- `20260917_google_sheets_experiments/`: a spreadsheet export of experiment
  charts; not a source of evidence.
- `stray/`: a figure preview and a one-entry placeholder bibliography found at
  the repository root.
