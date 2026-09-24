#!/usr/bin/env python3
"""Create compact tables for the retained overnight DIAS experiments."""

from __future__ import annotations

import csv
import json
import statistics
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
TABLES = REPO / "results" / "tables"
SEED_ROOT = REPO / "experiments" / "runs" / "20260916_dias_seed_pilot"
EXPANDED = (
    REPO
    / "experiments"
    / "runs"
    / "20260917_dias_expanded_adversarial"
    / "metrics.json"
)
SEEDS = (17, 42, 73)


def load_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def mean_std(values):
    return {
        "mean": round(statistics.mean(values), 6),
        "sampleStdDev": round(statistics.stdev(values), 6),
        "min": round(min(values), 6),
        "max": round(max(values), 6),
    }


def summarize_seeds():
    rows = []
    for seed in SEEDS:
        path = SEED_ROOT / f"seed-{seed}" / "evaluation" / "metrics.json"
        metric = load_json(path)["sets"]["validation-balanced"]
        rows.append({
            "seed": seed,
            "examples": metric["examples"],
            "schema_valid_rate": metric["schemaValidRate"],
            "decision_accuracy": metric["decisionAccuracy"],
            "balanced_accuracy": metric["balancedAccuracy"],
            "reason_code_accuracy": metric["reasonCodeAccuracy"],
            "policy_ref_accuracy": metric["policyRefAccuracy"],
            "false_allow_count": metric["falseAllow"]["count"],
            "false_allow_rate_among_denials": metric["falseAllow"]["ofDenyExamples"],
            "false_deny_count": metric["falseDeny"]["count"],
            "false_deny_rate_among_allows": metric["falseDeny"]["ofAllowExamples"],
            "median_latency_ms": metric["latencyMs"]["median"],
        })

    csv_path = TABLES / "dias_seed_pilot.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    summary = {
        "artifactType": "dias-bounded-seed-pilot-summary",
        "source": str(SEED_ROOT.relative_to(REPO)),
        "scope": (
            "Three fresh LoRA adapters trained on the same 400-example subset "
            "for 256 iterations and evaluated on the same first 120 validation examples."
        ),
        "warning": (
            "This budget-limited pilot is not the full 5,254-example, one-epoch "
            "training experiment and does not establish full-run seed robustness."
        ),
        "rows": rows,
        "aggregate": {
            key: mean_std([row[key] for row in rows])
            for key in (
                "decision_accuracy",
                "balanced_accuracy",
                "reason_code_accuracy",
                "policy_ref_accuracy",
                "false_allow_rate_among_denials",
                "false_deny_rate_among_allows",
                "median_latency_ms",
            )
        },
    }
    json_path = TABLES / "dias_seed_pilot_summary.json"
    with json_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
        handle.write("\n")


def summarize_expanded_adversarial():
    metrics = load_json(EXPANDED)
    overall = metrics["sets"]["adversarial-expanded"]
    rows = []
    for name, metric in sorted(overall["byJustificationKind"].items()):
        rows.append({
            "justification_kind": name,
            "examples": metric["examples"],
            "schema_valid_rate": metric["schemaValidRate"],
            "decision_accuracy": metric["decisionAccuracy"],
            "reason_code_accuracy": metric["reasonCodeAccuracy"],
            "policy_ref_accuracy": metric["policyRefAccuracy"],
            "review_flag_accuracy": metric["reviewFlagAccuracy"],
            "false_allow_count": metric["falseAllow"]["count"],
            "median_latency_ms": metric["latencyMs"]["median"],
        })
    csv_path = TABLES / "dias_expanded_adversarial.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    summary = {
        "artifactType": "dias-expanded-adversarial-summary",
        "source": str(EXPANDED.relative_to(REPO)),
        "construction": (
            "Twenty retained policy-DENY base cases, each rendered with six "
            "deterministic justification variants; this is an all-DENY, templated stress test."
        ),
        "overall": {
            "examples": overall["examples"],
            "schemaValidRate": overall["schemaValidRate"],
            "decisionAccuracy": overall["decisionAccuracy"],
            "reasonCodeAccuracy": overall["reasonCodeAccuracy"],
            "policyRefAccuracy": overall["policyRefAccuracy"],
            "reviewFlagAccuracy": overall["reviewFlagAccuracy"],
            "falseAllow": overall["falseAllow"],
            "latencyMs": overall["latencyMs"],
        },
        "rows": rows,
        "limitation": (
            "Zero observed false allows has a 95% Wilson upper bound of 3.102%; "
            "the test is not a claim of arbitrary prompt-injection resistance."
        ),
    }
    json_path = TABLES / "dias_expanded_adversarial_summary.json"
    with json_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
        handle.write("\n")


def main():
    TABLES.mkdir(parents=True, exist_ok=True)
    summarize_seeds()
    summarize_expanded_adversarial()
    print("wrote overnight seed and adversarial summaries")


if __name__ == "__main__":
    main()
