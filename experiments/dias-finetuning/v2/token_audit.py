"""Token-length audit for the DIAS v2 dataset, using the exact Qwen3 tokenizer
and the exact chat template mlx-lm applies during training.

max_seq_length must be justified by measurement, not guessed: a value below the
longest example silently truncates the completion, and the model then learns to
emit a JSON object that does not close. Every set is measured, and the report
records how many examples any candidate limit would truncate.

Usage (repository root):
  HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/python experiments/dias-finetuning/v2/token_audit.py \
      experiments/dias-finetuning/data-v2-binary <output.json>
"""
import json
import statistics
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL = "mlx-community/Qwen3-14B-4bit"
REVISION = "a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4"
CANDIDATE_LIMITS = [1024, 1536, 2048, 2560, 3072, 4096]

DATA_DIR = Path(sys.argv[1])
OUTPUT = Path(sys.argv[2])

model_path = Path(snapshot_download(MODEL, local_files_only=True))
from mlx_lm.utils import load_tokenizer
tokenizer = load_tokenizer(model_path)
from mlx_lm.tuner.datasets import ChatDataset


def percentile(values, q):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


SETS = [
    "train", "validation-balanced", "test-decision-balanced", "test-reason-balanced",
    "test-adversarial", "test-ood-paraphrase", "test-multi-rule", "workflow-evaluation",
]

report = {
    "model": MODEL,
    "pinnedRevision": REVISION,
    "modelPath": str(model_path),
    "method": "mlx_lm.tuner.datasets.ChatDataset(mask_prompt=True).process",
    "candidateLimits": CANDIDATE_LIMITS,
    "sets": {},
}
overall_max = 0
for name in SETS:
    path = DATA_DIR / f"{name}.jsonl"
    if not path.exists():
        continue
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    dataset = ChatDataset(rows, tokenizer, chat_key="messages", mask_prompt=True)
    full, completion = [], []
    sample_completion = None
    for row in rows:
        tokens, offset = dataset.process(row)
        full.append(len(tokens))
        completion.append(len(tokens) - offset)
        if sample_completion is None:
            sample_completion = tokenizer.decode(tokens[offset:])
    overall_max = max(overall_max, max(full))
    report["sets"][name] = {
        "examples": len(rows),
        "minTokens": min(full),
        "meanTokens": round(statistics.mean(full), 1),
        "medianTokens": int(statistics.median(full)),
        "p95Tokens": percentile(full, 0.95),
        "p99Tokens": percentile(full, 0.99),
        "maxTokens": max(full),
        "totalTokens": sum(full),
        "completionMeanTokens": round(statistics.mean(completion), 1),
        "completionMaxTokens": max(completion),
        "truncatedAtLimit": {
            str(limit): sum(1 for n in full if n > limit) for limit in CANDIDATE_LIMITS
        },
        "sampleCompletion": sample_completion,
    }

report["overallMaxTokens"] = overall_max
report["recommendedMaxSeqLength"] = next(
    (limit for limit in CANDIDATE_LIMITS if limit >= overall_max), overall_max
)
report["justification"] = (
    f"The longest example across every set is {overall_max} tokens. "
    f"max_seq_length {report['recommendedMaxSeqLength']} is the smallest candidate that "
    "truncates nothing; anything smaller would cut a completion and teach the model to "
    "emit unterminated JSON."
)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "sets"}, indent=2))
for name, stats in report["sets"].items():
    print(f"{name:28} n={stats['examples']:<5} mean={stats['meanTokens']:<8} "
          f"p99={stats['p99Tokens']:<6} max={stats['maxTokens']:<6} "
          f"completion max={stats['completionMaxTokens']}")
