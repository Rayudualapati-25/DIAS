# Step 17 — run checklist for the experiments that need the author's Mac

- **Date:** 2026-10-09. **Status:** prepared, NOT RUN.
- **Why not run here:** each item needs the Fabric testbed (four Lima VMs), the MLX model server, or both. None of these exist in the cloud container.
- **Parent plan:** `experiments/plans/20261001_integrity_v3_plan.md`, step 17. Testbed setup: `testbed/README.md`.
- **Expected runtimes** come from the September runs on the same Mac and testbed (sources in the last column). They are estimates for v3: v3 adds one ledger transaction (κ) per reviewed request, so workflow times may grow. A time marked *estimate* has no earlier measurement.

## Decisions the author must take first

1. **Model for the reruns:** V7 adapter or the untuned Qwen3-14B. This changes every model-dependent item below. Not decided here.
2. **Seeds:** whether "multiple seeds" means re-evaluating the three retained pilot adapters (17, 42, 73) or training new ones. Training is stopped by the plan; new training is a research decision.
3. **Maximum authorization lifetime** (traceability A06): affects the reuse experiment only if a maximum is introduced.

## Before any experiment (gate)

| # | Step | Command / source | Expected time | Source of the estimate |
|---|---|---|---|---|
| G1 | Build the four VMs, channel, chaincode `diasrecords` 3.0 at sequence 1 on a fresh research network | `testbed/README.md` "Build (in order)" | about 1–2 h, mostly manual | estimate |
| G2 | Keys: existing signer key and review-store key in `~/dias-testbed` (never replace them) | `testbed/README.md` "Step 15 setup" | minutes | — |
| G3 | Seed ledger, register and activate the policy with two Audit heads, register the signer | `testbed/seed/seed-ledger.js` | minutes | — |
| G4 | Model server on the Mac with the chosen model; smoke run with the expected adapter digest | `testbed/load/smoke.js --expected-adapter-hash` | < 5 min | — |
| G5 | Full acceptance R1–R14 and the 11 step-16 checks live | step-16 matrix: `results/tables/20261009_step16_required_tests.csv` | about 30 min | estimate |
| G6 | Close auditor screens and stop unrelated load (screen reads are logged on the ledger) | — | — | iteration 068, "An open auditor screen adds logged reads" |

Stop if any gate fails. Do not start an experiment on a degraded network.

## Experiments

| # | Experiment | Command | Expected time | Source of the estimate |
|---|---|---|---|---|
| X1 | Baseline vs proposed recommendation quality (prompt v2), 600 test cases per model | `node experiments/dias-finetuning/v2/eval/evaluate.js --prompt v2 --label <model> --url http://127.0.0.1:8081/v1 --out experiments/runs/<date>_<model>_prompt_v2` | about 83 min per model; about 2 h 50 min for both | V7: E4, 600 cases in 4,950 s (`20260924_testbed_multivm/raw/e4-llm-alone/metrics.json`); untuned: *estimate*, same order |
| X2 | Input ablations (full + 5 removals), 120 cases each, per model | `node experiments/dias-finetuning/v2/eval/run-ablations.js --label <model> --url ... --limit 120 --out experiments/runs/<date>_dias_ablations` | about 1 h 40 min per model (720 calls × about 8.3 s) | per-call time from E4 |
| X3 | Multiple seeds (if the author chooses the retained pilot adapters) | `evaluate.js` once per adapter | about 16 min per adapter, about 48 min for three | seed pilot `durationSeconds` 920–984 (`20260916_dias_seed_pilot/seed-*/evaluation/metrics.json`) |
| X4 | Exact-scope reuse, 100 users, 2,400 workflows | `bash testbed/scripts/start_reuse.sh` (smoke first: `--smoke`) | about 4 h 15 min | `20260925_reuse_100_users`: "2400/2400 completed ... in 252.2 min" |
| X5 | Concurrent users E5: 10/25/50/75/100 users, 3 repetitions | `testbed/load/run-burst.js` | about 1 h 45 min | E5 requests span 104.5 min |
| X6 | One-hour stability E6: 100 users, 6 arrivals/min | `bash testbed/scripts/start_e6.sh` | about 1 h 5 min | E6 span 60.4 min + settle |
| X7 | Orderer and peer faults E7 | inside `RUNDIR=... bash testbed/scripts/run_remaining.sh` | about 12–13 min | E7 span 12.4 min |
| X8 | Ledger alone E3 (W1 request, W2 decision, plus the new κ transaction) | inside `run_remaining.sh` | about 25 min | E3 span 24.0 min |
| X9 | Ledger growth probes after E5, E6, E7, E3 | `testbed/load/probe-reads.js` (called by `run_remaining.sh`) | a few minutes each | — |
| X10 | CPU, RAM and GPU monitoring | Prometheus on M4 + `testbed/monitor/mac_sampler.py`, running during X4–X8 | no extra time | E5/E6 per-container table |
| X11 | Finalize: manifest with observed definition and model evidence | `CHAINCODE_DEFINITION=... MODEL_EVIDENCE=... BASELINE_RUN=... PROPOSED_RUN=... RUNDIR=... bash testbed/scripts/finalize.sh` | minutes | — |

## Rough total

- Model-only work (X1–X3): about 5–8 h depending on the model choice and seeds.
- Testbed work (X4–X9): about 8 h 30 min of running time, plus gates.
- Run the model-only items when the testbed is idle: one model server serves one request at a time, and the E5 report shows the model sets the throughput.

## What to keep for each run

- Config, logs, raw traces and metrics under `experiments/runs/<date>_<name>/`; tables in `results/tables/`; plots in `results/plots/`.
- The observed chaincode definition (`querycommitted --output json`) and the served model and adapter digest.
- Do not edit or replace the September runs; they describe the v2 system.

## Offline counterparts already measured

`reports/iteration/iter_075_step17_offline_integrity.md`: hashing and signing cost, tamper detection, policy invalidation, and storage per workflow on the mock stub.
