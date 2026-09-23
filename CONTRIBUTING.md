# Contributing

This repository is a research prototype. Contributions must preserve reproducibility, traceability, and honest reporting.

GitHub Actions runs the offline checks below. Live Fabric checks remain local
because they require generated identities, containers, and seeded ledger state.

## Development workflow

1. Read `AGENTS.md`, `README.md`, `docs/architecture.md`, and the relevant `reports/iteration/iter_*.md` file before editing.
2. Keep each change focused. Do not mix paper edits, chaincode behavior, frontend changes, and benchmark changes in one pull request unless they are inseparable.
3. Use deterministic fixtures and seeds where possible.
4. Save new experiment outputs under `experiments/runs/`, derived tables under `results/tables/`, plots under `results/plots/`, and narrative iteration notes under `reports/iteration/`.
5. Do not replace measured results with hand-written numbers.

## Verification commands

Offline checks that should pass without a running Fabric network:

```bash
make repo-check
make check
make install
make test          # chaincode, backend, policies, frontend, dataset
make caliper-install
make caliper-check
```

The Caliper checks require Node.js 22; `make caliper-install` uses the pinned
npm 11.5.1 controller recorded in its package metadata.

Live checks that require Docker/Colima, Fabric samples, the MLX model server,
and a seeded network:

```bash
make all              # network, identities, diaschannel, diasrecords, seed data
make dias-model       # terminal 1
make dias-backend     # terminal 2
make smoke            # live API suite
make dias-acceptance  # full acceptance run, written to a new experiments/runs/ folder
make prove            # permissioned-network checks
```

Never register officers, run `make up`/`make seed`, or run `make down` against a
network whose CA or ledger state belongs to another checkout: those commands
write CA registrations and tear down containers.

## Commit style

Use short conventional commit subjects where practical:

```text
docs(readme): clarify benchmark evidence paths
test(chaincode): cover juvenile access denial
ci: add offline validation workflow
```

## What not to commit

Do not commit generated identities, wallets, local vault content, database files, `.env` files, Fabric crypto material, `node_modules`, or temporary paper build directories.
