# Distinct-user interactive latency evidence

This directory is generated from immutable run artifacts, not manually entered
numbers. The primary run used 100 enrolled synthetic Fabric identities and each
batch at 10, 25, 50, 75, and 100 contained exactly that many distinct users.

## Verified facts

- Provisioning: 100/100 users were enrolled, written to the ledger, and assigned
  to `CASE-2026-001`.
- Primary sweep: 2,340/2,340 requests succeeded across 45 batches.
- Post-hoc release-layout ablation: 780/780 requests succeeded across 15 batches.
- At 100 distinct users, pooled p50/p95 were
  126.26/180.21 ms for search,
  420.37/603.63 ms for submission,
  and 156.37/181.53 ms
  for authorized opening when each user opened a separate one-grant record.
- When all users opened one record containing 100 grants, authorized-open
  p50/p95 rose to 844.38/882.3 ms.

## Interpretation boundary

`AuthorizeRecordRead` iterates decisions under the requested record. The much
higher shared-record result is therefore consistent with grant-set scanning,
not evidence that distinct identities alone caused the increase. The ablation
was added after observing the shared-record curve and the runs were sequential;
it is diagnostic evidence, not a randomized causal comparison.

The reused-identity baseline was run on 2026-08-25. Any comparison with it is
cross-run and descriptive. All measurements are from one local host, one
orderer, and three batches per point; they do not establish capacity, geographic
performance, or confidence intervals.
