# Iteration 013 — Caliper figure generation for the paper

Date: 2026-08-24

## Objective

Add a reproducible figure-generation step for the five Caliper benchmark
profiles so that paper graphs can be produced from retained measurement
artifacts only.

## What worked

- Added a Caliper figure generator that reads only retained `caliper-summary.json`
  files or matching HTML reports from `experiments/runs/`.
- Added one paper-oriented SVG output per benchmark profile: read, write,
  increasing-load, mixed-workload, and endurance.
- Kept the generator strict: if no measured artifact exists yet for a requested
  figure, it reports the gap and exits non-zero instead of fabricating values.
- Wrote a provenance index alongside the SVGs so every plotted figure keeps the
  source run directories and SHA-256 hashes visible.
- Documented the graph-generation command in the Caliper README and the plot
  artifacts README.

## What is deliberately not claimed

- No new benchmark was executed by the assistant.
- No graph file is claimed as evidence until a retained measurement artifact is
  present for that test.
- No throughput, latency, CPU, or memory result was invented for the paper.

## What remains weak

- The repository still has no corrected successful smoke report.
- The five paper figures cannot be rendered yet because the repository does not
  contain retained Caliper measurement summaries for the five tests.
- Endurance still depends on a long user-run measurement and likely on extra
  monitoring exports if the paper needs resource time-series plots.

## Next experiment

Run the corrected smoke test first, then run the five Caliper profiles one at a
time and retain the generated summaries. After that, rerun the figure generator
to emit the SVGs for the paper.

