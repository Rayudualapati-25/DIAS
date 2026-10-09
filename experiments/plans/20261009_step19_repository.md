# Step 19 — prepare the public repository

- **Date:** 2026-10-09
- **Parent plan:** `experiments/plans/20261001_integrity_v3_plan.md`, step 19; traceability A10 and A11.
- **Where:** cloud container. No release tag (the plan forbids one until steps 17 and 18 are done).

## Work items

1. `REPRODUCE.md` at the repository root.
2. Pinned Python dependencies for `testbed/analysis/` and `experiments/cross-dataset/`; run their tests in a fresh virtual environment.
3. Figure scripts built from tracked data: a script that rebuilds the archived September analysis from tracked raw data into a separate directory and compares the result with the archived one. Report what cannot be rebuilt.
4. Licence notes for the project's data and the external data.
5. Third-party PDFs: record source and SHA-256, remove them from the tree, add them to `.gitignore`.
6. Home-directory paths: replace them in scripts and configurations; list, do not edit, those in run records and raw logs; make the repository check reject new ones.
7. Legacy content: dependency check first; move only what nothing depends on to `archive/` with `git mv`.
8. Run every offline test from a clean clone of the committed tree.

## Constraints

- Do not edit `README.md` or `backend/src/server.js` (uncommitted work on the author's Mac).
- Do not edit raw evidence. Do not delete the retained 69.8 MiB raw log.
- Keep the public repository free of secrets and real personal data.
