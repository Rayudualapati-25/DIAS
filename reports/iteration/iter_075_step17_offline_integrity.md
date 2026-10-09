# Iteration 075 — step 17, offline part: integrity cost and behaviour

Date: 2026-10-09. Plan: `experiments/plans/20261009_step17_offline_integrity.md`.
Evidence: `experiments/runs/20261009_v3_integrity_offline/` (three seeds).
Tables: `results/tables/20261009_v3_integrity_*.csv`.
Mac checklist: `experiments/plans/20261009_step17_mac_run_checklist.md`.

**Every number here is a microbenchmark or a simulated workflow on the
in-process mock Fabric stub, on a cloud Linux container. None is a live Fabric,
testbed or model result.**

## What changed

1. New harness `experiments/v3/integrity-offline.js`. It runs the v2 contract
   (baseline commit `2336bb4`, extracted read-only) and the v3 contract on the
   same mock stub, and runs v3 once more through the real backend runtime
   (worker, signer, encrypted store) with a stand-in model on localhost.
2. New table builder `experiments/v3/integrity-tables.js`.
3. Run checklist for the experiments that need the Mac, with expected runtimes
   taken from the September runs.
4. No contract, backend or frontend code changed.

## Results (facts)

### 1. Hashing, signing and encryption cost

Median over three seeds of the per-seed p50, 5,000 timed calls each.

| Operation | Input bytes | p50 (µs) | p95 (µs) |
|---|---|---|---|
| h_J (justification) | 220 | 2.3 | 6.9 |
| h_N (note) | 570 | 2.1 | 4.1 |
| h_C (verified context) | 527 | 13.6 | 24.7 |
| h_M (recommendation object) | 1,385 | 14.5 | 26.6 |
| naive SHA-256 of `JSON.stringify(M)` (ablation) | 1,385 | 4.6 | 8.0 |
| Ed25519 sign κ | 740 | 51.7 | 82.2 |
| Ed25519 verify κ | 740 | 146.8 | 213.1 |
| AES-256-GCM seal review entry | 2,817 | 17.7 | 49.8 |
| AES-256-GCM open review entry | 2,817 | 14.1 | 37.1 |

### 2. Tamper detection

600 trials per mutation class (200 cases × 3 seeds).

- Clean copies: 0 false alarms in 600 cases.
- Justification (h_J) and note (h_N): every one of 8 kinds of change was
  detected in 600/600 trials, including a trailing space, a case change, a
  look-alike letter and Unicode NFC → NFD with the same visible text. A deleted
  object is reported as "missing" in 600/600.
- Recommendation object (h_M): all 15 content changes detected in 600/600.
  Reordering keys (same content) was not flagged (0/600), as intended.
- κ signature: changing any of the 9 signed fields after signing failed
  verification in 600/600. The contract refused 60/60 forged κ submissions per seed.

**Ablation (recommendation object):**

| Check used alone | Content changes caught (of 15 classes) | False alarms on key reordering |
|---|---|---|
| Digest h_M only | 15 | 0% |
| Field binding only (value, status, request id, 6 provenance fields) | 10 | 0% |
| Both (as built) | 15 | 0% |
| Naive non-canonical hash instead of h_M | 15 | 100% |

Field binding alone misses changes to the explanation text, the reason code,
the policy references, an added field and a removed output.

### 3. Policy-update invalidation

36 scopes on two records, one requester; identical on all three seeds.

| After the policy change | v3 refused | v2 baseline |
|---|---|---|
| Reuse of an old authorization | 12/12 (`POLICY_CHANGED`, sent to review) | 12/12 still reused |
| Auditor decision on a pending request with κ | 6/6 (`DIAS_STALE_POLICY`) | no policy input |
| κ commit on a pending request | 6/6 (`DIAS_STALE_POLICY`) | no κ |
| Document release, reviewed grant | 3/3 | not measured |
| Document release, reused grant | 3/3 | not measured |
| Expiry of a pending request (should work) | 0/12 refused | — |
| Reissue under the new policy (should work) | 5/5 issued, generation 2, old one superseded | — |

A control download of each kind succeeded before the change.

### 4. Storage per workflow (on-chain write set, key + value bytes)

| Workflow | v2 tx | v2 bytes | v3 tx | v3 bytes | v3 − v2 |
|---|---|---|---|---|---|
| W1 reviewed, FORCE_ALLOW over DENY (authorization created) | 2 | 14,572 | 3 | 22,742 | +8,170 (+56.1%) |
| W2 reviewed, agreeing DENY | 2 | 10,061 | 3 | 17,359 | +7,298 (+72.5%) |
| W3 reviewed, agreeing ALLOW | 2 | 10,075 | 3 | 17,376 | +7,301 (+72.5%) |
| W4 reuse | 1 | 6,870 | 1 | 7,875 | +1,005 (+14.6%) |

- The κ object itself is 1,237 bytes; its transaction writes 4,793 bytes in
  total, because it also rewrites the request and adds an event.
- Off-chain review entry after a decision: 9,143 bytes encrypted against 7,986
  bytes plaintext (+14.5%), median of seeds.
- Contract execution on the mock stub, whole reviewed workflow, p50:
  v2 0.38–0.55 ms, v3 0.87–1.09 ms.

### 5. End-to-end path through the backend (stand-in model)

| Stage | p50 (ms) |
|---|---|
| Open the review (encrypted write) | 1.0 |
| Ask the stand-in model, sign, commit κ | 5.1 |
| Stage the note before the decision | 1.0 |
| Commit the note after the decision | 1.1 |

The stand-in model answers at once; the real model took a median 8.33 s per
recommendation in E4 (September).

## Interpretation (not measured here)

- The integrity primitives cost microseconds to a fraction of a millisecond.
  On the September testbed one ledger write waited about 2 s for the block
  (p50 2,037 ms per access-log write, `experiments/runs/20261002_v3_access_log_policy/README.md`). The likely live cost of v3 is therefore the extra κ
  transaction, not the hashing. This must be measured on the testbed (X5, X8).
- The write set ignores the envelope, endorsements and certificates that Fabric
  adds to every transaction; the live per-request overhead is larger than the
  table shows.

## Weak points

- Mock stub only; one cloud machine with timer and JIT noise (the h_J p50 ranged
  2.2–4.5 µs between seeds).
- The policy scenario is small and has one requester.
- Synthetic text from a fixed word list.
- Two harness bugs were found and fixed before the recorded run (a no-op
  reason-code mutation for ALLOW cases; an NFD mutation that appended text). The
  harness now refuses a mutation that does not change what it claims to change.

## Not run - needs the author's Mac

X1–X11 in the checklist: model quality (baseline vs proposed, ablations, seeds),
reuse, concurrent users, one-hour stability, faults, ledger growth, and resource
monitoring. Total running time is estimated at about 14–17 hours.

## Next

Step 19 (repository preparation), iteration 076.
