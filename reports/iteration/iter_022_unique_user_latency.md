# Iteration 22 — distinct-user interactive latency

Date: 2026-08-28

## Goal

Replace the ambiguous interpretation of “10, 25, 50, 75, and 100 users” with
a live experiment in which every simultaneous request in a batch is signed by
a different enrolled Hyperledger Fabric identity.

## Protocol

The fixed primary sweep used 100 synthetic PoliceMSP inspector identities. At a
level of `N`, the client released `N` HTTP requests together and verified that
the batch contained `N` distinct usernames. The same identity pool was reused
across levels and repetitions. Search, authorized opening, and submission were
each run at 10, 25, 50, 75, and 100 users for three batches, producing 780
requests per operation and 2,340 requests overall.

CA enrollment, on-chain user admission, assignment to `CASE-2026-001`, login,
access-decision creation, and warm-up were excluded from timing. The measured
boundary was client-observed HTTP request start through parsed JSON response.
After-response audit logging remained enabled, as in the prior session-based
run.

Primary run:
`experiments/runs/2026-08-28T04-15-05-267Z_ui_unique_user_latency`

Provisioning run:
`experiments/runs/2026-08-28T04-07-11-290Z_ui_unique_user_provisioning`

Post-hoc release-layout ablation:
`experiments/runs/2026-08-28T04-18-28-093Z_ui_unique_user_release_layout_ablation`

Reused-identity baseline:
`experiments/runs/2026-08-25T14-12-11-482Z_ui_interaction_latency`

## What worked — verified facts

- All 100 synthetic identities had valid enrollment material, an on-chain user
  profile, and an assignment to the target case.
- The primary sweep completed 2,340/2,340 requests with zero failures across 45
  batches. Every batch passed the distinct-username guardrail.
- Every authorized-open response returned the decision identifier created for
  that exact user; no grant-identity mismatch occurred.
- Search p50/p95 changed from 52.36/58.93 ms at 10 users to
  126.26/180.21 ms at 100 users.
- Submission p50/p95 changed from 98.34/107.04 ms at 10 users to
  420.37/603.63 ms at 100 users.
- In the primary shared-record layout, authorized-open p50/p95 changed from
  112.85/126.44 ms at 10 users to 844.38/882.30 ms at 100 users.
- The post-hoc per-user-record ablation completed another 780/780 requests with
  zero failures. Its authorized-open p50/p95 changed from 54.29/59.93 ms at 10
  users to 156.37/181.53 ms at 100 users.
- Raw-sample counts, batch cardinality, identity/record uniqueness, decision-ID
  matches, pooled p50/p95, and artifact hashes were independently checked by
  `experiments/finalize-ui-unique-user-results.py`; `verification.json` reports
  no failures.

## Interpretation

The primary result establishes that the prototype completed the full local
burst workload when concurrency represented distinct Fabric identities rather
than repeated sessions. Submission remained the most expensive primary path at
100 users. Search did not increase monotonically from 75 to 100 users, so the
three-batch evidence does not support a monotonic scaling claim.

The shared-record release curve cannot be attributed to user identity alone.
That setup created 100 identity-bound decisions under one record, and
`AuthorizeRecordRead` iterates the decisions for the requested record until it
finds the caller's identity hash. In the follow-up layout, each user opened a
different record holding only that user's grant; at 100 users this reduced
pooled p50 from 844.38 to 156.37 ms and p95 from 882.30 to 181.53 ms. This is
consistent with grant-set scanning as the main source of the shared-record
increase, but it is not a causal estimate because the follow-up was post-hoc
and sequential.

At 100 clients/users, the earlier five-identity baseline reported search
122.67/157.30 ms, authorized open 154.28/181.26 ms, and submission
396.35/583.30 ms at p50/p95. The corresponding distinct-user, per-user-record
figures were 126.26/180.21, 156.37/181.53, and 420.37/603.63 ms. Their proximity
is useful descriptive evidence that distinct signing identities did not by
themselves produce the large shared-record release curve. Because the baseline
was collected on another date, these differences must not be presented as a
controlled identity effect.

## What failed or remains weak

- The first 100-user provisioning attempt stopped after an idempotency checker
  compared `departmentId` with the wrong local field. The checker was corrected,
  the failed run was retained, and the subsequent 100-user verification passed.
- The release-layout ablation was motivated by the observed shared-record curve
  and therefore was not preregistered before that observation.
- Conditions were sequential rather than randomized or counterbalanced.
- Three batches per point do not establish confidence intervals, a capacity
  threshold, or long-run stability.
- The deployment used one local host, one orderer, one peer per organization,
  fixed synthetic users, and no geographic delay or failure injection.
- The latency boundary includes REST, Fabric Gateway, endorsement/evaluation,
  ordering and commit where applicable, vault I/O, JSON processing, and
  background contention. It is not chaincode execution time.
- All identities are synthetic; the experiment is not a human-user or usability
  study.

## Next experiment

Preregister and randomize repeated blocks across identity reuse, distinct
identities with one grant per record, and distinct identities with increasing
grant-set cardinality. Add stage-level timing inside `AuthorizeRecordRead` and
compare its current scan with a directly keyed `(recordId, identityHash)` grant
lookup. Repeat across multiple hosts with longer soak periods and report
confidence intervals from independently repeated blocks.

## Paper artifacts

- Primary table: `results/tables/ui-unique-user-latency/paper-primary-latency.csv`
- Identity comparison:
  `results/tables/ui-unique-user-latency/identity-mode-comparison.csv`
- Release ablation:
  `results/tables/ui-unique-user-latency/release-layout-comparison.csv`
- Primary figure:
  `results/plots/ui-unique-user-latency/interactive_latency_distinct_users.pdf`
- Ablation figure:
  `results/plots/ui-unique-user-latency/release_layout_ablation.pdf`
- Verification: `results/tables/ui-unique-user-latency/verification.json`

