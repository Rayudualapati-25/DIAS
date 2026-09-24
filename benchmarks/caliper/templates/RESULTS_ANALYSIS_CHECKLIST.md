# Caliper Results and Analysis Checklist

This checklist prevents planned parameters or plausible-looking values from being
reported as measurements. Do not write performance claims until the corresponding
Caliper reports, logs, manifests, and resource data exist in the repository.

## Claim gate

- [ ] Complete repeated actual runs for every reported measurement round; use at
  least five independent repetitions as required by the current experiment plan,
  unless a different count is preregistered before testing.
- [ ] Run the defined baseline under the same network, hardware, ledger state,
  worker count, duration, and offered load as the proposed method.
- [ ] Run each required ablation under those same controlled conditions.
- [ ] Retain every run, including failures and negative results.
- [ ] Defer all comparative, bottleneck, scalability, stability, and resource-use
  claims until the repeated baseline, proposed-method, and ablation evidence exists.

## Before each run

- [ ] Record the configuration file hash, network configuration hash, Caliper
  version, Fabric image/version, host hardware, OS, Node.js version, and timestamp.
- [ ] Confirm the required Fabric containers are healthy and that `REC-FIR-001`
  exists for `io.krishnan` in `PoliceMSP`.
- [ ] Confirm Prometheus is reachable at `http://127.0.0.1:9090` and that all four
  configured queries return the expected `instance` labels for `job=~"fabric-.*"`.
- [ ] Fix or record the ledger starting state and block height. Do not silently
  compare a clean ledger with a ledger enlarged by earlier write tests.
- [ ] Stop unrelated UI/API activity and record any unavoidable background load.
- [ ] Decide and record the run order or randomization strategy before collecting
  results.

## After each run

- [ ] Preserve the Caliper HTML report, full log, benchmark configuration, generated
  network configuration, environment record, and run manifest together.
- [ ] Confirm that warm-up rows are not copied into measurement tables.
- [ ] Record successful and failed transactions, observed send rate, throughput,
  and minimum, average, and maximum latency directly from the report.
- [ ] Record peak CPU and memory with their source and component/container name;
  do not combine Docker and Prometheus maxima without explaining the method.
- [ ] Check that Prometheus returned complete samples throughout the round. Mark
  missing resource measurements as missing, never as zero.
- [ ] For mixed and endurance runs, verify the observed read/write operation counts
  against the deterministic seven-read/three-write schedule.
- [ ] Investigate and classify every failed transaction using logs before interpreting
  the failure rate.

## Repetition and aggregation

- [ ] Keep one CSV row per repetition and measurement round; never overwrite raw rows.
- [ ] Report central tendency and variability across independent repetitions, and
  state the exact aggregation method and confidence-interval procedure.
- [ ] Do not average already aggregated percentiles. Retain raw latency observations
  if percentile analysis is required.
- [ ] Check for outliers and report the rule used; do not remove runs merely because
  their results are unfavorable.

## Interpretation checks

- [ ] Define the increasing-load saturation criterion before applying it, using
  measured throughput, latency, and failure rate together.
- [ ] Attribute a consensus/orderer bottleneck only when orderer, block, and commit
  evidence supports that explanation.
- [ ] Attribute a CouchDB/state-database bottleneck only when peer endorsement,
  database resource, and latency evidence supports that explanation.
- [ ] Claim an endurance memory leak only after repeated runs show sustained growth
  that does not return after workload completion; a single peak is insufficient.
- [ ] Separate facts (measured values), interpretations (supported explanations),
  and recommendations (future changes) in the paper.
- [ ] State limitations, including single-host deployment effects, offered-load
  ceilings, missing telemetry, and any unsuccessful runs.

## Paper table and prose release

- [ ] Populate `caliper_results_template.csv` only from retained artifacts.
- [ ] Populate `ieee_results_table_template.tex` only after aggregation is complete.
- [ ] Link every non-obvious paper claim to a table, plot, metric file, log, or source
  note in the repository.
- [ ] Ensure baseline and ablation results appear beside the proposed method; if any
  evidence is missing, label the evaluation incomplete instead of filling gaps with
  hypothetical data.
