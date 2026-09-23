"""Load a saved LoRA checkpoint and confirm it produces parseable binary output.

A training run that ends with exit code 0 has proved only that it ran. The
checkpoint is useful only if the weights load and the model still emits the
response contract, so this loads the adapter from disk, asks it real v2 prompts,
and reports what came back. It makes no accuracy claim: three prompts cannot
measure a model.

  .venv-qwen-policy/bin/python experiments/dias-finetuning/v2/eval/checkpoint_inference.py \
      <adapter-path> <prompt-dir> <output.json>
"""
import json
import pathlib
import sys
import time

from mlx_lm import generate, load

ADAPTER = pathlib.Path(sys.argv[1])
PROMPTS = pathlib.Path(sys.argv[2])
OUTPUT = pathlib.Path(sys.argv[3])
MODEL = "mlx-community/Qwen3-14B-4bit"
REQUIRED_KEYS = {"recommendation", "reason_code", "reason",
                 "policy_refs", "missing_evidence", "review_flags"}

started = time.time()
model, tokenizer = load(MODEL, adapter_path=str(ADAPTER))
load_seconds = round(time.time() - started, 1)

results = []
for file in sorted(PROMPTS.glob("prompt_*.json")):
    payload = json.loads(file.read_text())
    text = tokenizer.apply_chat_template(
        payload["messages"], add_generation_prompt=True, tokenize=False,
        enable_thinking=False,
    )
    t0 = time.time()
    raw = generate(model, tokenizer, prompt=text, max_tokens=256, verbose=False)
    elapsed = round(time.time() - t0, 1)

    body = raw.strip()
    if body.startswith("<think>"):
        body = body.split("</think>", 1)[-1].strip()
    if body.startswith("```"):
        body = body.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    parsed, error = None, None
    try:
        parsed = json.loads(body)
    except Exception as exc:  # noqa: BLE001 - the failure text is the finding
        error = f"{type(exc).__name__}: {exc}"

    results.append({
        "prompt": file.name,
        "expectedRecommendation": payload["expected"]["recommendation"],
        "rawLength": len(raw),
        "parsedAsJson": parsed is not None,
        "parseError": error,
        "keysExact": bool(parsed) and set(parsed) == REQUIRED_KEYS,
        "recommendation": (parsed or {}).get("recommendation"),
        "recommendationIsBinary": (parsed or {}).get("recommendation") in ("ALLOW", "DENY"),
        "reasonCode": (parsed or {}).get("reason_code"),
        "generationSeconds": elapsed,
        "rawOutput": raw[:600],
    })

report = {
    "artifactType": "dias-v7-checkpoint-inference-check",
    "adapterPath": str(ADAPTER),
    "baseModel": MODEL,
    "loadSeconds": load_seconds,
    "prompts": len(results),
    "allParsed": all(r["parsedAsJson"] for r in results),
    "allBinary": all(r["recommendationIsBinary"] for r in results),
    "allKeysExact": all(r["keysExact"] for r in results),
    "results": results,
    "claimBoundary": "Checkpoint loads and emits the response contract. "
                     "Three prompts measure nothing about accuracy.",
}
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "results"}, indent=2))
for r in results:
    print(f"  {r['prompt']}: parsed={r['parsedAsJson']} keys_exact={r['keysExact']} "
          f"-> {r['recommendation']} ({r['reasonCode']}) in {r['generationSeconds']}s "
          f"[expected {r['expectedRecommendation']}]")
