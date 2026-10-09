# 20261009_step16_offline — required-test matrix evidence

- **Kind:** offline unit and contract tests (mock Fabric stub). Not a live Fabric run.
- **Plan:** `experiments/plans/20261009_step16_offline_verification.md`
- **Environment:** Linux cloud container, Node 22.22.0, `npm ci` in `chaincode/crimerecords` then `backend`.
- **Command:** `make test`

## Files

| File | What it is |
|---|---|
| `regression-tests.log` | Full `make test` output after the new test was added |
| `chaincode-test-titles.txt` | Every chaincode test title (`mocha --dry-run`), 342 |
| `backend-test-titles.txt` | Every backend unit test title (`mocha --dry-run`), 313 |

## Result

- chaincode 342 (341 + 1 new), backend 313, policies 27, frontend 77, dataset 104; no failures.
- Mutation check on the new test: changing the expected note text made it fail (1 failing); restored.
- Matrix: `results/tables/20261009_step16_required_tests.csv`.
