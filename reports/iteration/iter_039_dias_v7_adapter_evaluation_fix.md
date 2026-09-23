# Iteration 039: V7 adapter evaluation correction

## What worked

- The original six-suite candidate evaluation and all six prompt-input
  ablations completed, so its raw artifacts were retained.
- Investigation found a reproducible evaluation-path defect: the run descriptor
  recorded `adapterPath: null`, and the decision-balanced predictions matched
  the untuned baseline prediction-for-prediction apart from latency metadata.
- The evaluator now sends the V7 adapter path explicitly in live-path requests
  and direct prompt-ablation requests.
- Syntax checks passed and all eight prompt-ablation unit tests passed.
- A ten-example A/B preflight on the same server confirmed the correction:
  all ten parsed outputs changed when the explicit V7 adapter was supplied.
  The base control produced 9/10 schema-valid outputs and 0.888889 decision
  accuracy; V7 produced 10/10 schema-valid outputs and 0.900000 decision
  accuracy. These ten cases are a wiring check, not a performance conclusion.

## What failed or remains weak

- The artifacts under
  `experiments/runs/20260912_dias_qwen3_lora_v7_r8` are base-model results and
  are invalid as V7 performance evidence. They are retained and marked with
  `INVALID_EVALUATION.md` for traceability.
- The ten-example preflight is too small to assess the candidate or pass the
  predeclared gates.
- The synthetic dataset still awaits human domain review.

## Next experiment

The corrected candidate evaluation is running in
`experiments/runs/20260913_dias_qwen3_lora_v7_r8_corrected`. It must complete
the frozen six-suite harness and prompt ablations before the candidate is
compared with the untuned baseline. Full-dataset training remains withheld
until that comparison is scientifically valid.
