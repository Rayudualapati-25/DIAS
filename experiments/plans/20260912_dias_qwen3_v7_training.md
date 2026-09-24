# DIAS Qwen3-14B V7 training plan

Date: 2026-09-12
Status: smoke test passed; untuned baseline evaluation remains in progress
Dataset: `dias-recommendation-dataset-v2-binary`

## Objective

Train a fresh LoRA adapter from the unmodified `mlx-community/Qwen3-14B-4bit`
base for advisory binary ALLOW/DENY recommendations. Auditor decisions and the
dynamic authorization policy remain outside the model's training labels.

## Evidence sequence

1. Untuned base-model baseline on the fixed held-out suites.
2. Twelve-iteration smoke run using full-length V7 prompts.
3. If smoke checks pass, a checkpointed proposed-model run with validation-led
   early stopping rather than an assumed epoch count.
4. Held-out comparison against the untuned baseline and retained V6.
5. Ablations for request blocks and the substantive dataset design choices.

## Smoke acceptance criteria

- The run loads the v2 dataset and fresh base without a resume adapter.
- No example is truncated at `max_seq_length: 2560`.
- Training and validation losses remain finite.
- At least three optimizer updates complete and an adapter checkpoint is saved.
- Peak memory stays within the 64 GB machine limit.
- The complete log, config hash, dataset hashes, duration, and environment are
  retained under `experiments/runs/20260912_dias_qwen3_lora_smoke_v7/`.

## Limitations

A smoke run is an engineering check, not evidence of model accuracy or
convergence. Accuracy claims require the fixed held-out evaluations after the
full proposed-model run.

## Smoke outcome

The 12-iteration run completed with exit code 0 in 272.677 seconds. Validation
loss was finite and moved from 1.272 to 0.826; the last reported training loss
was 0.794. Peak memory was 13.000 GB, measured iteration throughput was
0.050--0.055 examples/second, and the final 49 MB adapter was saved. These
results satisfy the engineering acceptance criteria but do not establish
held-out ALLOW/DENY accuracy.
