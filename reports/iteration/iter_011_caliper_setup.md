# Iteration 011 — Hyperledger Caliper Setup

Date: 2026-08-24

## Objective

Prepare a reproducible, isolated Hyperledger Caliper workspace for manual
performance testing of the live SEBA-XAI Fabric network without starting a
benchmark on the user's behalf.

## What worked

- Installed and pinned Caliper 0.7.1, Fabric Gateway 1.7.1, and patched gRPC
  1.14.4 inside `benchmarks/caliper/`; application dependencies were unchanged.
- Added a preparation script that locates the current enrolled identity files,
  checks the required live containers, and generates a local connection file.
- Connected the configuration to Fabric v2.5.16, `crimechannel`, and the
  `crimerecords` chaincode through PoliceMSP and AuditMSP identities.
- Added one evaluate-only record-read workload and one submitted contextual
  access workload at 1 TPS for a short, user-operated connectivity smoke test.
- Added a wrapper that creates a new timestamped experiment directory and saves
  the benchmark config, environment, log, HTML report, and run manifest without
  overwriting earlier runs.
- JavaScript syntax, Caliper version, dependency pins, benchmark configuration,
  workload contract names, and live-network preparation passed validation.

## What was deliberately not done

- No Caliper workload was started.
- No transactions were submitted by Caliper.
- No throughput or latency values were produced or claimed.
- No smoke-test value will be treated as paper-quality evidence.

## What remains weak

- Caliper 0.7.1 retains 14 known transitive npm audit findings: 5 low,
  2 moderate, and 7 high. No critical finding is reported and no non-breaking
  automatic fix was available. The exact scope and mitigation are recorded in
  `results/tables/20260824_caliper_setup_audit.txt`.
- The setup targets a single-host Docker/Colima prototype with one Raft
  orderer, so it cannot establish distributed scalability or orderer fault
  tolerance.
- The smoke configuration checks connectivity only. It is not the policy
  baseline required for comparison with the proposed contextual method.
- Formal baseline, proposed-method, and component-ablation configurations still
  need to be created and run repeatedly under matched conditions.

## Initial manual runs and correction

Two initial user-operated smoke invocations on 2026-08-24 did not execute either
workload round. Caliper's optional logging transaction observer received no
options object and failed during worker initialization. Caliper nevertheless
returned process exit code 0, so the initial wrapper incorrectly marked the
runs as completed even though each summary reported zero successful rounds, two
failed rounds, and no HTML report.

The failed runs and full logs were retained in
`experiments/runs/2026-08-24T07-17-54-198Z_caliper_smoke/` and
`experiments/runs/2026-08-24T07-19-29-888Z_caliper_smoke/`. Their manifests now
record the actual failed outcomes. The unnecessary transaction observer was
removed. The wrapper now requires a round summary with zero failed rounds, an
HTML report, a parseable performance row for every round, and zero failed
transactions for the smoke test before it records completion. The assistant did
not rerun the benchmark; the corrected smoke test remains user-operated.
Post-correction JavaScript checks and Caliper configuration parsing passed, and
the new outcome check correctly classifies the retained diagnostic run as two
failed rounds with no report.

## Next experiment

The user should rerun the corrected smoke test and retain its generated artifacts. If
both rounds complete with zero failed transactions, create a low-rate pilot and
then matched repeated load sweeps for the role-only baseline, contextual model,
and documented ablations. Paper text must be updated only from those retained
measurement artifacts.

## Evidence

- `benchmarks/caliper/package.json`
- `benchmarks/caliper/package-lock.json`
- `benchmarks/caliper/configs/smoke.yaml`
- `benchmarks/caliper/scripts/prepare-network.js`
- `benchmarks/caliper/scripts/run-benchmark.js`
- `benchmarks/caliper/workloads/read-record.js`
- `benchmarks/caliper/workloads/request-access.js`
- `benchmarks/caliper/README.md`
- `benchmarks/caliper/EXPERIMENT_PLAN.md`
- `experiments/runs/20260824_caliper_setup.json`
- `results/tables/20260824_caliper_setup_audit.txt`
