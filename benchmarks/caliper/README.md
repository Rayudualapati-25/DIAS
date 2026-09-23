# SEBA-XAI Caliper workspace

This isolated workspace connects Hyperledger Caliper directly to the live
SEBA-XAI Fabric Peer Gateway. It does not deploy or modify chaincode. Every
benchmark remains user-operated.

## One-time installation

From the `crime-records-network` directory, run:

```bash
make caliper-install
make caliper-check
```

The install target uses npm 11.5.1 locally and installs the declaratively pinned
Caliper 0.7.1, Fabric connector 0.7.1, Fabric Gateway 1.7.1, and patched gRPC
1.14.4 packages. It does not change the application's dependencies or global
Node.js installation.

## Prepare the current Fabric network

Run `make all` first if the seeded network is not already live. Then run:

```bash
make caliper-prepare
```

Preparation checks the orderer, five peers, and five healthy CouchDB containers.
It generates `generated/network-config.json` from the current Police and Audit
identity files. Run preparation again after every clean network rebuild because
the private-key filenames change.

## Connectivity test first

Run:

```bash
make caliper-smoke
```

This performs one short record-read round and one short contextual-access write
round. Both must complete with zero failed transactions and produce an HTML
report before any longer test is attempted. The smoke result proves only that
the setup works; it is not paper-quality evidence.

## Start resource monitoring

The five longer tests use both Docker resource monitoring and a local Prometheus
collector. Start and verify the collector once after the Fabric network is live:

```bash
make caliper-monitoring-up
make caliper-monitoring-check
```

The check requires the orderer and all five peer metrics targets to be up.
Prometheus is bound only to `http://127.0.0.1:9090`. Stop it later with
`make caliper-monitoring-down`.

## Five manual tests

The TPS values below are total offered rates shared across all workers, not a
separate rate for each worker.

| Test | Manual command | Planned measured load | Purpose |
| --- | --- | --- | --- |
| Read | `make caliper-read` | 2 workers, 10 TPS, 120 s | Evaluate an existing record without a ledger write. |
| Write | `make caliper-write` | 2 workers, 5 TPS, 120 s | Submit contextual access decisions through endorsement, ordering, commit, and CouchDB. |
| Increasing load | `make caliper-load` | 4 workers; 1, 2, 5, 10, and 20 TPS for 60 s each | Locate where throughput stops following offered load, latency rises, or failures appear. |
| Mixed | `make caliper-mixed` | 4 workers, 10 TPS, 300 s | Target 70/30 traffic using a staggered seven-read/three-write cycle per worker. |
| Endurance | `make caliper-endurance` | 4 workers, 5 TPS, 7,200 s | Observe stability and resource trends for two hours under the same 70/30 schedule. |

Read, write, mixed, and endurance configurations contain a separate warm-up
round. Do not copy a warm-up row into the results table. The endurance command
really runs for two hours and creates real access-decision ledger state; run it
only after the shorter pilot tests are satisfactory.

Do not use the web application or run unrelated API traffic during measurement.
Freeze the record, case assignment, user status, active policy, and network
topology for every compared run.

## Run artifacts

Every command creates a new timestamped directory in `experiments/runs/` and
retains:

- the benchmark and generated network configuration;
- every workload module used by the configuration;
- host, Fabric, container, and controller environment metadata;
- Prometheus setup files when applicable;
- the complete Caliper log, run manifest, HTML report, and machine-readable
  `caliper-summary.json` performance rows tagged as connectivity, warm-up, or
  measurement data.

The wrapper records completion only if Caliper reports zero failed rounds, the
HTML report exists, and every report row can be extracted into the saved JSON
summary. For the smoke test it also requires zero failed Fabric transactions.
Formal increasing-load rounds are retained even when transactions fail, because
those failures are part of the saturation evidence. Existing runs are never
overwritten.

## Reading the report

- `Succ` is the number of Fabric operations Caliper observed as successful.
- `Fail` should be zero for a clean run.
- `Send Rate` is the offered request rate.
- `Throughput` is the completed operation rate.
- `Latency` reports minimum, average, and maximum completion time.
- Resource tables report CPU, memory, network, and disk measurements.

A committed access request with a business decision of `deny` can still appear
as `Succ`; Caliper success means the Fabric operation succeeded, not that the
policy allowed access. The primary workload therefore uses the frozen allowed
`io.krishnan` / `REC-FIR-001` scenario.

## Research-paper boundary

The planned rates are starting points for the pilot, not favorable results or
proven capacity limits. Populate `templates/caliper_results_template.csv` and
`templates/ieee_results_table_template.tex` only from retained repeated runs.
Do not write bottleneck or superiority claims until matched role-only baseline,
proposed-method, and component-ablation deployments have been measured.

Read `EXPERIMENT_PLAN.md` and `templates/RESULTS_ANALYSIS_CHECKLIST.md` before
using any value in the paper.

## Generating paper graphs

Before running the benchmarks, the configured experimental inputs can be
rendered as methodology figures with:

```bash
make caliper-profile-graphs
```

This writes PNG and vector PDF figures to `results/plots/caliper/`. Every one is
visibly marked as a configured input, not measured performance.

After completed benchmark runs have been retained, build the measured per-test
figures with:

```bash
make caliper-plots
```

The measured-results plotter reads only completed summaries from
`experiments/runs/`, excludes warm-up rows, and exits non-zero rather than
inventing a graph when no completed input exists.

## Dependency limitation

Caliper 0.7.1 retains documented transitive npm audit findings. Keep this
controller and its monitoring endpoints local, and do not run
`npm audit fix --force`, which proposes an incompatible older Caliper release.
