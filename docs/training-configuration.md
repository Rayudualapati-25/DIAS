# DIAS V7 training configuration

Every setting in
[`experiments/dias-finetuning/train-v7.yaml`](../experiments/dias-finetuning/train-v7.yaml),
what it actually means in MLX-LM, and why this value.

## The two settings that are easy to misread

| Setting | What it is **not** | What it **is** |
| --- | --- | --- |
| `iters` | not epochs, not optimizer updates | **micro-batches**. With `batch_size: 1` and `grad_accumulation_steps: 4`, `iters: N` means N examples seen and N/4 optimizer updates. `iters: 5254` is exactly one pass over the full training pool. |
| `max_seq_length` | not a validation limit | a **truncation** point. An example longer than this is silently cut. |

Getting either wrong does not produce an error — it produces a run that means
something other than what the config appears to say.

## Settings

| Setting | Value | Why |
| --- | --- | --- |
| `model` | `mlx-community/Qwen3-14B-4bit` | The base every DIAS evaluation is anchored to, pinned at revision `a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4`. |
| *(absent)* `resume_adapter_file` | — | **Deliberately absent.** V7 starts from the untouched base. Resuming from a SEAL-era adapter would make every "fresh model" claim false, so `scripts/dias/train-v7.sh` refuses to start if this key appears. |
| `fine_tune_type` | `lora` | Full fine-tuning of a 14B model does not fit this machine, and LoRA keeps the base recoverable: the adapter is 49 MB and the base is never modified. |
| `seed` | `42` | Fixed so a rerun reproduces. Recorded in the run record. |
| `data` | a directory | MLX-LM expects `train.jsonl` and `valid.jsonl` inside it. Subset runs point at a staged directory under `data-v2-binary/subsets/`. |
| `num_layers` | `16` | LoRA applied to the last 16 of 40 layers — 12.8M trainable parameters, 0.087% of the model. Matches the retained V4–V6 runs so the comparison is not confounded by adapter capacity. |
| `batch_size` | `1` | At 2,560 sequence length, peak memory is 13.0 GB at batch 1. Larger batches contend with the two model servers that share this machine. |
| `grad_accumulation_steps` | `4` | Restores an effective batch of 4 without the memory of one. |
| `learning_rate` | `1e-5` | The V4–V6 value. `5e-6` is the alternative in the bounded search; both are evaluated on validation only. |
| `iters` | `5254` | One pass over the full pool, i.e. 1,313 optimizer updates. Overridden for subset runs. |
| `val_batches` | `100` | 100 validation examples per evaluation — enough to separate checkpoints without spending a large fraction of the run on evaluation. |
| `steps_per_eval` | `250` | Checkpoint selection needs enough points on the validation curve to see a turn. |
| `save_every` | `500` | Checkpoints at fixed intervals so selection has candidates and a crash loses at most 500 micro-batches. |
| `max_seq_length` | `2560` | The longest example across every v2 set is **2,150 tokens**, measured with the exact Qwen3 tokenizer and the chat template MLX-LM applies. 2,560 is the smallest candidate that truncates nothing. |
| `mask_prompt` | `true` | Loss on the completion only. Without it the model is trained to reproduce the policy bundle, which is ~90% of every prompt and none of the task. |
| `grad_checkpoint` | `true` | Trades compute for memory; required at this sequence length. |
| `lora_parameters.rank` | `8` | V4–V6 value; `16` is the alternative in the bounded search. |
| `lora_parameters.dropout` | `0.05` | Small regularisation on a synthetic dataset where near-duplicates are possible by construction. |
| `lora_parameters.scale` | `20.0` | V4–V6 value, unchanged so the adapter's effective magnitude is comparable. |

## What one pass costs

| | |
| --- | --- |
| Training examples (full pool) | 5,254 |
| Mean tokens per example | 2,015 |
| Tokens per pass | **10,586,206** |
| Optimizer updates per pass | 1,313 |
| Peak memory (measured) | 13.0 GB |

Sequences are long because **the prompt contains the complete governance policy
bundle** — the same prompt the live service sends. That is the point: training
and serving share one prompt implementation, so they cannot drift. The cost is
that roughly 90% of every training token is a constant prefix, and one pass is
about nine times the token volume of a v1 pass.

## Why the training count is chosen, not assumed

`experiments/dias-finetuning/v2/make-training-subset.js` builds nested,
stratified subsets (400 / 800 / 1600 / 3200) from the training pool. Each is
proportionally allocated over scenario × label × justification-kind strata, then
coverage-repaired so every reason code and every scenario survives — a subset
that quietly loses `SEALED_RECORD` is a different task, not a smaller one.

They are **nested**: the 400 is contained in the 800, which is contained in the
1600. A learning curve over nested subsets measures the effect of *adding* data;
over independent samples it would confound size with sampling.

Selecting the count by curve rather than by "use everything" is the difference
between evidence and assumption, and it is also what makes the comparison
affordable on one machine.

## Selection rules

- Checkpoints and hyperparameters are selected on **validation only**.
- The test sets are read once, after selection, for the reported numbers.
- The bounded search varies LoRA rank (8, 16) and learning rate (5e-6, 1e-5),
  screened on a small pilot before any full-length run.
- One seed during development. At least three seeds for the final configuration
  **if computationally feasible** — and if not, that is reported as a limitation
  rather than papered over with a variance figure that was never measured.

## Safety rails in the runner

`scripts/dias/train-v7.sh` refuses to start unless:

1. the V6 adapter still hashes to `5f5fba8e…` — checked before the run, and
   again afterwards, because a training run has no business writing there;
2. the config contains no `resume_adapter_file`;
3. `adapter_path` is neither a SEAL/V6 directory nor one that already holds
   weights, so an existing adapter cannot be silently overwritten;
4. at least 20 GB of disk is free.

It writes `run.json` with the config hash, start and finish times, exit code,
the final adapter digest, and whether V6 survived.
