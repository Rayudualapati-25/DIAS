# Iteration 040: corrected V7 candidate evaluation

**Date:** 2026-09-13  
**Candidate:** fresh Qwen3-14B-4bit LoRA trained for 1,600 examples / micro-batches  
**Adapter SHA-256:** `2a159c9c13be4607852575230349081a8b7ad80b7a1e53da3a063dc2297d0aa6`  
**Evaluation artifact:** `experiments/runs/20260913_dias_qwen3_lora_v7_r8_corrected/metrics.json`  
**Ablation artifact:** `experiments/runs/20260913_dias_qwen3_lora_v7_r8_corrected/ablations/metrics.json`

## Facts

The corrected evaluator explicitly supplied the V7 adapter on every request.
All six frozen suites completed: 2,699 outputs were produced and all 2,699
passed the response schema. The earlier run in
`experiments/runs/20260912_dias_qwen3_lora_v7_r8` remains marked invalid and is
not used as V7 evidence.

| Set | n | Valid | Accuracy | Balanced acc. | Macro-F1 | False ALLOW | False DENY | Reason-code acc. |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Decision-balanced | 600 | 1.000 | 0.880 | 0.880 | 0.879 | 61 (20.3%) | 11 (3.7%) | 0.828 |
| Adversarial | 389 | 1.000 | 0.841 | 0.846 | 0.840 | 54 (26.5%) | 8 (4.3%) | 0.825 |
| OOD paraphrase | 400 | 1.000 | 0.840 | 0.840 | 0.837 | 60 (30.0%) | 4 (2.0%) | 0.810 |
| Multi-rule | 370 | 1.000 | 0.992 | — | — | 3 (0.8%) | 0 | 0.784 |
| Validation-balanced | 400 | 1.000 | 0.898 | 0.898 | 0.897 | 31 (15.5%) | 10 (5.0%) | 0.818 |
| Reason-balanced | 540 | 1.000 | 0.822 | 0.878 | 0.716 | 93 (19.4%) | 3 (5.0%) | 0.709 |

Percentages in the false-ALLOW and false-DENY columns use their relevant true
class as denominator. Multi-rule is a one-class set, so balanced accuracy and
macro-F1 are undefined rather than zero.

## Predeclared gate decision

| Gate | Result | Evidence |
| --- | --- | --- |
| Decision accuracy beats base | PASS | 0.880 vs 0.606 |
| Macro-F1 beats base | PASS | 0.879 vs 0.550 |
| False-ALLOW rate does not worsen | **FAIL** | 20.3% vs 5.0% |
| Schema-valid JSON at least 0.98 | PASS | 1.000 |
| No unexplained adversarial false ALLOW | **FAIL** | 54 false ALLOWs among 204 DENY cases |
| OOD accuracy within 0.10 of in-domain | PASS | absolute gap 0.040 |
| Local p95 latency in same order as base | PASS | 8.29 s vs 9.49 s on the decision set |

The candidate is therefore **not eligible for activation**. This is an
engineering gate decision, not a claim that the offline full-data experiment
must be abandoned.

## Prompt ablations

All six 200-example variants completed. Removing requester attributes reduced
accuracy from 0.880 to 0.550; removing record attributes reduced it to 0.515.
Removing the policy made every output schema-invalid. These results confirm that
requester, record, and policy inputs are substantive components.

Removing action/purpose caused a smaller decline to 0.850. Removing the
justification instruction improved accuracy to 0.935 and reduced false ALLOWs
from 23 to 9 in this fixed 200-example slice. This is evidence for a separate
prompt-design experiment; it is not sufficient to modify the already-frozen V7
full-data run or claim that explanations are harmful in general.

## Interpretation

The 1,600-example candidate solved the untuned model's near-always-DENY bias:
false DENY fell from 74.5% to 3.7% on the decision-balanced set. It overcorrected
in the opposite direction, increasing false ALLOW from 5.0% to 20.3%. The
decision improvement is real, but the current safety profile is unacceptable
for activation even though the DIAS auditor remains the final authority.

Training loss and validation loss remained finite; final training loss was
0.011 and validation loss was 0.010 at iteration 1,600. Those losses do not
substitute for the held-out gate results above.

## Next experiment

Run the predeclared one-pass, 5,254-example fresh LoRA as an offline experiment
using the unchanged dataset, prompt, seed, and base model. This measures whether
greater coverage corrects the subset candidate's ALLOW bias. It must remain
undeployed. After training, checkpoint selection uses validation only, followed
by one frozen held-out evaluation. If the full-data model still fails the
false-ALLOW gates, the next separately configured experiment should use
hard-negative enrichment or cost-sensitive sampling and re-establish a fresh
baseline comparison.

## Limitations

- The policy and all examples are synthetic and have not received human domain review.
- One seed and one decoding configuration were evaluated.
- The six suites are overlapping views, not 2,699 independent cases.
- The 200-example ablation slice is diagnostic and is not a replacement for the frozen held-out suites.
