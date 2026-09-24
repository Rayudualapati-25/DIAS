# Caliper experiment plan

## Objective

Measure the performance of the deployed SEBA-XAI Fabric transaction path with
reproducible, retained evidence. Caliper connects directly to the Fabric Peer
Gateway; it does not measure browser or REST API latency.

## System under test

- Hyperledger Fabric channel: `crimechannel`
- Chaincode: `crimerecords`
- Topology: five organizations, one peer per organization, one Raft orderer
- State database: one CouchDB instance per peer
- Distribution: single-host Docker/Colima research prototype
- Data: deterministic synthetic seeded identities, cases, and records only

## Stage 1 — connectivity smoke test

The supplied smoke configuration performs two low-load rounds:

1. evaluate `RecordContract:GetRecord` for the seeded `REC-FIR-001` record;
2. submit `AccessContract:RequestAccess` as the assigned `io.krishnan`
   identity, exercising the contextual policy, explanation, explanation hash,
   endorsement, ordering, and commit path.

This stage validates the Caliper connection and workload semantics. It is not
paper-quality evidence and must not be cited as a performance result.

## Stage 2 — pilot saturation study

After the corrected smoke test passes, run the five planned configurations in
this order: read, write, increasing load, mixed, then endurance. The
increasing-load pilot uses separately reported fixed-rate steps at 1, 2, 5, 10,
and 20 aggregate TPS. Separate steps were selected instead of one linear round
so each offered-load level has its own latency, throughput, failure, and
resource row.

The declared rates are pilot inputs, not measured capacity. Locate the point
where achieved throughput stops tracking offered load, latency changes
materially, or the failure rate becomes nonzero. If the pilot does not bracket
that point, preregister a revised sweep before running the formal repetitions;
do not select load levels after looking for favorable results.

The five configurations are:

- `configs/read-performance.yaml`: 2 workers, 10 TPS, 120 measured seconds;
- `configs/write-performance.yaml`: 2 workers, 5 TPS, 120 measured seconds;
- `configs/increasing-load.yaml`: 4 workers, five 60-second write steps;
- `configs/mixed-workload.yaml`: 4 workers, 10 TPS, 300 measured seconds;
- `configs/endurance.yaml`: 4 workers, 5 TPS, 7,200 measured seconds.

The mixed and endurance workloads give every worker a deterministic repeating
ten-operation cycle containing seven record reads and three contextual access
writes. Worker-specific offsets stagger the write slots. TPS is aggregate
across all workers; observed totals must still be checked because a duration
round can end part-way through a cycle.

## Stage 3 — formal repeated measurements

For every frozen workload and configuration:

1. rebuild the same deterministic network state;
2. preserve the exact network and benchmark configuration;
3. run a declared warm-up period;
4. measure for a fixed duration;
5. repeat at least five times with no browser or unrelated API traffic;
6. retain logs, reports, failures, and environment metadata;
7. summarize central tendency and run-to-run variation.

Warm-up rounds are never included in the measurement aggregation. Start every
formal repetition from a documented ledger state and record the order of runs.
Because each contextual access operation writes two transaction-ID-keyed state
documents, rebuilding the deterministic network between formal repetitions is
the cleanest control for ledger growth.

## Baseline and ablation requirement

The connectivity read is not a policy baseline. A valid performance comparison
requires separately deployed, workload-compatible variants using the same
topology and ledger-write shape:

- role-only policy baseline;
- contextual policy without explanation construction;
- contextual policy with explanation but without explanation hashing;
- full proposed contextual policy with explanation, hash, and audit state.

Those variants are not created by this setup task. Until they exist and are
measured, the Caliper results may characterize only the full deployed method;
they cannot support a claim that one policy design is faster than another.

## Required evidence

Each manual run is written to a new directory under `experiments/runs/` and
contains its benchmark configuration, generated network configuration,
workload snapshots, environment record, Caliper log, run manifest, HTML report,
and machine-readable performance summary. Formal comparison tables belong in
`results/tables/`, plots in `results/plots/`, and interpretation in the next
`reports/iteration/` report.

Docker monitoring supplies container CPU, memory, network, and disk statistics.
The local Prometheus service scrapes the orderer and five Fabric peer operations
endpoints and supplies process memory, process CPU rate, chaincode endorsement
duration, and ledger-height queries. Missing monitoring samples must be reported
as missing, never replaced by zero.

## Limitations

- Single-host measurements do not establish multi-site scalability.
- One orderer does not establish Raft fault tolerance.
- Synthetic workload results do not establish real police-system traffic.
- Caliper measures the direct Fabric path; end-to-end web latency requires a
  separate API/browser benchmark.
