# Iteration 013 — Caliper graph pipeline for the five-test suite

Date: 2026-08-24

## Objective

Provide a truthful graph pipeline for the five existing Caliper test profiles
without fabricating any benchmark values.

## What worked

- Confirmed the workspace does not yet contain completed Caliper performance
  summaries for the five pilot tests.
- Verified the benchmark runner only writes paper-grade summaries when a run
  completes successfully.
- Added a data-driven plot generator in `results/plots/caliper_figure_set.py`
  that reads completed Caliper runs, ignores warm-up rows, and writes one
  figure per test.
- Added a `results/plots/README.md` section that states exactly which figures
  are produced and what input artifacts they require.

## What failed or remains weak

- No actual Caliper performance graph can be produced yet because the current
  workspace contains no completed benchmark runs.
- The endurance benchmark still lacks a retained time-series export, so a true
  resource-trend figure will require an additional monitoring capture step in a
  later iteration.

## Next experiment

Run the five benchmarks in order after the corrected smoke test passes:
read, write, increasing load, mixed workload, and endurance. Once completed
artifacts exist, rerun `python3 results/plots/caliper_figure_set.py` to render
the paper figures from the retained runs.

## Evidence

- `benchmarks/caliper/scripts/run-benchmark.js`
- `benchmarks/caliper/README.md`
- `benchmarks/caliper/EXPERIMENT_PLAN.md`
- `results/plots/caliper_figure_set.py`
- `results/plots/README.md`
- `experiments/runs/2026-08-24T07-17-54-198Z_caliper_smoke/run-manifest.json`
- `experiments/runs/2026-08-24T07-19-29-888Z_caliper_smoke/run-manifest.json`
