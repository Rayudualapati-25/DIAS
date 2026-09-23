# Unique-user interactive latency experiment

## Research question

How does the prototype behave when each simultaneous request is signed by a
different enrolled Hyperledger Fabric identity, rather than when HTTP client
sessions reuse a pool of five identities?

## Fixed design

- Concurrency levels: 10, 25, 50, 75, and 100 distinct users.
- Repetitions: three batches at every level for each operation.
- Operations: search case records, open one previously authorized record, and
  submit a new synthetic record.
- A level of `N` means `N` requests released together and `N` distinct enrolled
  Fabric users within that batch. The same deterministic pool of 100 synthetic
  users is reused across repetitions and levels.
- Setup excluded from timing: CA registration/enrollment, on-chain user
  creation, case assignment, login, access-decision creation, and warm-up.
- Timing boundary: HTTP request start through receipt and parsing of the JSON
  response at the client.
- Data: generated identifiers and synthetic payloads only; no real case data.

## Hypothesis and comparison

The unique-user run may have higher latency than the existing five-identity
session run because gateways, certificates, profiles, and grants are
identity-specific. The experiment is a characterization, not a hypothesis test,
and no minimum effect or statistical-significance claim is defined. The prior
five-identity run is retained as the identity-reuse baseline/ablation. Because
the two runs occur at different times, their difference is descriptive and must
not be interpreted as a controlled causal estimate.

## Frozen metrics

- Primary: pooled successful-request p50 and p95 latency by operation and level.
- Secondary: mean, minimum, maximum, batch wall-clock time, throughput, and
  between-batch standard deviation of batch p50.
- Correctness guardrail: every response must match the expected record/case and
  every authorized open must contain a Fabric decision identifier and verified
  content hash.
- Identity guardrail: every batch must contain exactly `N` distinct usernames.

## Stopping and failure rules

The run has a fixed sample size of 2,340 measured requests
(`3 operations x 3 repetitions x (10+25+50+75+100)`). It stops early only if a
prerequisite fails, an access setup is not allowed, a batch violates the unique
identity guardrail, or any measured request fails. Failed attempts remain in
the raw artifacts and are not silently retried or removed. No latency result is
reported as a successful full sweep unless all 2,340 requests pass.

## Required artifacts

- Provisioning manifest with the exact 100 synthetic identities.
- Run config, environment snapshot, source hashes, logs, raw samples, batch
  summaries, pooled summaries, integrity manifest, and plots.
- A comparison table that labels the earlier five-identity run as a reused-
  identity/session baseline and this run as the distinct-user condition.
- An iteration report separating facts, interpretation, limitations, and the
  next experiment.
