# GitHub Repository Guide

This guide explains how the project should appear on GitHub and what each directory is for.

## Repository purpose

DIAS is a research prototype for dynamic and explainable access control among
organizations that share records over a permissioned Hyperledger Fabric channel.
An exact-scope dynamic authorization grants a matching request automatically;
otherwise an LLM in the application backend gives an advisory recommendation and
an authorized auditor makes the binding decision. The ledger records the request
and the decision, including whether the auditor agreed with the LLM. The
repository also keeps the synthetic training and evaluation datasets, the
retained experiment evidence, and the earlier SEAL-era work the design replaced.

It is not a production justice-system deployment, a CCTNS/ICJS replacement, or a repository of real criminal-justice data.

## Source directories

| Path | Purpose |
| --- | --- |
| `chaincode/crimerecords/` | Hyperledger Fabric contracts (deployed as `diasrecords`), the DIAS request/decision/authorization modules, retained offline SEAL-era policy modules, and chaincode unit tests. |
| `backend/` | Node.js API, per-user Fabric Gateway access, local identity selection, the backend LLM recommender and off-chain review store, routes, vault adapter, and backend tests (unit and live). |
| `frontend/` | Browser UI served by the backend; no build step. |
| `policies/` | The versioned governance policy bundle, its loader, and the offline reference oracle used only to label and validate datasets. |
| `network/` | Fabric configuration (`configtx.yaml` with the five-organization `DiasChannel` profile), Compose files, and channel/deploy scripts. |
| `scripts/` | Network setup, seeding, live API and acceptance runs, proof, and inspection entry points used by `Makefile`. |
| `benchmarks/caliper/` | Hyperledger Caliper configurations and evidence for the SEAL-era `crimerecords` deployment. |
| `experiments/` | Dataset generators, evaluation scripts, plans, and retained run records. |
| `LLMxAI/` | Model training and evaluation workspace; adapter weights stay out of Git. |
| `results/` | Derived plots and tables produced from retained experiment artifacts. |
| `reports/iteration/` | Iteration notes that record what changed, what worked, and remaining weaknesses. |
| `papers/final_paper/` | Manuscript sources, figures, references, and provenance checks. |
| `output/overleaf/` | Overleaf-ready manuscript packages; build directories, PDFs, and ZIP archives remain ignored. |
| `docs/` | Architecture, walkthrough, evaluation, policy, and GitHub repository documentation. |
| `AGENTS.md` | Operating rules for AI/code agents contributing to the research pipeline. |
| `solidity-frontend/` | Auxiliary standalone EVM companion prototype with its own README and retained evidence. |

## Evidence policy

Keep evidence in the repository when it is needed to support the paper or benchmark claims. Do not edit measured JSON, logs, summaries, tables, or plots by hand to improve a result. A failed run is kept next to the run that replaced it, with a note saying what went wrong.

Some retained run snapshots contain the original machine's absolute paths to
generated identities. Those path strings are provenance, not private-key
bytes, and are intentionally left unchanged. Current runtime connection files
and all referenced MSP/key material remain ignored.

Use this mapping when adding new results:

| Artifact type | Path |
| --- | --- |
| Raw run records | `experiments/runs/<timestamp>_<name>/` |
| Compact metric summaries | `experiments/results/` |
| Tables for papers/reports | `results/tables/` |
| Plots for papers/reports | `results/plots/` |
| Iteration narrative | `reports/iteration/iter_*.md` |
| Paper provenance | `papers/final_paper/artifacts/` |

## CI policy

The GitHub Actions workflow intentionally runs only checks that do not require
a live Fabric network:

- publication-boundary, Compose, JavaScript, Python, and shell checks;
- chaincode unit tests and their coverage thresholds;
- backend unit and security tests;
- policy package, frontend, and dataset/evaluation tests;
- Caliper configuration, helper, script, and plot-axis validation;
- backend and chaincode production dependency audits.

The live API suite and the acceptance run need Fabric, the model server, and the
backend. Run them locally:

```bash
make all
make dias-model       # terminal 1
make dias-backend     # terminal 2
make smoke
make dias-acceptance
```

## Publication checklist

Before publishing on GitHub:

1. Confirm no generated secrets or identities are staged (`make repo-check`).
2. Confirm `node_modules`, local databases, Fabric MSP material, the off-chain review store, adapter weights, generated Caliper connection files, and scratch paper builds are ignored.
3. Run the local verification commands from `CONTRIBUTING.md`.
4. If behavior changed, run the live checks above and keep the new acceptance run folder.
5. Confirm the top-level `LICENSE` and `CITATION.cff` files are present and match the package metadata.
6. Check that third-party material you commit (for example, papers under `reports/research/`) may be redistributed.
