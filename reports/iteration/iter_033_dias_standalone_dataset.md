# Iteration 33 — standalone DIAS project and fine-tuning dataset

Date: 2026-09-11

## Outcome

Created an independent project folder at
`/Users/venkatrayudu/Workspace/XAI workspace/DIAS`. The copy contains the full
DIAS application and retained evidence, local dependencies and runtime state,
the active Qwen adapter, and a fresh MLX environment. Its Git metadata is
independent of the source worktree.

Added `dias-recommendation-dataset-v1`, a deterministic synthetic dataset for
the advisory recommendation model:

| Split | Examples | Allow | Deny | Escalate | Adversarial |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train | 3,000 | 1,000 | 1,000 | 1,000 | 750 |
| Validation | 500 | 166 | 168 | 166 | 125 |
| Test | 1,000 | 100 | 800 | 100 | 250 |

Training and validation are decision-balanced. The test split is balanced over
the ten recommendation reason codes. All splits use distinct usernames, cases,
records, structural fingerprints, and natural-language templates. The data
covers all 22 operational roles and four organizations. A separate workflow
evaluation file contains nine ordered sequences and one-field near misses for
all 21 dynamic-policy fingerprint dimensions; it is not model training data.

## What worked

- The generator is byte-deterministic for a fixed seed.
- Manifest hashes, exact chat schema, full governed fields, split isolation,
  offline label provenance, and workflow coverage validate successfully.
- The active adapter artifact matches the configured SHA-256.
- Chaincode: 211 tests passed.
- Backend: 111 tests passed, including live Fabric/API scenarios.
- Frontend: 12 tests passed.
- Dataset tooling: 2 tests passed.
- Offline DIAS workflow replay: 27 scenarios passed.
- Repository, Compose, shell syntax, and MLX runtime checks passed.

## What failed or is weak

The first full generation attempt exposed duplicate normalized structural
profiles. That invalid intermediate output was regenerated after station and
owner-office groups were made split-isolated; the retained version passes.

The labels remain synthetic and reference-policy-generated. They do not measure
real auditor judgment, deployment prevalence, or the quality/speed of a future
model. No new model result is claimed.

## Next experiment

Select a candidate model, freeze its inference configuration, and evaluate the
untuned model and the retained Qwen adapter on the untouched test split. Only
then fine-tune on the new training split. Compare the tuned candidate against
both baselines and run subject, record, and request-context ablations. Retain
configs, raw predictions, latency samples, and metrics before considering a
runtime model change.
