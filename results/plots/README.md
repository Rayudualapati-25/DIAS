# Quantitative plot artifacts

Reproduction material for the quantitative figure in
`papers/final_paper/SEBA_XAI_ACM_6page.tex`. All paths in this directory are
repo-relative and resolve from a clean checkout; nothing depends on an absolute
path or a particular machine.

## Figure 3 — observed commit latency against the configured timeout

| Item | Path |
|---|---|
| Reproduction script | `results/plots/figure3_latency_reference.js` |
| Data artifact | `experiments/results/live_fabric_measurements.json` |
| Consumer | `papers/final_paper/SEBA_XAI_ACM_6page.tex` (Figure 3) |

```bash
node results/plots/figure3_latency_reference.js          # values + consistency check
node results/plots/figure3_latency_reference.js --tikz   # emit the TikZ body
```

The script reads every plotted value from the JSON artifact, prints a SHA-256
for both the data file and the manuscript, re-derives the difference
arithmetically, and then confirms the manuscript still contains those exact
values. It exits non-zero if the figure and the artifact disagree, so it is
usable as a pre-submission gate.

### What the figure asserts

| Quantity | Value | JSON field | Kind |
|---|---:|---|---|
| Median end-to-end commit latency | 2072.69 ms | `buildLatency.aggregate.p50Ms` | observed, n = 50 |
| Batching timeout reference | 2000 ms | `environment.ordererBatchTimeoutMs` | configuration constant |
| Difference from reference | 72.69 ms | `buildLatency.marginalP50Ms` | derived by subtraction |

### What it does not assert

The 72.69 ms is the difference between a configuration constant and an observed
total. It is **not** a component timing. The run did not separately instrument
API validation, policy evaluation, explanation construction, endorsement,
validation, or commit, so the difference cannot be attributed among them, and
the figure makes no causal claim that the timeout produced the remainder. It
would bound the non-timeout work only if the timeout elapsed exactly as
configured on every request, which was not verified.

Figure 3 is drawn in TikZ inside the manuscript rather than imported as an
image file, so there is no binary plot artifact to regenerate — the script
regenerates the numbers and the TikZ body instead.

## Related artifacts elsewhere in the repository

- `paper experiment results/` — the concurrency sweep (`latency_summary_aggregated.csv`,
  raw per-request samples, `plot_results.py`) and the ledger-growth series.
  These are **not** plotted in this manuscript.
- `papers/final_paper/artifacts/` — the policy containment checker and its
  recorded output, plus `PROVENANCE.md` mapping every quantitative claim in the
  manuscript to its artifact.

## Caliper methodology figures

Five Caliper configured-input figures are available now under
`results/plots/caliper/`: read, write, increasing load, mixed workload, and
endurance. Each has a 300-DPI PNG for review and a vector PDF for paper layout.
They are generated directly from the five benchmark YAML files with:

```bash
make caliper-profile-graphs
```

The source schedules are retained as CSV files in
`results/tables/caliper_profiles/`. `results/plots/caliper/figure_manifest.json`
records the source and output hashes. These are experimental-design figures;
they do not show achieved throughput, latency, failures, CPU, or memory.

## Caliper measured-result figures

After valid completed runs exist, run `make caliper-plots`. The plotter reads
only retained `caliper-summary.json` files from completed runs and excludes
warm-up rows. At present it exits non-zero because there are no completed
Caliper performance runs; that refusal is intentional and prevents fabricated
paper graphs.
