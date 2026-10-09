# Step 16 (offline part) — required-test matrix

- **Date:** 2026-10-09
- **Parent plan:** `experiments/plans/20261001_integrity_v3_plan.md`, step 16.
- **Where:** cloud checkout of `feat/dias-v3-integrity`. No Fabric network, no model, no testbed VMs.

## Goal

For each of the 11 required tests in step 16, name the existing test that proves it. Add a test only where a requirement is not proven.

## Method

1. List every test title in the chaincode and backend suites with `mocha --dry-run`.
2. Match each required test to titles and read the bodies where the title is not enough.
3. A requirement is "covered" only if a test exercises the rejection or the check itself and asserts the outcome.
4. For a gap: write the test, check it fails when the checked value is changed (mutation check), then run every suite.
5. Record the matrix in `results/tables/20261009_step16_required_tests.csv`, the iteration report 074 and `docs/design/dias-v3-requirements-traceability.md`.

## Out of scope here

- Multi-VM tests, live UI checks, the Android emulator: **Not run - needs the author's Mac.**
- No design change. A requirement that the design deliberately handles differently is reported, not changed.
