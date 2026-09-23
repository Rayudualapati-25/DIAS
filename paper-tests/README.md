# SEAL paper experiments

Four experiments that measure the frozen SEAL implementation and produce the
evidence for the Results section. They add no functionality: every experiment
either post-processes retained evaluation runs or drives the deployed system
through its own API and modules.

## Research questions

| RQ | Question | Experiment |
|----|----------|------------|
| RQ1 | How accurately does the fine-tuned model perform SEAL authorization, and how much does the authenticated subject context contribute? | 01 |
| RQ2 | Does the deterministic validator stop incorrect model interpretations and policy-inconsistent proposals from becoming automatically enforced decisions, and is the explanation correct for the effective decision? | 02 |
| RQ3 | Can authorization evidence be tampered with undetected, and does the six-organization workflow execute Allow, Deny and Escalate? | 03 |
| RQ4 | What latency and scalability overhead does SEAL add on top of model inference? | 04 |
| RQ5 | Is behaviour deterministic under repetition and safe when a component fails? | 03 (parts E–G) |

## Frozen configuration

Results are only comparable within this configuration. `common.js` verifies it
before every live experiment and refuses to run on a mismatch.

| | |
|---|---|
| Commit / tag | `730d4674…` / `paper-freeze-v1` |
| Organizations | 6 — Police, Forensics, Prosecution, Court, Audit, AIOrg |
| Chaincode | `crimerecords` v4.0, sequence 1 (genesis rebuild) |
| Package hash | `43b9336fbc6691253b698e681bff3cb06820ed70e07197ceb6e4655e5e7f5537` |
| Endorsement | ImplicitMeta MAJORITY, 4 of 6 |
| Model | `qwen3-14b-seba-lora-v6` |
| Adapter SHA-256 | `5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe` |
| Policy | `crime-policy-v2` |

**Changing the model, the policy, the organization set or the endorsement policy
invalidates comparison across experiments and against any previously reported
figure.** Re-run everything after such a change, and say so in the paper.

## Prerequisites

```bash
cp .env.example .env      # required — without it the model is never registered
make down && make all     # clean genesis network, seeded, model registered
make model                # MLX-LM serving Qwen3-14B + the pinned v6 adapter
make ai                   # AIOrg listener
make backend              # API on :3001
```

Preflight fails clearly if `.env` is missing, if the peers disagree on the
chaincode package, if the registered model or policy differs, if a service is
unreachable, or if escalations are already pending.

Warm the model before timing anything: experiment 04 discards its own warm-up
requests, but a cold server distorts the first run of any experiment.

## Running

```bash
node paper-tests/run-all.js          # preflight, then 01 → 04
node paper-tests/run-all.js 01 02    # only the offline experiments
```

Individually:

```bash
node paper-tests/01-model-context.js
node paper-tests/02-safety-xai.js
node paper-tests/03-security-e2e-reliability.js
node paper-tests/04-performance.js
```

Experiments 01 and 02 are offline and take seconds. **03 and 04 drive the live
network and take tens of minutes.** Both leave the ledger as they found it.

Knobs, for shorter rehearsal runs only — final results use the defaults:

```bash
EXP03_PARTS=ABD  EXP03_STRESS_REPS=5  EXP03_STABILITY_RUNS=2  node paper-tests/03-security-e2e-reliability.js
EXP04_REPS=10    EXP04_LEVELS=1,5                              node paper-tests/04-performance.js
```

## Outputs

| Experiment | Files | Paper section |
|---|---|---|
| 01 | `results/01-model-context.{json,csv}` | V-B Authorization effectiveness |
| 02 | `results/02-safety-xai.{json,csv}` | V-C Safety and explainability |
| 03 | `results/03-security-e2e-reliability.{json,csv}`, `results/raw/` | V-D Security and end-to-end validation, V-F Reliability |
| 04 | `results/04-performance.{json,csv}` | V-E Performance and scalability |
| all | `results/00-run-all.json` | — |

Each JSON holds `{ metadata, summary, runs }`: the frozen configuration and
hardware, the calculated summary, and the raw per-case evidence behind it. No
metric is typed by hand; everything is computed from run data.

## Scope limits carried in the result files

These are recorded in the JSON so they travel with the numbers:

- **Experiment 01 reports nothing about the validator.** The retained model runs
  replay a guard derived from the model's own action and purpose, and their
  dataset carries no committed action/purpose, so those columns describe the
  pre-hardening validator. Experiment 02 owns every validator claim.
- The ablation compares **with and without the authenticated subject context**,
  on the same 100 validation cases. Resource context is present in both arms, so
  it is not an ablation of all trusted context.
- False-Allow counts are an **observation on a retained held-out split**, not a
  guarantee about unseen requests.
- The attestation establishes **provenance, integrity and attribution** for the
  information it covers. It does not prove the model executed, nor that its
  output is correct. It does not cover the requester identity; requester binding
  is enforced separately in chaincode.
- Experiment 04 reports `T_model`, `T_end_to_end` and a single `T_remainder`.
  Finer stages are **not** separated, because that needs timestamps inside frozen
  code. Nothing is invented.
- Concurrency figures measure queueing at **one local inference server** plus the
  ledger path. They are not Hyperledger Fabric scalability figures.

## Experimental setup for the paper

`metadata.hardware` in every result file records CPU, core count, RAM, OS
version, Node version and model runtime, alongside the frozen commit, tree hash,
dirty flag, chaincode package hash, adapter hash and policy version. Take the
Experimental Setup paragraph from there rather than from this file, so it
matches the run that produced the numbers.
