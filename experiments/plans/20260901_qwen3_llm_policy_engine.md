# Experiment plan — Qwen3-14B as the policy decision engine

Date: 2026-09-01  
Policy: `crime-policy-v1`  
Base paper: Zisad and Hasan, *LLMAC: A Global and Explainable Access Control
Framework with Large Language Model*, arXiv:2602.09392v1.

## Objective

Fine-tune Qwen3-14B so that the model itself maps an authenticated subject,
ledger-derived record context, and a natural-language request to an
`allow`/`deny`/`escalate` decision and fixed policy reason. The runtime grounds
the model-selected reason into a controlled explanation without evaluating the
authorization rules or changing the outcome. The
deterministic JavaScript policy is an offline oracle for dataset construction
and evaluation; it is not the proposed runtime decision maker.

## Claims permitted by this iteration

Only measured results retained by this experiment may support claims about
decision accuracy, reason-code fidelity, false allows, robustness, latency, or
fine-tuning benefit. A successful synthetic experiment will not establish
legal correctness, production security, or suitability for real policing.

## Dataset

- Generate labels by executing the deployed `crime-policy-v1` implementation.
- Cover every reachable terminal reason code, including both allow paths and
  all deny/escalate paths.
- Use disjoint natural-language template families for train, validation, and
  test splits.
- Include conflicting lower-priority conditions so the model must learn rule
  precedence.
- Include held-out prompt-injection wording in the test set. Authenticated and
  ledger attributes remain authoritative over claims in the query.
- Retain the generator seed, policy hashes, split hashes, class balance, and
  generated JSONL files.
- Run a separate audit for identifier uniqueness, split-template attribution,
  oracle fidelity, explanation materialization, and artifact hashes.

## Arms

1. **Prompt-only baseline:** installed Ollama `qwen3:14b`, no policy text.
2. **Prompt-policy baseline:** the same model with the full ordered rules in
   the system prompt.
3. **Proposed:** MLX QLoRA adapter over `mlx-community/Qwen3-14B-4bit`, trained
   on oracle-labelled examples and evaluated without the rule text.

## Ablations

- Remove fine-tuning: proposed versus prompt-only baseline.
- Remove explicit rules: prompt-policy versus prompt-only baseline.
- Remove trusted subject attributes from the tuned input to quantify their
  contribution and expose unsafe reliance on user claims.
- Compare the earlier full-response V2 adapter with compact-classification V3
  as an output-design ablation; retain the negative V2 result rather than
  discarding it.

## Metrics

- JSON parse/schema-valid rate.
- Exact decision accuracy.
- Exact reason-code accuracy and joint decision+reason accuracy.
- Per-decision and per-reason recall.
- Per-class precision/F1 plus decision and reason macro-F1.
- False-allow rate among oracle non-allow cases.
- Exact decisive-attribute-set fidelity.
- Parsed action and purpose accuracy.
- Median and p95 inference latency.
- Validation loss for checkpoint selection, reported separately from held-out
  decision metrics. No test-set checkpoint selection is permitted.

## Reproducibility

- Seed: 42.
- Pin and record the Qwen base revision, MLX conversion, Ollama model digest, package
  versions, hyperparameters, dataset hashes, logs, and adapter checkpoint.
- Store run records under `experiments/runs/`, comparison tables under
  `results/tables/qwen3-policy-engine/`, plots under
  `results/plots/qwen3-policy-engine/`, and the iteration report under
  `reports/iteration/`.

## Stop conditions

- Do not integrate the tuned model as the live authorization path if its
  retained test results show malformed outputs or false allows without making
  that limitation explicit.
- Do not describe Fabric as proving decision correctness. Fabric can preserve
  identity, provenance, endorsement, and decision integrity only.
- Do not describe the grounded explanation text as free-form model reasoning;
  policy faithfulness is measured by the model's exact reason-code accuracy.
