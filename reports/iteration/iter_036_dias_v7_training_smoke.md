# Iteration 036: DIAS V7 full-length training smoke test

Date: 2026-09-12

## Outcome

The fresh-base Qwen3-14B V7 LoRA smoke test passed all engineering acceptance
checks. It used the real v2 binary training data and the production-length
2,560-token limit. The configuration contains no resume adapter, so no SEAL
LoRA weights were carried into this run.

| Measure | Observed |
| --- | ---: |
| Iterations / optimizer updates | 12 / 3 |
| Initial / final validation loss | 1.272 / 0.826 |
| Final reported training loss | 0.794 |
| Throughput | 0.050--0.055 examples/s |
| Peak memory | 13.000 GB |
| Wall time | 272.677 s |
| Final adapter size | 49 MB |

## What worked

- Base model, full v2 dataset, optimizer, and all 12.845 million trainable LoRA
  parameters loaded successfully.
- Losses stayed finite, three optimizer updates completed, and both the numbered
  and final adapter checkpoints were saved.
- The measured 13.000 GB peak was within the M3 Max's 64 GB unified memory.
- Dataset token evidence gives a maximum of 2,150 tokens, below the configured
  limit of 2,560, so no example is truncated.

## What remains weak

- Two validation batches and twelve iterations are too small for an accuracy or
  convergence conclusion.
- The downward loss movement is encouraging only as an engineering signal; it
  is not held-out ALLOW/DENY evidence.
- The synthetic-data human-review sample is still pending manual review.

## The checkpoint was then loaded and asked real prompts

An exit code of 0 proves only that a run finished. The saved adapter was loaded
from disk and given three real v2 prompts through the same chat template the
service uses:

| | |
| --- | --- |
| Adapter load | 1.9 s |
| Parsed as JSON | 3 / 3 |
| Keys exactly the response contract | 3 / 3 |
| Recommendation in {ALLOW, DENY} | 3 / 3 |
| Correct decisions | 1 / 3 |

The checkpoint loads and still emits the response contract. **One correct
decision out of three is not a result** — three optimizer updates cannot teach a
task, and three prompts cannot measure one. It is recorded because the check was
"does the checkpoint work", and the answer is yes.

Evidence: `experiments/runs/20260912_dias_qwen3_lora_smoke_v7/checkpoint_inference.json`.

## Next refinement, and the constraint that shapes it

Measured throughput projects roughly 26.5–29.2 hours for 5,254 iterations,
before validation and checkpoint overhead — so a one-epoch run over the full
pool is roughly 28–32 hours on this machine. That measurement was taken while
the baseline evaluation shared the GPU, so the uncontended figure will be
better, but not by an order of magnitude.

This is the binding constraint on the whole training phase, and it is met head
on rather than absorbed silently:

- The training count is **chosen from evidence**. Nested, stratified,
  coverage-repaired subsets (400/800/1600/3200) exist, and the candidate run
  uses 1,600 with checkpoints every 200 micro-batches and validation every 100,
  so the validation curve itself shows whether more data was still helping.
- **Checkpoint selection replaces a multi-run sweep** where it can: one run
  yields a checkpoint series, all selected on validation only.
- Whatever is not run is **reported as not run**. No variance figure will be
  quoted for seeds that were never trained.

The cost is inherent to the design, not an accident: the prompt carries the
complete governance policy because the live service sends exactly that prompt,
so training and serving cannot drift. About 90% of every training token is that
constant prefix.

## Evidence

- `experiments/dias-finetuning/train-v7-smoke.yaml`
- `experiments/runs/20260912_dias_qwen3_lora_smoke_v7/run.json`
- `experiments/runs/20260912_dias_qwen3_lora_smoke_v7/training.log`
- `experiments/runs/20260912_dias_qwen3_lora_smoke_v7/metrics.json`
- `results/tables/dias_v7_smoke.csv`
