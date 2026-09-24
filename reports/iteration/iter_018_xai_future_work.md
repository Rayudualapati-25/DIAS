# Iteration 018 — Explainable-AI Future Work

## Change

Expanded the Limitations and Conclusion section with implementable XAI work:

1. A policy-trace view for terminal rules, satisfied and failed predicates,
   and attribute-level counterfactuals derived from the structured artifact.
2. Role-specific local-language-model summaries constrained to committed
   fields, with automatic faithfulness checks and deterministic fallback.
3. An explanation-audit dashboard that replays committed decisions, compares
   policy versions, and detects omitted attributes or explanation drift.
4. Human evaluation of comprehension, error detection, task time, and
   calibrated trust.

The paper explicitly retains the on-chain decision as authoritative: none of
the proposed XAI modules may alter the decision outcome.

## Verification

- ACM SIGCONF source compiled successfully.
- Final page count remains six.
- The revised section and references are visually readable and uncropped.
- No undefined citations or references were reported.

## Remaining limitation

These are future implementation proposals, not completed features or measured
results. Their usefulness must be validated through controlled user studies
and fidelity tests before operational claims are made.
