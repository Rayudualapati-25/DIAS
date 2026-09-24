"""Measure DIAS chat-example token lengths exactly as mlx-lm training tokenizes them.

Usage (repository root):
  HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/python <this file> experiments/dias-finetuning/data-v1 <output.json>
"""
import inspect
import json
import statistics
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL = "mlx-community/Qwen3-14B-4bit"
DATA_DIR = Path(sys.argv[1])
OUTPUT = Path(sys.argv[2])

model_path = Path(snapshot_download(MODEL, local_files_only=True))
try:
    from mlx_lm.utils import load_tokenizer
    tokenizer, source = load_tokenizer(model_path), "mlx_lm.utils.load_tokenizer"
except Exception as utils_error:
    from mlx_lm.tokenizer_utils import load
    tokenizer, source = load(model_path), f"mlx_lm.tokenizer_utils.load ({utils_error!r})"

from mlx_lm.tuner.datasets import ChatDataset

def percentile(values, q):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]

report = {"model": MODEL, "modelPath": str(model_path), "tokenizerSource": source,
          "method": "mlx_lm.tuner.datasets.ChatDataset(mask_prompt=True).process", "splits": {}}
for split in ("train", "valid", "test"):
    rows = [json.loads(line) for line in (DATA_DIR / f"{split}.jsonl").read_text().splitlines() if line]
    try:
        dataset = ChatDataset(rows, tokenizer, chat_key="messages", mask_prompt=True)
    except TypeError:
        print("ChatDataset signature:", inspect.signature(ChatDataset.__init__))
        raise
    full, completion, first_completion = [], [], None
    for row in rows:
        tokens, offset = dataset.process(row)
        full.append(len(tokens))
        completion.append(len(tokens) - offset)
        if first_completion is None:
            first_completion = tokenizer.decode(tokens[offset:])
    report["splits"][split] = {
        "examples": len(rows), "minTokens": min(full), "meanTokens": round(statistics.mean(full), 1),
        "p99Tokens": percentile(full, 0.99), "maxTokens": max(full), "totalTokens": sum(full),
        "trainedCompletionTokens": {"min": min(completion), "max": max(completion)},
        "over1536": sum(n > 1536 for n in full), "over2048": sum(n > 2048 for n in full),
        "firstTrainedCompletion": first_completion,
    }
OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
