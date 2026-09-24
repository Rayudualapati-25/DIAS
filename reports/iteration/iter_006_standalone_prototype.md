# Iteration 006: Standalone Functional Prototype

## Objective

Create a new, copy-only folder containing the smallest practical runnable
version of the crime-records prototype. Preserve the deterministic contextual
policy and browser workflows while removing the local Fabric network,
certificates, generated databases, installed dependencies, reports, and paper
artifacts from the new folder.

## Facts

- The original repository occupied approximately 108 MB during inspection.
- The new `standalone-prototype/` folder occupies 256 KB on disk and contains
  39 files.
- It has no third-party runtime dependencies; Node.js 18+ is sufficient.
- The browser code, `policyEngine.js`, and `policyV1.js` were copied. The new
  server, deterministic seed, tests, and standalone documentation exist only in
  the new folder.
- No original application file was deleted or overwritten by this iteration.

## What worked

- The original chaincode/policy baseline completed with 92 passing and 0
  failing unit tests.
- The standalone suite completed with 10 passing and 0 failing end-to-end
  tests.
- All 26 copied frontend JavaScript modules passed syntax checks.
- The standalone server and copied policy files passed Node.js syntax checks.
- The documented `npm start` command launched successfully, and
  `/api/health` returned `standalone-simulation` with policy version
  `crime-policy-v1`.
- Verified flows include health/static serving, login, record search, ALLOW,
  DENY, ESCALATE, approval, identity-bound payload release, explanation
  verification, case and record creation, evidence detail/custody, user status
  history, sealing, payload hashing, and audit-chain verification.
- The assignment ablation changed the same request from `DENY / NOT_ASSIGNED`
  to `ALLOW / POLICY_SATISFIED` after assignment was added.

## What failed or is weak

- The first end-to-end run had 5 passing and 1 failing test because the static
  page assertion still expected the original HTML title. The assertion was
  corrected to the standalone title; the next full run passed all 6 tests, and
  the expanded final run passed all 10 tests.
- The standalone HMAC tokens, JSON state, transaction identifiers, private
  evidence behavior, and audit hash chain are simulations. They do not prove
  Fabric endorsement, X.509 possession, ordering, block immutability, private
  data collection behavior, or distributed persistence.
- No live Fabric-network experiment was rerun because the requested deliverable
  is the lightweight standalone copy.

## Interpretation

The new folder is suitable for a fast functional demonstration and frontend or
policy prototyping. It is not a substitute when the research question depends
on blockchain trust properties. The interface and README explicitly state that
boundary.

## Reproduction

```bash
cd standalone-prototype
npm start
# open http://localhost:3001

npm test
```

Structured evidence is stored in:

- `experiments/runs/20260817_standalone_prototype.json`
- `results/tables/20260817_standalone_prototype_validation.csv`

## Next refinement

If a distributable archive is required, create it from `standalone-prototype/`
after one manual browser walkthrough on the target machine. Keep the original
Fabric project beside it for demonstrations that require ledger evidence.
