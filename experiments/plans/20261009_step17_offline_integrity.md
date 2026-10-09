# Step 17 (offline part) — integrity cost and behaviour

- **Date:** 2026-10-09
- **Parent plan:** `experiments/plans/20261001_integrity_v3_plan.md`, step 17 (offline list) and traceability A14.
- **Where:** cloud container. No Fabric network, no model server, no testbed VMs.
- **Labelling rule:** every result is a microbenchmark or a simulated workflow on the in-process mock Fabric stub (`chaincode/crimerecords/test/testHelpers.js`). None is a live Fabric result.

## Questions

1. **Commitment and hashing latency.** What do h_J, h_C, h_M, h_N, the κ signature and review-store encryption cost per call?
2. **Tamper detection.** Which changes to the justification, the recommendation object M, the auditor note and κ are detected, and by which check?
3. **Policy-update invalidation.** After a policy change, which old authorizations, pending decisions, κ commits and document releases are refused?
4. **Storage overhead per record.** How many bytes does one workflow write on-chain in v3 compared with v2, and off-chain encrypted compared with plaintext?

## Baseline and proposed

- **Baseline:** the evaluated v2 contract at commit `2336bb4` (tag `eval-baseline-2026-10-01`), extracted read-only with `git archive` and run on the same mock stub.
- **Proposed:** the v3 contract and backend at the branch head.

## Ablations

- **Digest only vs field binding only** for M (which check catches which change).
- **Canonical vs naive hashing** (`SHA-256(JSON.stringify(M))`): false alarms on key reordering, and cost.
- **Signature** over κ: each signed field changed after signing.

## Method

- One harness: `experiments/v3/integrity-offline.js`; tables: `experiments/v3/integrity-tables.js`.
- Seeds 20261009, 20261010, 20261011. 5,000 timed iterations after 500 warm-up per primitive; 200 repetitions per workflow; 200 tamper cases per seed.
- The Ed25519 keys are derived from the seed, so signatures repeat. AES-GCM IVs are random, so ciphertext differs but its size does not.
- Synthetic text only (fixed word list). No real names or case data.
- Workflows W1–W4: reviewed with an authorization, two agreeing reviews, and reuse.
- The end-to-end path runs the real backend runtime (worker, signer, encrypted store) against a stand-in model on localhost and the v3 contracts on the mock stub.

## Out of scope here (needs the author's Mac)

See `experiments/plans/20261009_step17_mac_run_checklist.md`.
