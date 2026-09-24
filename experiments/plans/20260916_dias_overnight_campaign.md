# DIAS overnight evidence campaign — 2026-09-16

## Objective

Close the feasible evidence gaps identified in the paper review before 08:00 IST
on 2026-09-17.  Every result must be generated from retained artifacts; an
unfinished or infeasible experiment is reported as such rather than backfilled.

## Predeclared questions and acceptance criteria

1. **Fine-tuned end-to-end path.** Can the live five-organisation DIAS backend
   complete the current acceptance matrix while explicitly identifying the V7
   adapter and its SHA-256 digest?
   - Gate: all exercised scenarios and checks pass.
   - Evidence: acceptance JSON, backend/model logs, immutable request IDs.
2. **Latency and concurrent-user throughput.** How do automated request-to-
   recommendation latency and completed recommendations per second change for
   1, 2, 4, 8, and 12 concurrent virtual users?
   - Three repetitions per level after warm-up.
   - Report request-commit latency, recommendation-ready latency, model-inference
     latency, automated auditor-decision commit latency, p50/p95, failures, and
     throughput. Human think time is deliberately excluded and must not be
     described as auditor workload.
   - Each submitted request is finalized so the ledger has no experiment-created
     pending decisions.
3. **Authorization-scope workload sensitivity.** Does exact-record reuse retain
   zero cross-record extensions as repeat rate changes, and what review work does
   that cost relative to no reuse and property-fingerprint reuse?
   - Sweep repeat counts 0, 1, 3, and 7 and sibling counts 0, 1, 2, and 4 under
     fixed seeds.
   - Add a no-reuse arm to the two existing arms.
4. **Unsafe recommendation failure.** What concrete held-out request defeats the
   V7 recommender, and how often do unsafe ALLOWs occur in the retained balanced
   and adversarial sets?
   - Use saved per-example predictions; do not rerun or relabel them.
   - The failure figure must visibly mark the unsafe ALLOW with a red cross and
     the text `MODEL FAILED`.
5. **Audit reconstruction completeness.** Can a deterministic extractor recover
   every field the deployed workflow actually exposes for representative normal,
   override, reuse, revocation/expiry, and no-recommendation paths?
   - This is a machine completeness check, not evidence of human usefulness or
     human reconstruction time.
6. **Seed sensitivity (bounded pilot only).** If wall time permits, train three
   fresh rank-8 LoRA pilots with identical 256-example budgets and seeds 17, 42,
   and 73, then evaluate the same deterministic held-out subset.
   - This is explicitly a small-budget pilot. It cannot substitute for three
     full 5,254-example training runs, which require roughly 26--29 hours each on
     this host.

## Execution order

1. Freeze environment, adapter digest, repository status, and service inventory.
2. Serve the final V7 adapter on port 8081 and the backend on port 3001 using an
   isolated review-store directory.
3. Run fine-tuned acceptance, concurrent-user performance, and audit extraction.
4. Stop only the newly started 8081/3001 processes. Never disturb the existing
   V6 service on port 8080 or the running Fabric network.
5. Run the deterministic scope sweep and generate paper tables.
6. Run the three seed-pilot trainings sequentially to avoid memory contention,
   followed by identical evaluation if all three trainings finish.
7. Generate at least four figures and verify every plotted value against its
   source JSON/CSV.

## Required figures

1. Held-out recommendation quality: untuned versus V7.
2. Exact-scope safety/review trade-off across workload repetition.
3. Current-DIAS latency and throughput versus concurrent users.
4. Explicit V7 unsafe-ALLOW failure with a red crossed failure marker.

The seed-pilot figure is optional and only produced if all three pilot runs and
their evaluations complete. Partial seed results remain in `experiments/runs/`
but are not summarized as a comparison.

## Interpretation boundaries

- A local single-host concurrency curve is a prototype capacity measurement,
  not production scalability evidence.
- Automated auditor decisions measure system commit cost, not human review time.
- Synthetic workload sensitivity does not estimate real traffic prevalence.
- Machine audit-field completeness does not establish explanation usefulness.
- Any false ALLOW means the model itself fails the safety gate; the systems claim
  is limited to the auditor retaining final authority.

## Completion record — 2026-09-17

All bounded experiments above completed before 08:00 IST. The retained
verification is `experiments/runs/20260917_dias_overnight_summary/verification.json`
and the interpretation report is
`reports/iteration/iter_052_dias_overnight_experiments.md`.

The pilot wording above used “256-example budgets” imprecisely. The frozen YAML
configs and run logs show the actual treatment: the same 400-example training
subset and 256 optimization iterations for each seed. This correction describes
the executed configuration without changing it. The pre-run 26--29-hour
full-seed estimate was conservative; the retained completed full V7 run took
18 hours 43 minutes, so three serial full-data seeds would still require about
56 hours before evaluation and could not fit the overnight window.
