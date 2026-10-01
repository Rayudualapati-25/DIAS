# Iteration 054 — DIAS multi-VM remaining experiments

Date: 2026-09-25 (Asia/Kolkata)  
Plan: `experiments/plans/20260924_multi_vm_experiments_plan.md`  
Run: `experiments/runs/20260924_testbed_multivm/`

## Objective

Complete the remaining four-VM testbed experiments, retain the raw evidence,
verify the run invariants, and generate the consolidated report, tables,
figures, manifest, and evidence-derived results draft.

## Outcome

The remaining experiment sequence completed. It covered deterministic replay of
the 21 E5 recommendation disagreements, the E7 fault and recovery test, the E4
600-case model-only evaluation, and the E3 ledger-only capacity sweep. The
previously completed clean E6 one-hour run was then consolidated with E1--E5 and
E7 into the final testbed report.

All reported values below are generated from retained machine-readable run
artifacts. The two intentionally stopped E6 attempts remain marked as aborted
and are not included in the reported E6 result.

## Results

### E4 — model alone

- 600/600 responses were schema-valid.
- Decision accuracy and macro F1 were both 98.67%.
- There were 6 false allows and 2 false denies.
- Median response time was 8.33 s and p95 was 9.19 s, corresponding to 7.27
  recommendations per minute for one model worker.
- All 600 outputs were byte-identical to the stored V7 evaluation.

### E3 — ledger alone

- Request-write throughput increased from 91.0 tx/s at 10 clients to a peak of
  122.7 tx/s at 50 clients, then fell to 63.3 tx/s at 100 clients.
- Auditor-decision throughput peaked at 90.6 tx/s at 50 clients and fell to
  76.7 tx/s at 100 clients.
- Single-request reads remained near 2,509 reads/s at 100 clients, with 39 ms
  median latency.
- The full `QueryAccessDecisions` list query was the clear bottleneck: 2.3
  reads/s at 10 clients, 1.2 reads/s at 25 clients, and no successful calls at
  50, 75, or 100 clients. All 225 failures are retained in the result.
- Ledger growth explains the list-query degradation: after E3, the ledger held
  31,828 requests and 31,826 decisions. A point `GetRequest` read remained about
  3 ms, while the pending and decision list queries took about 5.38 s and 3.50 s.

### E7 — fault and recovery

- 79 of 83 workflows completed and 4 failed during the staged orderer/peer
  fault test.
- Raft leadership moved from orderer3 to orderer1 after the leader was stopped.
- After recovery, all peers and orderers reported ledger height 3435, all five
  peers reported the same block hash, and the fault script recorded no recovery
  problem.
- The four workflow failures and one pending auditor request are preserved as
  measured fault impact rather than removed from the result.

### E6 — one-hour steady run

- The clean run completed 369/369 workflows with no technical failure and
  4,057/4,057 successful measured operations.
- Median workflow time was 24.3 s and p95 was 57.9 s.
- 358/369 workflow recommendations matched the written policy.
- Resource use remained within the configured VM and Mac capacity; the model
  server was the throughput-limiting component.

### E5 disagreement replay

- All 21 E5 disagreements reproduced the same decision, same reason, and
  byte-identical output when replayed individually.
- This shows the disagreements are deterministic model errors, not an artifact
  of concurrent load.

## What worked

- Every planned remaining experiment ran to completion and retained its raw
  requests, logs, metrics, monitoring data, and configuration.
- The final verifier confirmed planned facts, no prompt reuse, AC power, no
  recorder gaps, and exact request/decision counts through E7.
- Consolidation generated the manifest, report, CSV/JSON tables, PNG/PDF
  figures, and LaTeX results draft.
- The network recovered from the staged orderer and peer failures and converged
  to one ledger height and block hash.

## What failed or remains weak

- V7 still produced 6 unsafe false-ALLOW decisions on the 600-case evaluation.
- The complete system is limited to one serialized model worker; E5 throughput
  plateaued near eight workflows per minute while queueing latency grew.
- Four workflows failed during E7, so the fault test supports recovery and
  convergence, not uninterrupted success for every in-flight request.
- Ledger list queries scan growing state and do not scale: the decision-log
  query had no successful calls at 50 or more concurrent clients.
- The testbed runs four virtual machines and the model server on one Apple M3
  Max. It is a reproducible prototype result, not a production deployment
  capacity claim.
- All users, cases, records, and requests are synthetic.

## Reporting fix

The initial consolidation exposed two analysis-code assumptions that every load
level must have a median latency. The E3 plotter and report generator were
updated to represent a zero-success level as missing latency (`n/a`) rather
than crashing or inventing a zero value. The full consolidation then passed.

## Next experiments

1. Replace the full-ledger scans used by pending-request and decision-log views
   with indexed or paginated queries, then rerun E3 with the same load levels.
2. Add at least one additional model worker or a bounded batching strategy and
   rerun E5/E6 to quantify throughput and queueing changes.
3. Add client retry/idempotency handling for in-flight writes during leader and
   peer failures, then rerun E7 and compare failure counts.
4. Add targeted training/evaluation cases for the retained false allows without
   tuning on the final held-out examples.

## Evidence and verification

- Consolidated report: `experiments/runs/20260924_testbed_multivm/REPORT.md`
- Content manifest: `experiments/runs/20260924_testbed_multivm/manifest.json`
- Evidence-derived LaTeX draft:
  `experiments/runs/20260924_testbed_multivm/paper/results_draft.tex`
- E3 raw run:
  `experiments/runs/20260924_testbed_multivm/raw/e3-ledger-20260925T043602Z/`
- E4 raw metrics:
  `experiments/runs/20260924_testbed_multivm/raw/e4-llm-alone/metrics.json`
- E6 clean run:
  `experiments/runs/20260924_testbed_multivm/raw/e6-steady-20260925T023853Z/`
- E7 raw run:
  `experiments/runs/20260924_testbed_multivm/raw/e7-fault-20260925T043602Z/`
- Final consolidation command: `bash testbed/scripts/finalize.sh` — PASS.
- Python analysis syntax checks for `analyze_e3.py` and `make_report.py` — PASS.
