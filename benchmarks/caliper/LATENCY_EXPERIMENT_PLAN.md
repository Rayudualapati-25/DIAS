# Caliper latency-axis pilot plan

## Purpose

This suite produces five measured latency graphs for the live SEBA-XAI Fabric
network. It is a short characterization pilot used to verify the measurement
method and choose formal experiment settings. It is not, by itself,
publication-grade evidence because every point is measured only once and the
ledger is not rebuilt between points.

Caliper connects directly to the Fabric Peer Gateway. The measurements include
client submission, endorsement, ordering and commit for writes, and Gateway
evaluation for reads. They do not include browser, REST API or off-chain file
retrieval time.

## Frozen system under test

- Channel: `crimechannel`
- Chaincode: `crimerecords`
- Topology: five peers, five CouchDB instances and one Raft orderer
- Deployment: single-host Docker/Colima prototype
- Dataset: the deterministic synthetic records created by `make all`
- Transaction timing: Caliper `TxStatus` creation-to-final timestamps retained
  as JSONL and summarized as min, mean, p50, p95, p99 and maximum latency

## Five experiments

### 1. Concurrent clients versus record-lookup latency

- X-axis: 1, 2, 4 and 8 concurrent Caliper workers
- Y-axis: transaction latency in milliseconds
- Operation: read the existing `REC-FIR-001` metadata
- Load: one request per second per worker
- Control: 10-second warm-up followed by a 45-second measurement for each point

The axis is labelled **Caliper workers/clients**, not human users. Every worker
currently uses the same enrolled `io.krishnan` identity, so this experiment
does not claim distinct-user or certificate scalability.

### 2. Offered TPS versus access-write latency

- X-axis: 1, 2, 5, 10 and 20 offered transactions per second
- Y-axis: transaction latency in milliseconds
- Operation: submit contextual access requests for `REC-FIR-001`
- Workers: four
- Control: one separately reported 60-second round per offered-load point

The graph is used to identify rising queueing latency, throughput flattening or
transaction failures. The configured TPS values are inputs, not claims about
network capacity.

### 3. Query result count versus search latency

- X-axis: 1, 2 and 3 records returned
- Y-axis: query latency in milliseconds
- Operation: `RecordContract:QueryRecords`
- Load: one aggregate TPS with two workers, selected below the observed rich-query saturation point
- Control: 10-second warm-up followed by a 45-second round for each query

The result counts are verified against the seeded ledger before interpretation:
`CASE-2026-002` returns one record, `CASE-2026-001` returns two, and
`district-north` returns three. This replaces a misleading file-size test: raw
case-file content is stored off chain, while Caliper reads on-chain metadata.
The original five-TPS pilot was rejected after queueing produced 60-second
deadlines; that overload would measure saturation rather than result-count cost.

### 4. Policy decision path versus access-write latency

- X-axis: fixed policy outcome path
- Y-axis: transaction latency in milliseconds
- Load: one TPS with one worker
- Control: 10-second warm-up followed by 45 seconds per path

The paths are credential revoked (`CRED_NOT_ACTIVE`), RBAC deny
(`RBAC_NO_PERMISSION`), cross-jurisdiction (`CROSS_JURISDICTION`), not assigned
(`NOT_ASSIGNED`) and full allow (`POLICY_SATISFIED`). The workload verifies the
returned reason code so a mislabeled path makes the run fail.

This is a categorical path comparison, not a "number of policy rules" test.
Rule count is compiled into the deployed chaincode and cannot be varied without
deploying controlled chaincode variants.

### 5. Elapsed time versus sustained-write latency

- X-axis: ten consecutive 30-second measurement bins
- Y-axis: transaction latency in milliseconds
- Operation: verified full-allow access write
- Load: one TPS with one worker
- Control: one 10-second warm-up before the measurement bins

This approximately five-minute measurement is a stability pilot. It must not
be described as the planned two-hour endurance experiment.

## Artifact and graph rules

Every run must finish with status `completed` and retain its input and executed
benchmark configs, network config, environment record, workload and observer
source snapshots, Caliper log, HTML report, summary, transaction JSONL,
transaction summary and SHA-256 hashes. Warm-up rounds are excluded from all
graphs.

Each graph displays p50, mean and p95 latency and is saved as a 300-DPI PNG and
vector PDF. Its source rows are saved as CSV, and a provenance manifest records
the exact run IDs and source hashes. Pilot figures must visibly state:
"Single live-network pilot; not repeated paper evidence."

## Formal paper protocol

Before using these figures for final comparative claims:

1. freeze the configs after reviewing this pilot;
2. rebuild the same deterministic ledger before each repetition;
3. run at least five repetitions per frozen point in randomized order;
4. report run-to-run variation and all failures;
5. compare the full method with a workload-compatible role-only baseline;
6. run ablations for explanation construction and explanation hashing;
7. retain negative results, resource traces, limitations and failure modes.

The single-host topology does not establish multi-site scalability or Raft
fault tolerance, and synthetic traffic does not establish production police
workload behavior.
