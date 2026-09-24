# Iteration 001 — standalone LLM policy engine extraction

Date: 2026-09-02

## Facts

- The policy engine, training datasets, adapter checkpoints, retained run
  records, plots, and tables were moved to `LLMxAI`.
- The existing `2511.20284v2.pdf` file was preserved unchanged.
- The selected V4 adapter SHA-256 was independently recomputed as
  `bdb012513c123311821a8f2a7c10c290dd6dfa52dd51632954484aac2efc873b`.
- The relocated V4 dataset audit passed: 6,030 unique examples, no oracle label
  mismatches, no materialization mismatches, no compact-schema mismatches, no
  cross-split template-family matches, and all dataset hashes matched.
- Twelve local Node tests passed, including the three retained evaluator tests.
- Live Qwen smoke cases passed for allow (`POLICY_SATISFIED`), deny
  (`CRED_NOT_ACTIVE`), and escalate (`CROSS_JURISDICTION`).
- Browser QA showed Qwen ready, a validated model result, three working anchor
  targets, no console errors, and no horizontal overflow at 375 pixels.

## What worked

The fine-tuned model continued to make all three decision classes after its
adapter and data were relocated. The runtime binds the query to registered
attributes without invoking the offline oracle. The direct model decision,
reason code, decisive attributes, and counterfactual are visible in one view.

## What failed or is weak

The first post-move dataset audit reported 1,560 explanation-materialization
mismatches. The cause was presentation wording that no longer matched the
retained oracle artifacts. The failed report was retained, the compatibility
wording was restored, and the second audit passed with zero mismatches.

The evidence remains synthetic. The full 360-example run has a 7.33% false
allow rate among expected non-allows, so the system is not ready for autonomous
high-impact enforcement. The profile selector is a demonstration registry, not
production authentication. The MLX development server is not hardened.

## Next refinement

Build an external, human-authored evaluation set with policy paraphrases and
unseen role/resource combinations; add confidence-calibrated abstention; and
compare accuracy, false allows, escalation load, and latency against the
untuned rules-prompt baseline and the current V4 model.
