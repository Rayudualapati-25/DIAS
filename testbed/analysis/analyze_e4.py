#!/usr/bin/env python3
"""E4 analysis: the LLM component alone (one model server, one request at a time).

Reads the evaluation run the testbed's model server produced on the 600
balanced test cases and reports its capacity (recommendations per minute), its
time per recommendation, token counts, and whether it reproduces the stored V7
evaluation decision for decision.

Usage: python3 analyze_e4.py --run <experiments/runs/...e4...> --out <dir>
"""

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REFERENCE = os.path.join(REPO, "experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval/predictions/test-decision-balanced.jsonl")


def load(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def pct(values, p):
    ordered = sorted(values)
    return ordered[max(1, math.ceil(p * len(ordered))) - 1] if ordered else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    rows = load(os.path.join(args.run, "predictions", "test-decision-balanced.jsonl"))
    with open(os.path.join(args.run, "metrics.json")) as handle:
        metrics = json.load(handle)
    reference = {r["exampleId"]: r for r in load(REFERENCE)}
    latency = [r["latencyMs"] / 1000 for r in rows if r.get("latencyMs") is not None]
    completion = [r["completionTokens"] for r in rows if r.get("completionTokens")]
    prompt = [r["promptTokens"] for r in rows if r.get("promptTokens")]
    same_decision = sum(1 for r in rows if r.get("predicted") and reference.get(r["exampleId"], {}).get("predicted")
                        and r["predicted"]["recommendation"] == reference[r["exampleId"]]["predicted"]["recommendation"])
    same_output = sum(1 for r in rows if r.get("predicted") and reference.get(r["exampleId"], {}).get("predicted")
                      and r["predicted"] == reference[r["exampleId"]]["predicted"])
    correct = sum(1 for r in rows if r.get("status") == "OK" and r.get("predicted")
                  and r["predicted"]["recommendation"] == r["expected"]["recommendation"])
    wall_s = metrics.get("durationSeconds") or sum(latency)
    ref_latency = [r["latencyMs"] / 1000 for r in reference.values() if r.get("latencyMs") is not None]
    summary = {
        "cases": len(rows),
        "usable": sum(1 for r in rows if r.get("status") == "OK"),
        "correct": correct,
        "same_decision_as_stored_v7_run": same_decision,
        "identical_output_to_stored_v7_run": same_output,
        "time_per_recommendation_s": {"mean": sum(latency) / len(latency), "p50": pct(latency, 0.5),
                                      "p95": pct(latency, 0.95), "max": max(latency)},
        "stored_v7_run_time_per_recommendation_s": {"mean": sum(ref_latency) / len(ref_latency), "p50": pct(ref_latency, 0.5),
                                                    "p95": pct(ref_latency, 0.95)},
        "wall_clock_s": wall_s,
        "recommendations_per_min": len(rows) / (wall_s / 60),
        "prompt_tokens_mean": sum(prompt) / len(prompt),
        "completion_tokens_mean": sum(completion) / len(completion),
        "output_tokens_per_s": sum(completion) / sum(latency),
    }
    with open(os.path.join(args.out, "e4-summary.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    fig, ax = figstyle.figure(height=2.1)
    bins = [x / 2 for x in range(int(min(latency) * 2), int(max(latency) * 2) + 2)]
    ax.hist(latency, bins=bins, color=figstyle.SERIES[0], edgecolor="white", linewidth=0.5)
    for value, name, color, style in [(summary["time_per_recommendation_s"]["p50"], "median", figstyle.SERIES[1], "--"),
                                      (summary["time_per_recommendation_s"]["p95"], "p95", figstyle.SERIES[3], ":")]:
        ax.axvline(value, color=color, linestyle=style, linewidth=1.1, label=f"{name} {value:.2f} s")
    ax.set_xlabel("Time per recommendation (s), one request at a time")
    ax.set_ylabel("Test cases (count)")
    ax.legend(loc="upper right")
    ax.grid(axis="y", color=figstyle.GRID, linewidth=0.5)
    figstyle.save(fig, os.path.join(args.out, "e4_llm_time_per_recommendation"))
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
