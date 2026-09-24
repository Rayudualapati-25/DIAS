# Iteration 001 — Contextual Fabric vertical slice

Date: 2026-08-11

## Objective

Replace application PostgreSQL/SQLite state and FabCar-domain assumptions with
Fabric-authoritative criminal-justice governance assets, while keeping raw
sensitive content in an agency-controlled vault.

## What worked

- A clean five-organisation network deployed `crimerecords` 2.3 and seeded 14
  X.509 identities, five departments, two cases, one active policy version, and
  three synthetic record commitments.
- Chaincode tests: 92 passing; 94.15% statements and 87.37% branches.
- Live backend tests: 33 passing, including all eight required scenarios.
- Smoke test: 16 passing.
- Permissioned-network proof: 12 passing, 0 failing.
- Role-only ablation: 1/8 expected outcomes on the fixed workload; contextual
  policy: 8/8. This is a functional synthetic scenario check only.
- Forged explanation detection and raw-content/ledger separation checks passed.

## What failed and was corrected

1. The first clean-network login failed because real Fabric X.509 IDs use a
   slash-delimited subject DN. The identity helper now parses both slash- and
   comma-delimited encodings, and the mock uses the real form.
2. The first evidence integration call failed because JavaScript default
   parameters changed `function.length`, which Fabric uses for transaction
   metadata. The chaincode transaction now declares all five parameters and
   applies defaults inside the body.
3. The legacy proof script referenced removed password/PostgreSQL fields and
   old record names. It was migrated and then passed all 12 live checks.
4. A final review found access decisions still used static certificate case
   assignments. Decisions now require a matching ledger UserProfile, apply its
   current suspension state, and derive assignment from the current Case asset.

## Weak or incomplete areas

- The local identity selector is custodial because the backend holds demo keys.
- The filesystem vault is not encrypted and is not a production document store.
- The policy fixtures and records are synthetic and not official Indian policy.
- The network is single-host and its approximately two-second commit latency is
  dominated by the configured orderer batch timeout.
- An ignored legacy `backend/data/offchain.sqlite` artifact remains on disk for
  data retention, but no code or installed dependency opens it.

## Next experiment

Run a multi-seed, repeated workload after defining a published comparison
baseline and pre-registering hypotheses. Add one-ablation-at-a-time runs for
assignment, jurisdiction, protection flags, credential state, and approval.
Do not claim general security, fairness, or operational benefit from the current
eight-scenario functional result.

## Evidence

- `experiments/results/seba_xai_contextual_run_2026-08-11T15-22-52-298Z.json`
- `experiments/results/seba_xai_contextual_run_2026-08-11T15-22-52-298Z.md`
- `results/tables/20260811_policy_scenario_comparison_v2_3.csv`
- `experiments/runs/20260811_contextual_fabric_vertical_slice.json`
