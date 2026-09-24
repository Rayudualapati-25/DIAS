# Interactive latency evidence

These artifacts support the paper's **client-observed, end-to-end latency**
claims for the local Fabric-backed prototype. They are not isolated chaincode
timings and do not establish production capacity or geographic scalability.

## Measured paths

| Operation | Timed boundary |
|---|---|
| Search | HTTP request, backend validation, Fabric `QueryRecords`, and parsed response |
| Submit | HTTP request, agency-vault write, Fabric endorsement, ordering, validation, commit, and parsed response |
| Authorized release | HTTP request, check of a previously granted decision, vault read, SHA-256 verification, and parsed response |

The release experiment created its access grant before measurement. It did not
rerun the contextual policy for every payload request.

## Retained evidence

- Corrected run: `experiments/runs/2026-08-25T14-12-11-482Z_ui_interaction_latency/`
- Unindexed diagnostic: `experiments/runs/2026-08-25T14-07-26-224Z_ui_interaction_latency/`
- Paper table: `results/tables/ui-latency/summary.csv`
- Paper figure and manifest: `results/plots/ui-latency/`

The corrected run contains 2,340 successful requests and no failures. Each
point pools three batches, giving `3N` observations at concurrency level `N`.
The figure reports the nearest-rank p50 and p95 of those pooled observations.

The unindexed result is a one-batch diagnostic, not a controlled database
benchmark. At 10 sessions its search p50 was 4,240.03 ms. At 25 sessions, all
25 requests returned HTTP 500 after 5.01--5.04 seconds. The backend's Fabric
evaluation deadline was configured at five seconds.

## Reproduce and verify

Verify the complete retained evidence chain without contacting the network:

```bash
make ui-latency-verify
```

Run a new live experiment after starting and seeding Fabric and starting the
backend separately:

```bash
make ui-latency-run
```

Generate figures from a retained report:

```bash
make ui-latency-plots \
  UI_LATENCY_RUN=experiments/runs/2026-08-25T14-12-11-482Z_ui_interaction_latency
```

New runs record the resolved configuration, command overrides, repository
revision and tracked status, active Fabric/CouchDB container image names, and
SHA-256 digests of the runner and measured backend/chaincode sources. The
retained 2026-08-25 run predates that metadata addition, so it must be reported
with its recorded single-host limitations.

## Paper-safe interpretation

Use: “client-observed latency in a single-host local deployment.”

Do not describe these values as pure blockchain latency, chaincode execution
time, a capacity limit, a production benchmark, or a scalability result.
