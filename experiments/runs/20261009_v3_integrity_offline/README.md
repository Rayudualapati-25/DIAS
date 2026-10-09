# 20261009_v3_integrity_offline — integrity microbenchmarks and simulated workflows

- **Kind:** offline microbenchmarks and simulated workflows on the in-process mock Fabric stub. **Not live Fabric results.** No endorsement, ordering, block commit or state database is involved.
- **Plan:** `experiments/plans/20261009_step17_offline_integrity.md`
- **Machine:** cloud Linux container, Intel Xeon 2.10 GHz, Node 22.22.0 (see each `environment.json`). Not the author's Mac; not comparable with testbed timings.
- **Harness:** `experiments/v3/integrity-offline.js`, SHA-256 `9a96728cf2a5cb86b6bdeb0572c3f68054d5631a3b0dc36a62ee92637137c272` (recorded in every `environment.json`; the run was made before the harness was committed, so `v3WorktreeClean` is false).
- **Baseline:** v2 contract at `2336bb4`, extracted read-only with `git archive` into a temporary directory.

## Commands

```bash
for s in 20261009 20261010 20261011; do
  node experiments/v3/integrity-offline.js --seed "$s" \
    --out experiments/runs/20261009_v3_integrity_offline/seed-$s
done
node experiments/v3/integrity-tables.js --run experiments/runs/20261009_v3_integrity_offline \
  --prefix results/tables/20261009_v3_integrity
```

Each seed takes about 9 seconds. `--quick` runs a smaller smoke version.

## Files per seed

| File | Content |
|---|---|
| `config.json` | seed, iterations, repetitions, baseline commit |
| `environment.json` | Node, CPU, commits, harness digest |
| `latency.json` | per-primitive timing (µs) |
| `workflows.json` | per-transaction contract time and write set, v2 and v3 |
| `end-to-end.json` | v3 through the backend runtime with a stand-in model |
| `tamper.json` | detection per mutation class and per check |
| `policy-invalidation.json` | what a policy change refuses, v3 and v2 |
| `run.log`, `stdout.log` | progress lines; stdout also shows the backend's dev-only `JWT_SECRET` warning, which is expected here |

## Tables

`results/tables/20261009_v3_integrity_{latency,workflow_storage,write_set_by_type,tamper_detection,policy_invalidation,end_to_end}.csv`

## Known limits

- The write set counts key and value bytes only. A real Fabric block adds the transaction envelope, endorsements and certificates per transaction; v3 has one more transaction per reviewed request (κ), so the real overhead is larger than counted here.
- Mock execution time excludes cloning the ledger into each transaction context and all network and consensus time.
- The policy scenario uses one requester and 36 scopes on two records.
- Development of the harness found two harness bugs before this run (a reason-code mutation that did not change the value for ALLOW cases, and an NFD mutation that appended text). Both were fixed; the harness now refuses a mutation that does not change the content it claims to change.
