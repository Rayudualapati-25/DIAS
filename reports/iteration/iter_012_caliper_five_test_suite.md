# Iteration 012 — Five-test Hyperledger Caliper suite

Date: 2026-08-24

## Objective

Expand the corrected Caliper connectivity setup into five reproducible,
user-operated pilot tests for the live SEBA-XAI Fabric network while keeping all
paper-result fields empty until actual repeated experiments exist.

## What worked

- Added separate read, write, stepped-load, deterministic 70/30 mixed, and
  two-hour endurance configurations.
- Mapped every workload to the deployed `crimerecords` chaincode and frozen
  `PoliceMSP/io.krishnan` plus `REC-FIR-001` scenario.
- Implemented the mixed workload as one operation per invocation with seven
  reads and three writes in each complete ten-call cycle per worker, staggered
  across workers to avoid synchronized operation-type bursts.
- Added Docker resource monitoring and local Prometheus scraping for the one
  orderer and five peer operations endpoints.
- Added blank CSV and IEEE LaTeX table templates. No plausible-looking or
  hypothetical measurement was inserted.
- Hardened each run artifact with workload/configuration snapshots, exact
  dependency versions and hashes, an HTML report, a machine-readable summary,
  and an outcome check that distinguishes failed rounds from failed Fabric
  transactions.
- `npm run check`, Docker Compose rendering, live-network preparation, and
  read-only checks of all six Fabric metrics endpoints passed.

## What was deliberately not done

- The assistant did not start any Caliper benchmark round.
- The assistant submitted zero benchmark transactions.
- Prometheus was configured but not started; starting it remains a manual step.
- No throughput, latency, success, failure, CPU, or memory result is claimed.
- No Results and Discussion prose was drafted from hypothetical values.

## What failed or remains weak

- Neither retained initial smoke attempt is a valid result. Both failed during
  worker initialization before a workload transaction was submitted, and
  neither produced an HTML report.
- A corrected successful smoke report does not yet exist.
- The declared TPS values are pilot inputs, not measured capacity limits. A
  revised preregistered sweep may be needed if 1--20 TPS does not bracket
  saturation.
- Caliper's fixed-rate controller divides aggregate TPS across workers; worker
  start times can create short synchronized bursts, especially at low rates.
- A duration round can stop part-way through the deterministic ten-operation
  mixed cycle, so the retained per-worker counts must be checked before claiming
  an exact observed 70/30 ratio.
- A single endurance run and a peak-memory value cannot prove a memory leak.
- Role-only baseline and component-ablation deployments do not yet exist, so no
  comparative performance claim is supported.
- Caliper 0.7.1 retains 14 transitive audit findings recorded in the setup audit.

## Next experiment

The user should run the corrected smoke test first. Only after its two report
rows show zero failed transactions should Prometheus be started and the five
pilots be run one at a time. Formal paper evidence then requires at least five
matched repetitions for the baseline, proposed method, and each ablation from a
controlled starting ledger state.

## Evidence

- `benchmarks/caliper/configs/read-performance.yaml`
- `benchmarks/caliper/configs/write-performance.yaml`
- `benchmarks/caliper/configs/increasing-load.yaml`
- `benchmarks/caliper/configs/mixed-workload.yaml`
- `benchmarks/caliper/configs/endurance.yaml`
- `benchmarks/caliper/workloads/mixed-record-access.js`
- `benchmarks/caliper/monitoring/compose.yaml`
- `benchmarks/caliper/monitoring/prometheus.yml`
- `benchmarks/caliper/templates/caliper_results_template.csv`
- `benchmarks/caliper/templates/ieee_results_table_template.tex`
- `experiments/runs/20260824_caliper_five_test_suite_setup.json`
- `results/tables/20260824_caliper_suite_validation.txt`
