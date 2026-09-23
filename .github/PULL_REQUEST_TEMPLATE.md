## What changed

- 

## Why

- 

## Effect on the paper

- Results, figures or claims that change (or "none"):

## Evidence

- Commands run:
- New or updated artifacts:
- Results/report paths:

## Research integrity checklist

- [ ] No fabricated metrics, citations, dataset properties, or novelty claims.
- [ ] Claims are backed by artifacts in `results/`, `reports/`, or `experiments/runs/`.
- [ ] Baseline/proposed/ablation changes are clearly separated where relevant.
- [ ] Generated secrets, wallets, Fabric crypto material, and local vault data are not committed.
- [ ] Live-network checks were run locally when code touches Fabric/API behavior.

## Local verification

- [ ] `make repo-check`
- [ ] `make check`
- [ ] `make test-chaincode`
- [ ] `cd backend && npm run test:unit`
- [ ] `make caliper-check`
- [ ] `make test` with a seeded Fabric network, if backend live API behavior changed.
