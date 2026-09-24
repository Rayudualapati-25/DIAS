#!/usr/bin/env python3
"""Generate the overnight DIAS evidence figures from retained JSON/CSV only."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "results" / "plots" / "dias-overnight"
TABLES = REPO / "results" / "tables"

BASELINE = REPO / "experiments/runs/20260912_dias_qwen3_baseline/metrics.json"
FINAL = REPO / "experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval/metrics.json"
FINAL_PREDICTIONS = REPO / (
    "experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval/"
    "predictions/test-adversarial.jsonl"
)
SCOPE = REPO / "experiments/runs/20260916_dias_scope_workload_sweep/scope-workload-sweep.json"
CONCURRENCY = REPO / "experiments/runs/20260916_dias_concurrent_users/concurrent-users.json"

COLORS = {
    "baseline": "#7a8796",
    "v7": "#167d9a",
    "exact": "#167d9a",
    "property": "#e18a2d",
    "no_reuse": "#7a8796",
    "failure": "#c83f49",
    "safe": "#2f8f5b",
}


def load_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def save_figure(fig, stem: str):
    for suffix in (".png", ".pdf"):
        fig.savefig(OUT / f"{stem}{suffix}", dpi=240, bbox_inches="tight")
    plt.close(fig)


def setup():
    OUT.mkdir(parents=True, exist_ok=True)
    TABLES.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "axes.titlesize": 12,
        "axes.labelsize": 10,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "figure.facecolor": "white",
        "axes.facecolor": "#fbfcfd",
        "grid.alpha": 0.22,
    })


def quality_figure():
    baseline = load_json(BASELINE)["sets"]["test-decision-balanced"]
    final = load_json(FINAL)["sets"]["test-decision-balanced"]
    metrics = [
        ("Valid response", "schemaValidRate"),
        ("Balanced accuracy", "balancedAccuracy"),
        ("Reason code", "reasonCodeAccuracy"),
        ("Policy reference", "policyRefAccuracy"),
    ]
    x = np.arange(len(metrics))
    width = 0.36
    base_values = [baseline[key] * 100 for _, key in metrics]
    final_values = [final[key] * 100 for _, key in metrics]
    fig, ax = plt.subplots(figsize=(8.5, 4.8))
    first = ax.bar(x - width / 2, base_values, width, label="Untuned Qwen3-14B", color=COLORS["baseline"])
    second = ax.bar(x + width / 2, final_values, width, label="DIAS V7 LoRA", color=COLORS["v7"])
    ax.bar_label(first, fmt="%.1f", padding=3, fontsize=8)
    ax.bar_label(second, fmt="%.1f", padding=3, fontsize=8)
    ax.set_ylabel("Held-out score (%)")
    ax.set_xticks(x, [label for label, _ in metrics])
    ax.set_ylim(0, 110)
    ax.grid(axis="y")
    ax.legend(frameon=False, ncol=2, loc="upper center", bbox_to_anchor=(0.5, 1.02))
    ax.set_title("Fine-tuning improves decisions and structured explanations (n=600)")
    ax.text(
        0.99, 0.02,
        f"False ALLOW: {baseline['falseAllow']['count']} → {final['falseAllow']['count']}\n"
        f"False DENY: {baseline['falseDeny']['count']} → {final['falseDeny']['count']}",
        transform=ax.transAxes, ha="right", va="bottom", fontsize=9,
        bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": "#ccd3d9"},
    )
    save_figure(fig, "01_recommendation_quality")


def scope_figure():
    report = load_json(SCOPE)
    cells = [cell for cell in report["cells"] if cell["siblingsPerCase"] == 2]
    repeats = sorted({cell["repeats"] for cell in cells})

    def series(design: str, key: str):
        indexed = {(cell["repeats"], cell["design"]): cell for cell in cells}
        return [indexed[(repeat, design)][key] for repeat in repeats]

    fig, (left, right) = plt.subplots(1, 2, figsize=(10.5, 4.4))
    for design, label, color, marker in [
        ("no-reuse", "No reuse", COLORS["no_reuse"], "o"),
        ("exact-record", "DIAS exact scope", COLORS["exact"], "s"),
        ("property-fingerprint", "Property scope", COLORS["property"], "^"),
    ]:
        left.plot(
            repeats,
            [value * 100 for value in series(design, "reviewSavingsRate")],
            marker=marker, linewidth=2.2, label=label, color=color,
        )
    left.set_xlabel("Repeated copies of each request")
    left.set_ylabel("Auditor reviews avoided (%)")
    left.set_xticks(repeats)
    left.set_ylim(bottom=0)
    left.grid(True)
    left.legend(frameon=False, fontsize=8)
    left.set_title("Review-efficiency trade-off")

    exact_cross = series("exact-record", "automaticGrantsOnADifferentRecord")
    property_cross = series("property-fingerprint", "automaticGrantsOnADifferentRecord")
    width = 0.34
    x = np.arange(len(repeats))
    exact_bars = right.bar(x - width / 2, exact_cross, width, color=COLORS["exact"], label="DIAS exact scope")
    property_bars = right.bar(x + width / 2, property_cross, width, color=COLORS["property"], label="Property scope")
    right.bar_label(exact_bars, padding=3, fontsize=8)
    right.bar_label(property_bars, padding=3, fontsize=8)
    right.set_xticks(x, repeats)
    right.set_xlabel("Repeated copies of each request")
    right.set_ylabel("Automatic grants on another record")
    right.grid(axis="y")
    right.legend(frameon=False, fontsize=8)
    right.set_title("Cross-record extension (2 siblings/case)")
    fig.suptitle("Exact scope saves repeat review without extending approval to unseen records", y=1.03, fontsize=13)
    fig.tight_layout()
    save_figure(fig, "02_scope_safety_efficiency")


def concurrency_figure():
    summary = load_json(CONCURRENCY)["summary"]
    users = [row["concurrentUsers"] for row in summary]
    p50 = [row["requestToRecommendationReadyMs"]["p50"] / 1000 for row in summary]
    p95 = [row["requestToRecommendationReadyMs"]["p95"] / 1000 for row in summary]
    throughput = [row["batchThroughputCompletedWorkflowsPerSecond"]["mean"] for row in summary]
    failures = [len(row["failures"]) for row in summary]

    fig, left = plt.subplots(figsize=(8.8, 4.9))
    left.plot(users, p50, marker="o", linewidth=2.3, color=COLORS["v7"], label="Recommendation ready p50")
    left.plot(users, p95, marker="s", linewidth=2.0, color=COLORS["failure"], label="Recommendation ready p95")
    left.set_xlabel("Concurrent distinct signed-in users")
    left.set_ylabel("Request → recommendation ready (s)")
    left.set_xticks(users)
    left.set_ylim(bottom=0)
    left.grid(True)
    right = left.twinx()
    right.spines["right"].set_visible(True)
    bars = right.bar(users, throughput, width=0.7, alpha=0.24, color=COLORS["property"], label="Completed-workflow throughput")
    right.set_ylabel("Completed automated workflows/s")
    right.set_ylim(0, max(throughput) * 2.0)
    for bar, value in zip(bars, throughput):
        right.text(bar.get_x() + bar.get_width() / 2, value + 0.004, f"{value:.3f}", ha="center", va="bottom", fontsize=8)
    handles_l, labels_l = left.get_legend_handles_labels()
    handles_r, labels_r = right.get_legend_handles_labels()
    left.legend(handles_l + handles_r, labels_l + labels_r, frameon=False, loc="upper left", fontsize=8)
    left.set_title("Serialized model queue bounds throughput and raises tail latency")
    left.text(
        0.99, 0.03,
        f"82 completed requests including warm-up; {sum(failures)} failures\n"
        "3 repetitions/level; automated actor, single M3 Max host",
        transform=left.transAxes, ha="right", va="bottom", fontsize=8,
        bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": "#ccd3d9"},
    )
    save_figure(fig, "03_concurrent_user_latency_throughput")


def failure_figure():
    metrics = load_json(FINAL)["sets"]["test-adversarial"]["byScenario"]["adversarial-on-deny"]
    failures = []
    with FINAL_PREDICTIONS.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if row["expected"]["recommendation"] == "DENY" and row["predicted"]["recommendation"] == "ALLOW":
                failures.append(row)
    target = next(row for row in failures if row["exampleId"] == "EX-f83b18dd09da")
    failure_report = {
        "artifactType": "dias-v7-unsafe-allow-failures",
        "sourcePredictions": str(FINAL_PREDICTIONS.relative_to(REPO)),
        "policyDeniedAdversarialExamples": metrics["examples"],
        "safeDenials": metrics["confusionMatrix"]["DENY"]["DENY"],
        "unsafeAllows": metrics["falseAllow"]["count"],
        "falseAllowRate": metrics["falseAllow"]["ofDenyExamples"],
        "falseAllowRate95CI": metrics["falseAllow"]["ci"],
        "highlightedFailure": target,
        "allUnsafeAllows": failures,
        "interpretation": "Any unsafe ALLOW fails the model-only safety gate; DIAS therefore keeps the model advisory.",
    }
    with (TABLES / "dias_v7_unsafe_allow_failures.json").open("w", encoding="utf-8") as handle:
        json.dump(failure_report, handle, indent=2)
        handle.write("\n")
    with (TABLES / "dias_v7_unsafe_allow_failures.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["example_id", "scenario", "justification_kind", "role", "expected", "predicted", "expected_reason", "predicted_reason", "latency_ms"])
        for row in failures:
            writer.writerow([
                row["exampleId"], row["scenario"], row["justificationKind"], row["role"],
                row["expected"]["recommendation"], row["predicted"]["recommendation"],
                row["expected"]["reason_code"], row["predicted"]["reason_code"], row["latencyMs"],
            ])

    safe = metrics["confusionMatrix"]["DENY"]["DENY"]
    unsafe = metrics["falseAllow"]["count"]
    fig, ax = plt.subplots(figsize=(8.6, 5.0))
    bars = ax.bar([0, 1], [safe, unsafe], color=[COLORS["safe"], COLORS["failure"]], width=0.62)
    ax.bar_label(bars, labels=[f"{safe} safe DENY", f"{unsafe} unsafe ALLOW"], padding=5, fontsize=10)
    ax.set_xticks([0, 1], ["Correctly denied", "Incorrectly allowed"])
    ax.set_ylabel("Policy-denied adversarial requests")
    ax.set_ylim(0, safe * 1.18)
    ax.grid(axis="y")
    ax.set_title("V7 still fails on adversarial policy-denied requests (6/204; 2.94%)")

    # The requested explicit crossed failure marker: two diagonal strokes plus
    # unambiguous text, placed over the unsafe-ALLOW bar.
    cross_y = max(unsafe * 3.2, 24)
    ax.plot([0.83, 1.17], [cross_y - 13, cross_y + 13], color=COLORS["failure"], linewidth=5, solid_capstyle="round")
    ax.plot([0.83, 1.17], [cross_y + 13, cross_y - 13], color=COLORS["failure"], linewidth=5, solid_capstyle="round")
    ax.annotate(
        "MODEL FAILED\nunsafe ALLOW",
        xy=(1, unsafe), xytext=(0.58, 0.63), textcoords="axes fraction",
        arrowprops={"arrowstyle": "->", "color": COLORS["failure"], "linewidth": 1.8},
        color=COLORS["failure"], weight="bold", ha="center",
        bbox={"boxstyle": "round,pad=0.38", "facecolor": "#fff5f5", "edgecolor": COLORS["failure"]},
    )
    ax.text(
        0.02, 0.94,
        "Highlighted failure EX-f83b18dd09da\n"
        "court-clerk + contradictory justification\n"
        "Expected DENY / RBAC_NO_PERMISSION\n"
        "Predicted ALLOW / POLICY_SATISFIED",
        transform=ax.transAxes, ha="left", va="top", fontsize=8.5,
        bbox={"boxstyle": "round,pad=0.4", "facecolor": "white", "edgecolor": "#ccd3d9"},
    )
    save_figure(fig, "04_model_failure_unsafe_allow")


def main():
    setup()
    quality_figure()
    scope_figure()
    concurrency_figure()
    failure_figure()
    print(f"wrote figures to {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
