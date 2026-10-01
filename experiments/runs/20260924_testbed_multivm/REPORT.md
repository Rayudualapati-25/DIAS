# DIAS multi-machine testbed: results

Every number below is produced by the analysis scripts in `testbed/analysis/` from the raw run files in `raw/`; none is typed by hand. Figures are in `analysis/*/` (PDF for the paper, PNG for viewing).

## 0. What was run

- Four Linux VMs (M1-M4, 3 vCPU and 6 GB each) on one Apple M3 Max (16 cores, 64 GB), joined by Docker Swarm; the Mac itself (M5) serves the V7 model on its GPU.
- Hyperledger Fabric 2.5.16: five organizations, five peers with CouchDB, three Raft orderers on three VMs, six CAs; blocks close after 2 s or 10 transactions; endorsement by 3 of 5.
- Contract diasrecords 2.3: the ledger stores each request and the auditor decision with the LLM recommendation value and the derived agreement; justification and reason text stay off-chain.
- 120 users on the ledger (20 prototype users + 100 load users copying the 12 requester profiles), 3 cases, 20 case files.
- Every request of every run is fixed by a seeded plan with the written policy's answer; the ledger's committed facts were checked against the plan for every workflow.
- The auditor follows the recommendation as soon as it is ready, so times contain no human review time.
- Monitoring every 5 s: node-exporter (each VM) through Prometheus, Docker statistics (each container), a Mac sampler (M5).

Raw data folders in `raw/`: `config`, `containers`, `e3-ledger-20260925T043602Z`, `e4-llm-alone`, `e5-burst-20260924T174213Z`, `e6-steady-20260925T010913Z-ABORTED-not-used`, `e6-steady-20260925T012544Z-ABORTED-not-used-user-stopped`, `e6-steady-20260925T023853Z`, `e7-fault-20260925T043602Z`, `environment`, `logs`, `mac`, `plans`, `probes`.

## 1. Recommendation quality (E1) and adversarial test (E2)

Why: before an auditor relies on the advice, it must match the written policy. All numbers were recomputed from the raw prediction files and match the stored confusion matrices.

- Untuned Qwen3-14B: of 300 requests the policy allows, 70 were recommended for approval (204 wrongly refused, 26 unusable answers).
- Untuned Qwen3-14B: of 300 requests the policy denies, 266 were recommended for denial (14 wrongly granted, 20 unusable answers).
- Untuned Qwen3-14B: 336 of 600 decisions correct; 554 of 600 answers usable; right reason 203, right clauses 130.
- V7 (fine-tuned): of 300 requests the policy allows, 298 were recommended for approval (2 wrongly refused, 0 unusable answers).
- V7 (fine-tuned): of 300 requests the policy denies, 294 were recommended for denial (6 wrongly granted, 0 unusable answers).
- V7 (fine-tuned): 592 of 600 decisions correct; 600 of 600 answers usable; right reason 584, right clauses 572.
- Untuned Qwen3-14B: of 204 adversarial requests the policy denies, 4 got through (wrongly granted), 175 were stopped, 25 unusable.
- V7 (fine-tuned): of 204 adversarial requests the policy denies, 6 got through (wrongly granted), 198 were stopped, 0 unusable.
- Paired test on the same 600 cases: V7 right where the untuned model was wrong 264 times, the reverse 8 times (exact McNemar p = 1.8e-67).
- Balanced accuracy over usable answers: untuned 60.27%, V7 98.67%.

## 2. The LLM alone (E4)

Why: the model is the slowest part; its capacity alone bounds the whole system.

- The served V7 model answered all 600 test cases one at a time: median 8.33 s, 95th percentile 9.19 s, mean 8.25 s per recommendation.
- Capacity: 7.27 recommendations per minute; 10.4 output tokens per second of inference time; 1926 prompt tokens on average.
- It gave the same decision as the stored V7 evaluation on 600 of 600 cases (600 byte-identical answers) and 592 of 600 correct decisions; every answer is byte-identical, so the testbed serves V7 exactly.

## 3. The ledger alone (E3)

Why: to show how fast the blockchain part is on its own and that it is not what limits DIAS.

- W1 CreateAccessRequest: throughput 91.0, 112.1, 122.7, 89.1, 63.3 tx/s and median latency 0.10, 0.19, 0.22, 0.28, 0.40 s at 10, 25, 50, 75, 100 in flight; 0 failed.
- W2 SubmitAuditorDecision: throughput 72.9, 82.0, 90.6, 85.1, 76.7 tx/s and median latency 0.13, 0.29, 0.54, 0.86, 1.27 s at 10, 25, 50, 75, 100 in flight; 0 failed.
- R1 GetRequest: throughput 2145.6, 2405.0, 2488.7, 2507.5, 2508.6 reads/s and median latency 0.00, 0.01, 0.02, 0.03, 0.04 s at 10, 25, 50, 75, 100 in flight; 0 failed.
- R2 QueryAccessDecisions: throughput 2.3, 1.2, 0.0, 0.0, 0.0 reads/s and median latency 4.35, 20.69, n/a, n/a, n/a s at 10, 25, 50, 75, 100 in flight; 225 failed. (`n/a` means no call succeeded at that load.)

## 4. Whole system at 10, 25, 50, 75 and 100 users (E5)

Why: to show how the complete system behaves as users grow and which component causes the growth. Each level ran three times (three iterations); users 1..L start one workflow each at the same moment.

- 10 users: 30/30 workflows completed; median 40.5 s, p95 77.7 s; 7.62 workflows/min; request commit 0.10 s, queue 34.0 s, LLM 7.66 s, decision commit 2.04 s; correct 30/30.
  - iterations: 7.42, 7.72, 7.72 workflows/min (SD 0.177); median per iteration 39.8 s (SD 0.76), p95 per iteration 78.8 s (SD 1.86).
- 25 users: 75/75 workflows completed; median 97.1 s, p95 179.9 s; 8.09 workflows/min; request commit 0.16 s, queue 87.6 s, LLM 7.33 s, decision commit 2.04 s; correct 71/75.
  - iterations: 8.21, 8.05, 8.01 workflows/min (SD 0.108); median per iteration 96.9 s (SD 1.91), p95 per iteration 178.3 s (SD 2.14).
- 50 users: 150/150 workflows completed; median 190.0 s, p95 355.0 s; 8.12 workflows/min; request commit 0.26 s, queue 181.9 s, LLM 7.35 s, decision commit 2.04 s; correct 148/150.
  - iterations: 8.09, 8.14, 8.11 workflows/min (SD 0.024); median per iteration 189.5 s (SD 0.46), p95 per iteration 354.9 s (SD 1.15).
- 75 users: 225/225 workflows completed; median 282.7 s, p95 526.9 s; 8.16 workflows/min; request commit 0.34 s, queue 272.7 s, LLM 7.32 s, decision commit 2.04 s; correct 220/225.
  - iterations: 8.21, 8.15, 8.12 workflows/min (SD 0.049); median per iteration 283.2 s (SD 2.06), p95 per iteration 530.8 s (SD 3.54).
- 100 users: 300/300 workflows completed; median 372.3 s, p95 699.8 s; 8.16 workflows/min; request commit 0.42 s, queue 363.5 s, LLM 7.33 s, decision commit 2.05 s; correct 290/300.
  - iterations: 8.19, 8.13, 8.17 workflows/min (SD 0.029); median per iteration 370.1 s (SD 2.44), p95 per iteration 698.0 s (SD 2.06).
- Trend: the median end-to-end time grows linearly with the number of users (slope 3.69 s per extra user, R^2 = 1.000); throughput stays between 7.62 and 8.16 workflows/min because one model server answers one request at a time.
- Disagreements with the written policy: 21 (7 wrongly granted, 14 wrongly refused); by action: annotate 19, export 1, view 1.
- Replayed one at a time with no other load, the 21 disagreeing requests gave the same decision 21 times, the same reason 21 times and byte-identical model output 21 times.

## 5. One hour with 100 users (E6)

Why: to show the system stays correct and within its resources over an hour of normal work (InterSnap's resilience test).

- 369 workflows arrived at random times over 60.5 minutes; 369 completed, 0 failed.
- Operations: 4057 of 4057 succeeded (100.00%).
  - Access request (ledger write): 369 succeeded, 0 failed
  - LLM recommendation: 369 succeeded, 0 failed
  - Pending list (read): 369 succeeded, 0 failed
  - Auditor review (read): 369 succeeded, 0 failed
  - Auditor decision (ledger write): 369 succeeded, 0 failed
  - Requester read-back (read): 369 succeeded, 0 failed
  - Access-log entry (ledger write): 1843 succeeded, 0 failed
- Workflow time: median 24.3 s, p95 57.9 s; correct 358/369.
- M1: CPU mean 0.11 cores, peak 0.17; memory peak 1.11 GB (of 6.19 GB).
- M2: CPU mean 0.15 cores, peak 0.25; memory peak 1.40 GB (of 6.19 GB).
- M3: CPU mean 0.18 cores, peak 0.29; memory peak 1.42 GB (of 6.19 GB).
- M4: CPU mean 0.05 cores, peak 0.08; memory peak 1.11 GB (of 6.19 GB).
- M5 (Mac, model server): CPU mean 0.16 cores, peak 0.37; resident memory peak 8.80 GB; GPU utilisation mean 85.8%; whole Mac CPU mean 2.45 cores.
- Memory change from the first to the last five minutes: M1 +11 MB, M2 +20 MB, M3 +20 MB, M4 +11 MB, model server -268 MB.
  - minutes 0-10: 67/67 completed, median 36.5 s, p95 63.1 s
  - minutes 10-20: 64/64 completed, median 22.7 s, p95 45.4 s
  - minutes 20-30: 65/65 completed, median 24.0 s, p95 43.1 s
  - minutes 30-40: 55/55 completed, median 18.7 s, p95 50.0 s
  - minutes 40-50: 61/61 completed, median 29.8 s, p95 67.9 s
  - minutes 50-60: 57/57 completed, median 17.8 s, p95 35.5 s

## 6. Machine failures during work (E7)

Why: with three orderers on three machines and endorsement by 3 of 5 organizations, DIAS should keep working when one orderer or one peer stops.

- Normal: 18/21 workflows completed; median 18.0 s, p95 33.9 s. Failures: decision: decision 500: internal error; submit: submit 500: internal error
- Leader orderer stopped: 20/21 workflows completed; median 39.8 s, p95 51.5 s. Failures: submit: submit 500: internal error
- Court peer stopped: 17/17 workflows completed; median 16.8 s, p95 30.8 s.
- Recovered: 24/24 workflows completed; median 31.8 s, p95 56.5 s.
- A new Raft leader was elected 6.18 s after the leader orderer stopped (leader before: orderer3).
- After recovery every peer and orderer reports the same ledger height: True.
- After recovery all five peers report the same block hash: True.
- Problems recorded by the fault script: none.

## 7. Ledger growth

Why: two list views scan every stored request or decision before they filter, so their time grows with the ledger; a single-key read should not.

- QueryPendingAuditorRequests: 789 requests on the ledger -> 126 ms; 1,256 requests on the ledger -> 219 ms; 1,337 requests on the ledger -> 234 ms; 31,828 requests on the ledger -> 5380 ms
- QueryAccessDecisions: 789 requests on the ledger -> 94 ms; 1,256 requests on the ledger -> 154 ms; 1,337 requests on the ledger -> 160 ms; 31,828 requests on the ledger -> 3495 ms
- GetRequest: 789 requests on the ledger -> 2 ms; 1,256 requests on the ledger -> 2 ms; 1,337 requests on the ledger -> 3 ms; 31,828 requests on the ledger -> 3 ms

## Per-container resources

| Machine | Container | Mean CPU at 100 users (cores) | Peak memory at 100 users (MB) | Mean CPU over the hour (cores) | Peak memory over the hour (MB) |
|---|---|---|---|---|---|
| M1 | ca-orderer | 0.000 | 9 | 0.000 | 9 |
| M1 | ca-police | 0.000 | 10 | 0.000 | 10 |
| M1 | couchdb-police | 0.015 | 89 | 0.020 | 98 |
| M1 | chaincode (police) | 0.000 | 74 | 0.001 | 72 |
| M1 | node-exporter-m1 | 0.000 | 10 | 0.003 | 11 |
| M1 | orderer1 | 0.003 | 74 | 0.003 | 78 |
| M1 | peer0.police | 0.015 | 115 | 0.024 | 124 |
| M2 | ca-forensics | 0.000 | 9 | 0.000 | 9 |
| M2 | ca-prosecution | 0.000 | 9 | 0.000 | 9 |
| M2 | couchdb-forensics | 0.014 | 84 | 0.018 | 94 |
| M2 | couchdb-prosecution | 0.014 | 80 | 0.019 | 87 |
| M2 | chaincode (forensics) | 0.000 | 71 | 0.001 | 70 |
| M2 | chaincode (prosecution) | 0.000 | 70 | 0.001 | 69 |
| M2 | node-exporter-m2 | 0.003 | 10 | 0.001 | 10 |
| M2 | orderer2 | 0.003 | 69 | 0.004 | 69 |
| M2 | peer0.forensics | 0.014 | 111 | 0.021 | 110 |
| M2 | peer0.prosecution | 0.015 | 108 | 0.022 | 108 |
| M3 | ca-audit | 0.000 | 9 | 0.000 | 9 |
| M3 | ca-court | 0.000 | 9 | 0.000 | 9 |
| M3 | couchdb-audit | 0.014 | 82 | 0.031 | 90 |
| M3 | couchdb-court | 0.014 | 90 | 0.018 | 87 |
| M3 | chaincode (audit) | 0.001 | 67 | 0.003 | 80 |
| M3 | chaincode (court) | 0.000 | 68 | 0.001 | 70 |
| M3 | node-exporter-m3 | 0.000 | 10 | 0.001 | 11 |
| M3 | orderer3 | 0.003 | 82 | 0.005 | 78 |
| M3 | peer0.audit | 0.016 | 111 | 0.032 | 123 |
| M3 | peer0.court | 0.014 | 113 | 0.021 | 112 |
| M4 | dias-backend | 0.003 | 101 | 0.004 | 96 |
| M4 | node-exporter-m4 | 0.003 | 11 | 0.002 | 11 |
| M4 | prometheus | 0.011 | 88 | 0.009 | 159 |

## Limits

- The four VMs and the model server share one Apple M3 Max; the VM network is virtual (Lima user-v2), not a LAN.
- One model server and one recommendation worker: the LLM sets the workflow throughput.
- All users, cases, records and requests are synthetic.
- Per-container data (Docker statistics) start during the 50-user level of E5: cAdvisor could not read containers under Docker's containerd image store. Whole-VM data cover every run.
- The shared single-host network of the wt-dias project kept running in the background (about 0.2 CPU core).
- Two earlier attempts of the one-hour run are kept as `raw/*-ABORTED-*` and not used. The first was stopped after 11 minutes because an evaluation script was started by mistake and loaded the model server (Ubuntu's daily upgrade also ran on two VMs during it); the second was stopped after 4 minutes at the author's request. The reported E6 is a fresh, complete run of the same plan.
- Ubuntu's automatic security upgrades ran on M1 and M3 after E5 and before E6 (133 packages each, listed in `raw/environment/`); Docker, containerd and the running kernel were unchanged on all four VMs.
- For E6, E7, E4 and E3 the VMs' periodic maintenance timers (package updates, firmware metadata, manual index, log rotation) were paused so they could not add unrelated CPU load; during E5 they were active, and only short jobs (seconds each) ran.
- Every run used AC power. The macOS power log shows AC power through E5; the Mac's AC setting is High Power Mode and no settings change is logged. From E6 on, a 30-second log records the power source and mode (`raw/mac/power-log.csv`).

