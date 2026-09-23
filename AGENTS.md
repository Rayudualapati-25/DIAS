# Repository Operating Rules

This repository is for an evidence-based AI research pipeline. All work must prioritize reproducibility, traceability, and honest reporting over speed or style.

## Hard Rules

- Do not fabricate results, benchmark numbers, citations, dataset properties, or claims of novelty.
- Do not claim SOTA, breakthrough, or publication readiness unless the repo contains direct evidence in `results/` and `reports/`.
- Do not write paper text from memory when evidence is available. Derive claims from generated artifacts and cite them explicitly.
- Do not skip experiments. Any proposed model must be compared against a baseline.
- Do not skip ablations. Every nontrivial component must be removable and tested in isolation.
- Do not delete intermediate artifacts unless they are clearly disposable cache files.
- Do not overwrite unrelated user changes.

## Required Workflow

1. Read the current repo state before editing.
2. Establish or update the experiment plan.
3. Implement the smallest working version first.
4. Run at least one baseline experiment and one proposed-method experiment.
5. Run ablations on each substantive design choice.
6. Record results in `results/`, `reports/iteration/`, and `experiments/runs/`.
7. Draft paper text only from evidence that exists in the repository.

## Evidence Standard

- Every non-obvious claim must be backed by an artifact: a metric file, plot, table, log, or source note.
- If evidence is weak or missing, say so explicitly.
- Prefer structured summaries, tables, and figures over prose summaries alone.
- Separate facts, interpretation, and recommendation.

## Reproducibility Standard

- Use deterministic seeds where possible.
- Save config files for every run.
- Save logs, metrics, checkpoints, and plots for every meaningful experiment.
- Record environment assumptions and known limitations.
- Keep scripts runnable from a clean checkout.

## Artifact Retention

- Keep `reports/iteration/iter_*.md` current.
- Keep comparison tables in `results/tables/`.
- Keep plots in `results/plots/`.
- Keep run records in `experiments/runs/`.
- Keep paper drafts in `papers/final_paper/`.

## Paper Writing Standard

- Write research paper text only after experiments exist.
- Include limitations and failure modes.
- Reflect the actual results, including negative results.
- Never backfill sections with invented numbers or unsupported conclusions.

## Self-Improvement Loop

After each major step:

1. State what worked.
2. State what failed or is weak.
3. Propose the next experiment or refinement.
4. Update the iteration report.

## If Stuck

- Prefer a simple working implementation over a complex broken one.
- Reduce scope before introducing a new abstraction.
- If a dependency is missing, use a local fallback rather than blocking the pipeline.
