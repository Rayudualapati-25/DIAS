# v3 access-log policy: replay of recorded testbed traffic (offline)

- **Question:** which API calls should create a ledger access-log entry, and what do these entries cost (plan step 6, requirement I04)?
- **Kind:** offline replay. The HTTP calls recorded in two real testbed backend traces are passed through the backend's own access-log classifier. Nothing is re-executed on Fabric.
- **Command:**

```
M=experiments/runs/20260924_testbed_multivm/raw/backend-trace.jsonl
R=experiments/runs/20260925_reuse_100_users/raw/reuse-20260925T135014Z/backend-trace.jsonl
node experiments/v3/access-log-replay.js --out experiments/runs/20261002_v3_access_log_policy \
  --trace "$M" --trace "$R@since=$M"
```

- **Overlap between the traces:** the reuse trace is cumulative and starts with the whole multi-VM trace (same timestamps). `@since=` keeps only its events after the multi-VM trace ends, so no call is counted twice.
- **Modes:**
  - `all`: the evaluated v2 behaviour, classified by the v2 logger read from tag `eval-baseline-2026-10-01`;
  - `security`: the v3 default (design §12).

## Validation of the replay

- **Multi-VM trace:** every one of the 5,606 recorded access-log writes is paired with its call. Exactly 4 calls have no recorded write:
  - two auditor queue reads and two auditor review reads;
  - made 2.4 s and 10.5 s after the orderer was stopped in the fault test.
  - The fault analysis found the same thing for workflow transactions: ledger writes in flight during the failover failed (new leader about 12 s after the stop). These four writes were attempted and lost.
- **Reuse run:** every one of the 6,490 recorded writes is paired with its call. No call lacks a write.

## Result

| | Multi-VM runs (E5–E7) | Reuse run, 100 users |
|---|---|---|
| HTTP calls | 5,613 | 6,491 |
| Ledger transactions recorded | 8,278 | 10,904 |
| …of which access-log writes | 5,606 (67.7%) | 6,490 (59.5%) |
| Access-log writes, v2 (`all`) | 5,610 | 6,490 |
| Access-log writes, v3 (`security`) | 2,939 (−47.6%) | 2,072 (−68.1%) |
| Access-log writes per workflow, v2 | 4.19 | 2.63 |
| Access-log writes per workflow, v3 | 2.20 | 0.84 |
| Measured latency of one access-log write, p50 / p95 | 2,037 / 2,071 ms | 2,044 / 2,080 ms |
| …time waiting for the block to commit, p50 | 2,027 ms | 2,034 ms |
| …endorsement, p50 | 6.8 ms | 7.2 ms |

Per-action counts are in `access-log-replay.json`.

**What v3 still logs:**
- auditor review reads (each one opens a justification and a recommendation);
- logins;
- requests to read a request;
- the queue, authorization and decision-log reads.

**What v3 no longer logs:** successful `access.request` and `dias.auditor.decision` calls. Their own transactions are already the ledger record.

## Interpretation

- In v2, about two-thirds of all ledger transactions in the testbed runs were access-log entries.
- Each entry waits about 2 s for the block to close. The logger runs after the HTTP response, so this time is not part of the measured request latency. It does add ledger load: more transactions per block, and more endorsement work on the peers.
- **Consequence:** v2 throughput and resource results include this extra load. v3 runs with the default mode are therefore not directly comparable. Setting `DIAS_ACCESS_LOG_MODE=all` reproduces the v2 logging for a like-for-like comparison.
- **Who may read the access log:** unchanged. `QueryAccessEvents` is limited to the reviewer roles.

## Limits

- The counts depend on the scripted clients' call mix. The scripted auditor opened each review once; a human auditor may reread reviews.
- The latency figures are those of the v2 runs. The cost of v3's other ledger changes (commitments, policy checks) is not measured here.
