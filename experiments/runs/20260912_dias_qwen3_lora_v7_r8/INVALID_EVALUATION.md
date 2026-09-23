# Invalid evaluation: adapter was not applied

The evaluation and prompt-ablation artifacts in this run directory must not be
used as V7 candidate results.

The evaluator identified the adapter by name and hash, and the server was
started with `--adapter-path`, but the request payloads did not include the
adapter path. In `mlx_lm.server` 0.31.3, requests naming `default_model` resolve
the base-model alias before the CLI adapter lookup, so the configured adapter
was not selected. The resulting decision-balanced predictions matched the
untuned baseline prediction-for-prediction; only latency metadata differed.

These artifacts are retained as negative evidence and to preserve traceability.
A corrected run must pass the adapter path explicitly in every inference
request and write to a new run directory.
