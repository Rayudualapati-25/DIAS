#!/usr/bin/env python3
"""Aggregate the three load-test repetitions and draw the paper figure.

Reads latency_by_concurrency_run{1,2,3}.csv, averages each metric across the
repetitions, reports the spread, and writes:

  latency_summary_aggregated.csv   mean and standard deviation per level
  latency_vs_concurrency.png       two-panel figure for the paper
"""

from __future__ import annotations

import csv
import statistics
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).parent
RUNS = ("run1", "run2", "run3")
METRICS = ("p50Ms", "meanMs", "p95Ms", "p99Ms", "maxMs", "throughputTps")


def read_run(label: str) -> dict[int, dict[str, float]]:
    """Return {concurrency: {metric: value}} for one repetition."""
    path = HERE / f"latency_by_concurrency_{label}.csv"
    with path.open() as handle:
        return {
            int(row["concurrentUsers"]): {
                metric: float(row[metric]) for metric in METRICS
            }
            for row in csv.DictReader(handle)
        }


def aggregate(runs: list[dict[int, dict[str, float]]]) -> list[dict[str, float]]:
    """Mean and sample standard deviation of every metric, per level."""
    levels = sorted(runs[0])
    rows = []
    for level in levels:
        row: dict[str, float] = {"concurrentUsers": level, "repetitions": len(runs)}
        for metric in METRICS:
            values = [run[level][metric] for run in runs]
            row[f"{metric}_mean"] = round(statistics.fmean(values), 2)
            row[f"{metric}_sd"] = round(
                statistics.stdev(values) if len(values) > 1 else 0.0, 2
            )
        rows.append(row)
    return rows


def write_csv(rows: list[dict[str, float]]) -> Path:
    path = HERE / "latency_summary_aggregated.csv"
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return path


def draw(rows: list[dict[str, float]]) -> Path:
    levels = [r["concurrentUsers"] for r in rows]
    concurrent = [r for r in rows if r["concurrentUsers"] > 1]
    control = next(r for r in rows if r["concurrentUsers"] == 1)

    x = [r["concurrentUsers"] for r in concurrent]

    fig, (ax_lat, ax_tps) = plt.subplots(1, 2, figsize=(11, 4.2))

    # ---- panel A: latency ------------------------------------------------
    for metric, label, marker in (
        ("p50Ms", "median (p50)", "o"),
        ("p95Ms", "95th percentile", "s"),
    ):
        ax_lat.errorbar(
            x,
            [r[f"{metric}_mean"] for r in concurrent],
            yerr=[r[f"{metric}_sd"] for r in concurrent],
            marker=marker, capsize=3, linewidth=1.8, markersize=6, label=label,
        )

    ax_lat.axhline(
        control["p50Ms_mean"], linestyle="--", linewidth=1.3, color="#b3261e",
    )
    ax_lat.annotate(
        f"single user: {control['p50Ms_mean']:.0f} ms\n"
        "(waits the full 2 s BatchTimeout)",
        xy=(52, control["p50Ms_mean"]),
        xytext=(30, control["p50Ms_mean"] * 0.42),
        fontsize=8.5, color="#b3261e",
        arrowprops=dict(arrowstyle="->", color="#b3261e", linewidth=1),
    )

    ax_lat.set_yscale("log")
    ax_lat.set_xlabel("concurrent officers filing a record")
    ax_lat.set_ylabel("client-observed latency (ms, log scale)")
    ax_lat.set_title("(a) Latency vs concurrency")
    ax_lat.grid(True, which="both", alpha=0.25)
    ax_lat.set_xticks(x)
    ax_lat.legend(frameon=False, fontsize=9)

    # ---- panel B: throughput --------------------------------------------
    ax_tps.errorbar(
        x,
        [r["throughputTps_mean"] for r in concurrent],
        yerr=[r["throughputTps_sd"] for r in concurrent],
        marker="D", capsize=3, linewidth=1.8, markersize=6, color="#2e7d32",
    )
    ax_tps.set_xlabel("concurrent officers filing a record")
    ax_tps.set_ylabel("committed transactions per second")
    ax_tps.set_title("(b) Throughput vs concurrency")
    ax_tps.grid(True, alpha=0.25)
    ax_tps.set_xticks(x)
    ax_tps.set_ylim(0, max(r["throughputTps_mean"] for r in concurrent) * 1.25)

    fig.suptitle(
        "Concurrent record filing on the live 5-organisation Fabric network "
        f"(mean of {rows[0]['repetitions']} runs, error bars = SD)",
        fontsize=10.5,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.94))

    path = HERE / "latency_vs_concurrency.png"
    fig.savefig(path, dpi=200)
    fig.savefig(HERE / "latency_vs_concurrency.pdf")
    return path


def main() -> None:
    runs = [read_run(label) for label in RUNS]
    rows = aggregate(runs)
    csv_path = write_csv(rows)
    png_path = draw(rows)

    print(f"{'N':>5} {'p50 ms':>16} {'p95 ms':>16} {'throughput tps':>18}")
    for row in rows:
        print(
            f"{int(row['concurrentUsers']):>5} "
            f"{row['p50Ms_mean']:>9.1f} ±{row['p50Ms_sd']:<5.1f} "
            f"{row['p95Ms_mean']:>9.1f} ±{row['p95Ms_sd']:<5.1f} "
            f"{row['throughputTps_mean']:>11.1f} ±{row['throughputTps_sd']:<5.1f}"
        )
    print(f"\nWrote:\n  {csv_path}\n  {png_path}")


if __name__ == "__main__":
    main()
