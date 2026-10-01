# Iteration 057 — evaluated baseline checkpoint

- **Date:** 2026-10-01
- **Plan step:** 1 of `experiments/plans/20261001_integrity_v3_plan.md`
- **Record:** `experiments/runs/20261001_eval_baseline/README.md`

## What changed

- Tagged commit `2336bb4` on `main` as `eval-baseline-2026-10-01`.
- Compared the code deployed on the testbed with the tag (`deployed-code-check.txt`). Backend, chaincode library, policies and the testbed seed and load code are identical. Seven cosmetic frontend files differ.
- Ran the five offline suites and the dataset validator on the tag. All pass: 211, 184, 27/27, 39/39, 93/93 and 25/25.
- Hashed the evidence that a clean checkout cannot see: 458 files, 2.2 GB, across `~/dias-testbed`, `~/Downloads/DIAS_results_20260925`, and the git-ignored adapters and server logs.
- Labelled the superseded offline reuse replay and the single-host concurrency test as "do not cite".

## What worked

- The tag reproduces the deployed sources, so the reported numbers have a fixed code version.
- The test run left the tracked tree unchanged.

## What is still weak

- The raw evidence in `~/dias-testbed` and the adapter weights exist only on the author's Mac. The manifest proves they are unchanged, but it does not back them up.
- Chaincode statement coverage is 92.29%; coverage of the backend, policies, frontend and dataset packages is not measured.

## Next

- Step 2: write the v3 design and ledger schema.
