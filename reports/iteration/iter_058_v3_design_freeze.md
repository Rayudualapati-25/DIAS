# Iteration 058 — v3 design and schema freeze

- **Date:** 2026-10-01
- **Plan step:** 2 of `experiments/plans/20261001_integrity_v3_plan.md`
- **Branch:** `feat/dias-v3-integrity`

## What changed

- `docs/design/dias-v3-ledger-schema.md`: the frozen v3 design. It covers:
  - on-chain and off-chain data, and trust;
  - the hashing rule (domain-separated SHA-256 over canonical JSON or exact UTF-8 text);
  - governed policy activation with a two-person rule;
  - the κ format and its Ed25519 provenance signature;
  - the agreement and authorization rules, and the request lifecycle with expiry and cancellation;
  - release re-checks, visibility, review-store encryption, the off-chain write protocol and logging classes;
  - counterfactuals, handling of older records, and versions.
- `docs/design/dias-v3-requirements-traceability.md`: 44 requirements with stable identifiers, each with its baseline classification and an acceptance criterion.
- `reports/v3_methodology_reconciliation.md`: corrections the written description needs, and decisions left to the author.

## Inputs rechecked

- Paper v13: §IV, Algorithm 1, Tables II and V, §V and §VII.
- The alignment audit against the current code. Its git findings are resolved (the evaluated code is committed and tagged). Its code findings still hold at the tag:
  - no κ, `v_P`, `h_J`, `h_M` or `h_N`;
  - final download without a re-check;
  - unrestricted history and evidence queries;
  - public decision log.
- Two further facts found in the code:
  - the dataset generator imports the live prompt builder, so the v1 prompt must stay unchanged for the historical dataset;
  - the evaluation runner reads the review store files directly, so encryption changes how the testbed observes readiness.

## Decisions beyond the plan's defaults

- **D-01:** identity and record stay outside C; the manuscript wording changes instead.
- **D-02:** policy activation needs a different district head than registration.
- **D-03:** auditors decide and revoke only in their own district and with clearance for the record.

## What is weak

- The backend still holds every user's key. v3 stops it from substituting a recommendation, choosing the agreement or choosing the policy unnoticed. It does not stop it from signing as an auditor.
- Privacy controls are interface-level: every member peer stores every block.

## Next

Step 3: active-credential, district and clearance checks for auditors.
