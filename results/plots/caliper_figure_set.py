#!/usr/bin/env python3
"""Generate paper figures from retained Caliper run artifacts.

The script only consumes completed runs under `experiments/runs/`. It ignores
warm-up rows, refuses to invent data, and exits with a clear message when no
completed benchmark artifacts exist yet.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNS_DIR = REPO_ROOT / "experiments" / "runs"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "caliper"

TEST_ORDER = [
    "read-performance",
    "write-performance",
    "increasing-load",
    "mixed-workload",
    "endurance",
]

TEST_TITLES = {
    "read-performance": "Read performance",
    "write-performance": "Write performance",
    "increasing-load": "Increasing load",
    "mixed-workload": "Mixed workload",
    "endurance": "Endurance",
}

TEST_NOTES = {
    "read-performance": "Read-only measurement round. Warm-up rows are excluded.",
    "write-performance": "Contextual write round. Warm-up rows are excluded.",
    "increasing-load": "Five fixed TPS steps measured in one run.",
    "mixed-workload": "Configured 70/30 read/write schedule.",
    "endurance": "Two-hour sustained 70/30 schedule.",
}

TEST_ALIASES = {
    "latency-write-tps": "increasing-load",
}

STYLE = {
    "font.size": 10,
    "axes.titlesize": 11,
    "axes.labelsize": 10,
    "legend.fontsize": 9,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "figure.titlesize": 12,
}


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def as_float(value) -> float | None:
    if value in (None, "", "-", "N/A"):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def discover_completed_runs(runs_dir: Path) -> list[dict]:
    runs: list[dict] = []
    for manifest_path in sorted(runs_dir.glob("*/run-manifest.json")):
        manifest = load_json(manifest_path)
        if manifest.get("status") != "completed":
            continue
        summary_name = manifest.get("performanceSummary")
        if not summary_name:
            continue
        summary_path = manifest_path.parent / summary_name
        if not summary_path.exists():
            continue
        summary = load_json(summary_path)
        rounds = summary.get("rounds")
        if not isinstance(rounds, list) or not rounds:
            continue
        runs.append({
            "run_dir": manifest_path.parent,
            "manifest": manifest,
            "summary_path": summary_path,
            "rounds": rounds,
        })
    return runs


def test_id_from_manifest(manifest: dict) -> str:
    stem = Path(manifest["benchmarkConfig"]).stem
    return TEST_ALIASES.get(stem, stem)


def measurement_rows(runs: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for run in runs:
        for row in run["rounds"]:
            if row.get("phase", "measurement") != "measurement":
                continue
            rows.append({
                "test_id": test_id_from_manifest(run["manifest"]),
                "run_id": run["manifest"]["runId"],
                "label": row.get("label", ""),
                "started_at_utc": run["manifest"].get("startedAtUtc"),
                "successful_tx": as_float(row.get("successfulTransactions")),
                "failed_tx": as_float(row.get("failedTransactions")),
                "observed_send_rate_tps": as_float(row.get("observedSendRateTps")),
                "throughput_tps": as_float(row.get("throughputTps")),
                "latency_min_s": as_float(row.get("latencyMinSeconds")),
                "latency_avg_s": as_float(row.get("latencyAverageSeconds")),
                "latency_max_s": as_float(row.get("latencyMaxSeconds")),
            })
    return rows


def write_raw_rows_csv(rows: list[dict], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "caliper_raw_rows.csv"
    fieldnames = [
        "test_id",
        "run_id",
        "label",
        "started_at_utc",
        "successful_tx",
        "failed_tx",
        "observed_send_rate_tps",
        "throughput_tps",
        "latency_min_s",
        "latency_avg_s",
        "latency_max_s",
    ]
    with out_path.open("w", newline="", encoding="utf8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fieldnames})
    return out_path


def grouped_by_test(rows: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[row["test_id"]].append(row)
    return grouped


def ordered_repetitions(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda row: (
        row.get("started_at_utc") or "",
        row.get("run_id") or "",
        row.get("label") or "",
    ))


def summarize(values: list[float | None]) -> dict[str, float | None]:
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return {"n": 0, "mean": None, "sd": None, "min": None, "max": None}
    return {
        "n": len(clean),
        "mean": statistics.fmean(clean),
        "sd": statistics.stdev(clean) if len(clean) > 1 else 0.0,
        "min": min(clean),
        "max": max(clean),
    }


def configure_axes(ax, ylabel: str, title: str) -> None:
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.grid(True, axis="y", alpha=0.25)


def annotate(ax, text: str, *, x: float = 0.02, y: float = 0.98, ha: str = "left") -> None:
    ax.text(
        x,
        y,
        text,
        transform=ax.transAxes,
        ha=ha,
        va="top",
        fontsize=8.5,
        bbox=dict(boxstyle="round,pad=0.35", facecolor="white", alpha=0.9,
                  edgecolor="#888888"),
    )


def save_figure(fig, output_dir: Path, stem: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(output_dir / f"{stem}.png", dpi=220)
    fig.savefig(output_dir / f"{stem}.pdf")
    plt.close(fig)


def plot_fixed_rate_test(test_id: str, rows: list[dict], output_dir: Path) -> None:
    repetitions = ordered_repetitions(rows)
    cleaned = [row for row in repetitions if row["throughput_tps"] is not None]
    throughput = [row["throughput_tps"] for row in cleaned]
    latency_min = [row["latency_min_s"] for row in cleaned if row["latency_min_s"] is not None]
    latency_avg = [row["latency_avg_s"] for row in cleaned if row["latency_avg_s"] is not None]
    latency_max = [row["latency_max_s"] for row in cleaned if row["latency_max_s"] is not None]
    send_rates = [row["observed_send_rate_tps"] for row in cleaned if row["observed_send_rate_tps"] is not None]

    if not cleaned or not throughput or not latency_avg:
        raise SystemExit(
            f"{test_id} does not contain complete throughput/latency measurements."
        )

    fig, axes = plt.subplots(1, 2, figsize=(11.6, 4.2))
    fig.suptitle(f"{TEST_TITLES[test_id]} on the live Fabric network", fontsize=11.5)

    # Panel A: throughput per repetition with the offered rate as a reference line.
    ax = axes[0]
    x = list(range(1, len(cleaned) + 1))
    ax.plot(x, throughput, marker="o", linewidth=1.8, color="#2e7d32",
            label="throughput")
    if any(rate is not None for rate in send_rates):
        offered = statistics.fmean(rate for rate in send_rates if rate is not None)
        ax.axhline(offered, linestyle="--", linewidth=1.3, color="#b3261e",
                   label="offered send rate")
    ax.set_xticks(x)
    ax.set_xticklabels([f"r{i}" for i in x])
    configure_axes(ax, "transactions per second", "Throughput by repetition")
    ax.legend(frameon=False, loc="upper right")
    throughput_summary = summarize(throughput)
    annotate(
        ax,
        f"n={throughput_summary['n']}\n"
        f"mean={throughput_summary['mean']:.2f} TPS\n"
        f"sd={throughput_summary['sd']:.2f} TPS"
        if throughput_summary["mean"] is not None
        else "no throughput data",
        y=0.12,
    )

    # Panel B: latency distribution across the repetitions.
    ax = axes[1]
    latency_sets = [latency_min, latency_avg, latency_max]
    ax.boxplot(
        latency_sets,
        labels=["min", "avg", "max"],
        widths=0.55,
        patch_artist=True,
        showmeans=True,
        meanprops=dict(marker="D", markerfacecolor="#1565c0",
                       markeredgecolor="#1565c0", markersize=4.5),
        boxprops=dict(facecolor="#1565c033", color="#1565c0", linewidth=1.2),
        whiskerprops=dict(color="#1565c0", linewidth=1.1),
        capprops=dict(color="#1565c0", linewidth=1.1),
        medianprops=dict(color="#1565c0", linewidth=1.3),
    )
    ax.set_yscale("log")
    configure_axes(ax, "latency (s, log scale)", "Latency metrics")
    avg_summary = summarize(latency_avg)
    min_summary = summarize(latency_min)
    max_summary = summarize(latency_max)
    annotate(
        ax,
        f"mean avg latency={avg_summary['mean']:.4f} s\n"
        f"range={min_summary['min']:.4f} to {max_summary['max']:.4f} s"
        if avg_summary["mean"] is not None
        else "no latency data",
    )

    fig.text(0.01, 0.01, TEST_NOTES[test_id], fontsize=8.5, color="#444444")
    save_figure(fig, output_dir, f"caliper_{test_id}")


def parse_step(label: str, fallback: float | None) -> float | None:
    import re

    match = re.search(r"(\d+(?:\.\d+)?)\s*tps", label.lower())
    if match:
        return float(match.group(1))
    return fallback


def plot_increasing_load(rows: list[dict], output_dir: Path) -> None:
    grouped: dict[float, list[dict]] = defaultdict(list)
    for row in rows:
        step = parse_step(row["label"], row["observed_send_rate_tps"])
        if step is None:
            continue
        grouped[step].append(row)

    steps = sorted(grouped)
    if not steps:
        raise SystemExit("Increasing-load data exists but no TPS step could be parsed.")

    def agg(step: float, key: str) -> float | None:
        values = [row[key] for row in grouped[step] if row[key] is not None]
        return statistics.fmean(values) if values else None

    throughput = [agg(step, "throughput_tps") for step in steps]
    latency_avg = [agg(step, "latency_avg_s") for step in steps]
    latency_max = [agg(step, "latency_max_s") for step in steps]
    failures = [sum(int(row["failed_tx"]) for row in grouped[step] if row["failed_tx"] is not None)
                for step in steps]

    if any(value is None for value in throughput + latency_avg + latency_max):
        raise SystemExit("increasing-load summary rows are missing required metrics.")

    fig, axes = plt.subplots(1, 2, figsize=(11.6, 4.4))
    fig.suptitle("Increasing-load saturation sweep on the live Fabric network", fontsize=11.5)

    ax = axes[0]
    ax.plot(steps, throughput, marker="o", linewidth=1.8, color="#2e7d32",
            label="throughput")
    ax.plot(steps, steps, linestyle="--", linewidth=1.3, color="#b3261e",
            label="offered load")
    ax.set_xlabel("offered load (TPS)")
    configure_axes(ax, "throughput (TPS)", "Throughput response")
    ax.legend(frameon=False, loc="lower right")
    annotate(
        ax,
        "saturation is the point where throughput flattens,\nlatency rises sharply, or failures appear",
        y=0.12,
    )

    ax = axes[1]
    ax.plot(steps, latency_avg, marker="o", linewidth=1.8, color="#1565c0",
            label="average latency")
    ax.plot(steps, latency_max, marker="s", linewidth=1.3, color="#6a1b9a",
            label="maximum latency")
    ax.set_xlabel("offered load (TPS)")
    configure_axes(ax, "latency (s)", "Latency response")
    ax2 = ax.twinx()
    ax2.bar([step + 0.12 for step in steps], failures, width=0.24,
            color="#c62828", alpha=0.25, label="failed transactions")
    ax2.set_ylabel("failed transactions")
    ax.legend(frameon=False, loc="lower left")
    ax2.legend(frameon=False, loc="upper right")
    annotate(ax, "failure bars are plotted per step; zero is still visible")

    save_figure(fig, output_dir, "caliper_increasing-load")


def output_provenance(runs: list[dict], output_dir: Path, generated: list[Path]) -> Path:
    provenance = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sourceRuns": [
            {
                "runId": run["manifest"]["runId"],
                "benchmarkConfig": run["manifest"]["benchmarkConfig"],
                "summarySha256": sha256(run["summary_path"]),
            }
            for run in runs
        ],
        "outputs": [str(path.relative_to(REPO_ROOT)) for path in generated],
    }
    out_path = output_dir / "caliper_figure_set_provenance.json"
    with out_path.open("w", encoding="utf8") as handle:
        json.dump(provenance, handle, indent=2)
        handle.write("\n")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    plt.rcParams.update(STYLE)

    runs = discover_completed_runs(args.runs_dir)
    if not runs:
        raise SystemExit(
            f"No completed Caliper runs were found under {args.runs_dir}. "
            "Run the benchmarks first; the plotter will not fabricate figures."
        )

    rows = measurement_rows(runs)
    if not rows:
        raise SystemExit(
            "Completed Caliper runs were found, but none contained measurement rows."
        )

    output_dir = args.output_dir
    raw_rows_path = write_raw_rows_csv(rows, output_dir)

    by_test = grouped_by_test(rows)
    generated: list[Path] = []

    print("Completed runs discovered:")
    for test_id in TEST_ORDER:
        test_rows = by_test.get(test_id, [])
        if not test_rows:
            continue
        if test_id == "increasing-load":
            steps = sorted({
                parse_step(row["label"], row["observed_send_rate_tps"])
                for row in test_rows
                if parse_step(row["label"], row["observed_send_rate_tps"]) is not None
            })
            print(f"  {test_id}: {len(test_rows)} rows across steps {steps}")
            plot_increasing_load(test_rows, output_dir)
            generated.append(output_dir / "caliper_increasing-load.png")
        else:
            print(f"  {test_id}: {len(test_rows)} repetition(s)")
            plot_fixed_rate_test(test_id, test_rows, output_dir)
            generated.append(output_dir / f"caliper_{test_id}.png")

    provenance_path = output_provenance(runs, output_dir, generated)

    print("\nWrote:")
    print(f"  {raw_rows_path}")
    for path in generated:
        print(f"  {path}")
    print(f"  {provenance_path}")


if __name__ == "__main__":
    main()
