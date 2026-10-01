# Reuse experiment at 100 users: results (run reuse-20260925T135014Z, 25 Sep 2026)

## What was run

- **Where:** live on the multi-VM testbed (four VMs plus the Mac with the V7 model), from 19:20 to 23:32 IST.
- **Users and records:** 100 users each sent one base request, 50 that the policy allows and 50 it denies. Each base request had its own record and two siblings (the same record properties in a different case). That makes 300 records.
- **Repeats:** rounds 0 to 7 each sent all 300 requests again, so 2,400 requests in total. After round r every record had r repeated requests. The paper's conditions are r = 0, 1, 3 and 7.
- **Auditor:** one approval decision per base request, drawn once before the run. The auditor overrode a model DENY only for an approved request, and otherwise followed the model.
- **Designs compared:**
  - **Exact-record reuse** (DIAS) ran for real on the ledger.
  - **No reuse** and **property-fingerprint reuse** (the old SEAL design, never deployed) were computed over the same live requests, with the same model answers and the same auditor decisions.

## Checks

- 2,400 of 2,400 requests completed: none failed, none missing, none duplicated.
- The facts the ledger committed matched the plan for every request.
- The ledger held no authorization for these records before the run.
- After the run it held exactly the 72 authorizations the run created. Each covers the one user, record, case, action and purpose of the request that created it.
- The Mac was on AC power throughout.

## Results

| Repeats per record | Requests | Reviews, no reuse | Reviews, exact-record (live) | Reviews, fingerprint (replayed) | Grants on a record the auditor did not approve: exact-record / fingerprint |
|---|---|---|---|---|---|
| 0 | 300 | 300 | 300 (0 avoided) | 252 (48 avoided, 16.0%) | 0 / 48 |
| 1 | 600 | 600 | 528 (72 avoided, 12.0%) | 480 (120 avoided, 20.0%) | 0 / 96 |
| 3 | 1,200 | 1,200 | 984 (216 avoided, 18.0%) | 936 (264 avoided, 22.0%) | 0 / 192 |
| 7 | 2,400 | 2,400 | 1,896 (504 avoided, 21.0%) | 1,848 (552 avoided, 23.0%) | 0 / 384 |

- **Exact-record savings follow p × r / (r + 1), with p = 72/300 = 0.24.** The share of approved records is the same in every condition, so the savings rise and then flatten towards 24%. The dip in the old figure is gone, because the old replay drew the auditor's approvals again in each condition.
- **Property-fingerprint reuse grows linearly in wrong grants: 48 × (r + 1).** Each approval also covers the two sibling records, which the auditor never saw, in every round. It avoids only 48 more reviews than exact-record reuse at every level.
- **Reuse never granted a request to a different user in either design.** Each user's base facts are different, so no two users share a fingerprint.

## Time

- A request granted by reuse took **0.53 s** (median, contract only).
- A reviewed request took **11.82 s** of processing: request commit 2.04 s, model inference 7.71 s and decision commit 2.07 s.
- With 100 users sending at once, a reviewed request also waited for the single model server: a median of **12.6 min** in round 0 and **9.3 min** in rounds 1 to 5. Reuse took 72 requests per round out of the queue.
- A round took **40.2 min** without reuse (round 0) and **28.6 to 28.9 min** with it (rounds 1 to 5).
- Rounds 6 and 7 were slower (31.5 and 32.0 min; model median 8.26 and 8.63 s), because other work was running on the Mac. This is recorded in `raw/.../operator-notes.json`. The counts do not depend on speed.

## The model's answers on this workload

- Round 0 had 300 distinct requests, and the model answered 288 correctly (96.0%).
  - 9 wrong DENY on requests the policy allows. Their base requests were not in the approval set, so they were denied in every round.
  - 3 wrong ALLOW on requests the policy denies: the base request RU094 and its two siblings. The scripted auditor followed the model, so these were granted through review in every round (24 grants in all). This is a model error, not a reuse error, and no authorization was involved.
  - Errors by type: 10 of 200 siblings (5.0%) against 2 of 100 base copies (2.0%).
- Every request got the same answer in every round, with one exception. In round 7 one call was lost in transit between the VM and the Mac (`server_unreachable: fetch failed`); the model server had answered and logged HTTP 200. The backend recorded no recommendation, and the auditor denied that request, as designed.
- So 72 authorizations were created, not 75. 24 of the 25 approved policy-DENY base requests got a model DENY; RU094 got ALLOW, so there was nothing to override.

## CPU and memory (figures `reuse_machines_cpu_memory` and `reuse_containers`; tables `reuse-machines.csv` and `reuse-containers.csv`)

| Machine | What runs there | CPU mean / peak (cores, of 3) | Memory peak (of 6 GB) |
|---|---|---|---|
| M1 | Police peer, orderer 1 | 0.11 / 0.29 | 1.31 GB |
| M2 | Forensics and Prosecution peers, orderer 2 | 0.15 / 0.43 | 1.73 GB |
| M3 | Court and Audit peers, orderer 3 | 0.16 / 0.64 | 1.75 GB |
| M4 | Backend, load generator, monitoring | 0.06 / 0.19 | 1.15 GB |
| M5 (Mac) | Model server | 0.21 / 0.39 (the model runs on the GPU, which was busy 95% of the time) | GPU memory 13.7 GB mean, 17.3 GB peak |

- **VMs:** each used at most about a fifth of its 3 cores, at the short spike when a round starts, and less than a third of its 6 GB.
- **Most active containers:** the five peers used about 0.02 cores each, and their CouchDBs about the same. The peers peaked at 225–248 MB of memory.
- **The bottleneck is the model server,** as in E5 and E6.
- **Mac memory:** the model server's process memory (3.05 GB, in the figure) understates its use, because the model's weights sit in GPU memory. Use the GPU memory figure. It was about the same in E6 (12.6 GB mean, 17.4 GB peak), where the process memory happened to show 8.80 GB.

## Files

- `reuse-conditions.csv`: every repeat level 0 to 7, for the three designs.
- `reuse-rounds.csv`: per round.
- `reuse-summary.json`: all checks and numbers.
- `reuse-machines.csv` and `reuse-containers.csv`: CPU and memory per machine and per container.
- Figures:
  - `reuse_scope_by_repeats`: (a) reviews needed, (b) grants outside the approved record.
  - `reuse_requests_by_round`
  - `reuse_time_by_path`: (a) processing time by component, (b) queue wait by round.
  - `reuse_machines_cpu_memory`: CPU and memory of each machine over the 4.2 hours, with round starts dotted.
  - `reuse_containers`: mean CPU and peak memory of every container.
