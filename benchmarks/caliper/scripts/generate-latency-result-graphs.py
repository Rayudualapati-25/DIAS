#!/usr/bin/env python3
"""Generate latency figures from completed Caliper summary artifacts only."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


PROJECT_DIR = Path(
  os.environ.get("CALIPER_LATENCY_PROJECT_DIR", Path(__file__).resolve().parents[3])
).resolve()
PLOT_DIR = PROJECT_DIR / "results" / "plots" / "caliper-latency"
TABLE_DIR = PROJECT_DIR / "results" / "tables" / "caliper_latency"
EXPECTED_AXIS_IDS = [
  "concurrent_clients_vs_lookup_latency",
  "offered_tps_vs_write_latency",
  "query_result_count_vs_latency",
  "policy_path_vs_latency",
  "elapsed_time_vs_latency",
]
BLUE = "#0072B2"
ORANGE = "#D55E00"
GREEN = "#009E73"
GRAY = "#4D4D4D"


def sha256(path: Path) -> str:
  return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> dict:
  return json.loads(path.read_text(encoding="utf-8"))


def resolve_run_dir(value: str) -> Path:
  run_dir = Path(value)
  if run_dir.is_absolute():
    return run_dir
  return PROJECT_DIR / run_dir


def count_jsonl_round(path: Path, label: str) -> int:
  count = 0
  with path.open("r", encoding="utf-8") as handle:
    for line_number, line in enumerate(handle, start=1):
      if not line.strip():
        continue
      try:
        event = json.loads(line)
      except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSONL transaction evidence at {path}:{line_number}") from error
      if event.get("roundLabel") == label:
        count += 1
  return count


def load_round(run_dir: Path, label: str) -> dict:
  manifest_path = run_dir / "run-manifest.json"
  if not manifest_path.exists():
    raise FileNotFoundError(f"missing run manifest: {manifest_path}")
  manifest = read_json(manifest_path)
  if manifest.get("status") != "completed":
    raise ValueError(f"run is not completed: {manifest_path}")

  summary_path = run_dir / "caliper-summary.json"
  tx_summary_path = run_dir / "caliper-transaction-summary.json"
  tx_jsonl_path = run_dir / "caliper-transactions.jsonl"
  if not summary_path.exists():
    raise FileNotFoundError(f"missing Caliper summary: {summary_path}")
  if not tx_summary_path.exists():
    raise FileNotFoundError(f"missing transaction timing summary: {tx_summary_path}")
  if not tx_jsonl_path.exists():
    raise FileNotFoundError(f"missing transaction timing JSONL: {tx_jsonl_path}")
  summary = read_json(summary_path)
  matches = [item for item in summary["rounds"] if item["label"] == label]
  if len(matches) != 1:
    raise ValueError(f"{summary_path} has {len(matches)} rows for {label}")
  tx_summary = read_json(tx_summary_path)
  tx_matches = [item for item in tx_summary["rounds"] if item["roundLabel"] == label]
  if len(tx_matches) != 1:
    raise ValueError(f"{tx_summary_path} has {len(tx_matches)} rows for {label}")
  if matches[0].get("phase") == "warmup":
    raise ValueError(f"warmup round cannot be plotted as a measurement: {label}")
  if tx_matches[0]["count"] != matches[0]["successfulTransactions"] + matches[0]["failedTransactions"]:
    raise ValueError(f"summary/evidence count mismatch for {label}")
  jsonl_count = count_jsonl_round(tx_jsonl_path, label)
  if jsonl_count != tx_matches[0]["count"]:
    raise ValueError(f"JSONL/evidence summary count mismatch for {label}")
  return {
    **matches[0],
    "runId": manifest.get("runId"),
    "manifestPath": manifest_path,
    "manifestSha256": sha256(manifest_path),
    "summaryPath": summary_path,
    "summarySha256": sha256(summary_path),
    "txSummaryPath": tx_summary_path,
    "txSummarySha256": sha256(tx_summary_path),
    "txJsonlPath": tx_jsonl_path,
    "txJsonlSha256": sha256(tx_jsonl_path),
    "latencyMs": tx_matches[0]["latencyMs"],
    "txCount": tx_matches[0]["count"],
  }


def write_table(axis_id: str, rows: list[dict]) -> Path:
  TABLE_DIR.mkdir(parents=True, exist_ok=True)
  output = TABLE_DIR / f"{axis_id}.csv"
  fields = [
    "axis_id", "x_label", "x_value", "round_label", "run_directory",
    "successful_transactions", "failed_transactions", "send_rate_tps",
    "failure_rate", "throughput_tps", "latency_min_ms", "latency_mean_ms",
    "latency_p50_ms", "latency_p95_ms", "latency_p99_ms", "latency_max_ms",
  ]
  with output.open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
      writer.writerow(row)
  return output


def plot_axis(axis: dict, rows: list[dict]) -> list[Path]:
  PLOT_DIR.mkdir(parents=True, exist_ok=True)
  x_labels = [row["x_label"] for row in rows]
  x = (
    list(range(len(rows)))
    if axis.get("categorical")
    else [float(row["x_value"]) for row in rows]
  )
  p50_ms = [row["latency_p50_ms"] for row in rows]
  mean_ms = [row["latency_mean_ms"] for row in rows]
  p95_ms = [row["latency_p95_ms"] for row in rows]

  fig, ax = plt.subplots(figsize=(5.8, 3.4))
  ax.plot(x, p50_ms, marker="o", color=BLUE, linewidth=1.8, label="p50 latency")
  ax.plot(x, mean_ms, marker="^", color=GREEN, linewidth=1.5, label="Mean latency")
  ax.plot(x, p95_ms, marker="s", color=ORANGE, linewidth=1.5, label="p95 latency")
  ax.set_title(axis["title"], fontsize=10.5, fontweight="bold")
  ax.set_ylabel("Latency (ms)", fontsize=9)
  ax.set_xlabel(axis["xAxis"], fontsize=9)
  default_rotation = 18 if axis.get("categorical") else 0
  default_alignment = "right" if axis.get("categorical") else "center"
  ax.set_xticks(
    x,
    x_labels,
    rotation=axis.get("xRotation", default_rotation),
    ha=axis.get("xAlign", default_alignment),
  )
  ax.tick_params(axis="x", labelsize=7.5 if len(rows) > 6 else 8.5)
  ax.tick_params(axis="y", labelsize=8.5)
  ax.grid(axis="y", color="#D0D0D0", linewidth=0.5, alpha=0.85)
  ax.spines[["top", "right"]].set_visible(False)
  ax.legend(frameon=False, fontsize=7.5)
  ax.margins(y=0.08)
  all_zero_failures = all(row["failed_transactions"] == 0 for row in rows)
  if not all_zero_failures:
    for index, row in enumerate(rows):
      ax.annotate(
        f"fail {row['failed_transactions']} ({row['failure_rate'] * 100:.1f}%)",
        xy=(x[index], row["latency_p95_ms"]),
        xytext=(0, 6),
        textcoords="offset points",
        ha="center",
        va="bottom",
        fontsize=5.8,
        color=GRAY,
      )
  failure_note = (
    "All plotted points: 0 failed transactions.\n"
    if all_zero_failures else
    "Failure counts are annotated at each point.\n"
  )
  fig.text(
    0.5, 0.012,
    failure_note +
    "Single live-network pilot; not repeated paper evidence. Measured from retained Caliper transaction timing artifacts.",
    ha="center", va="bottom", fontsize=6.5, color=GRAY,
  )
  bottom_margin = 0.23 if axis.get("categorical") else 0.14
  fig.tight_layout(rect=(0, bottom_margin, 1, 1))

  outputs = [
    PLOT_DIR / f"{axis['id']}.png",
    PLOT_DIR / f"{axis['id']}.pdf",
  ]
  fig.savefig(outputs[0], dpi=300)
  fig.savefig(outputs[1])
  plt.close(fig)
  return outputs


def validate_suite(suite: dict, suite_path: Path) -> None:
  if suite.get("status") != "completed":
    raise ValueError(f"suite manifest is not completed: {suite_path}")
  axes = suite.get("axes")
  if not isinstance(axes, list):
    raise ValueError("suite manifest must contain axes[]")
  axis_ids = [axis.get("id") for axis in axes]
  if axis_ids != EXPECTED_AXIS_IDS:
    raise ValueError(f"suite axes must be exactly {EXPECTED_AXIS_IDS}; got {axis_ids}")
  for axis in axes:
    points = axis.get("points")
    if not isinstance(points, list) or not points:
      raise ValueError(f"axis {axis.get('id')} must contain points[]")
    for point in points:
      for field in ["runDirectory", "roundLabel", "xValue", "xLabel"]:
        if field not in point:
          raise ValueError(f"axis {axis.get('id')} point is missing {field}")


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("manifest", nargs="?")
  parser.add_argument("--suite-manifest", dest="suite_manifest")
  args = parser.parse_args()
  manifest_arg = args.suite_manifest or args.manifest
  if not manifest_arg:
    print("usage: generate-latency-result-graphs.py [--suite-manifest] <suite-manifest.json>", file=sys.stderr)
    return 2

  suite_path = Path(manifest_arg).resolve()
  suite = read_json(suite_path)
  validate_suite(suite, suite_path)
  manifest = {
    "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
    "sourceSuiteManifest": str(suite_path),
    "sourceSuiteManifestSha256": sha256(suite_path),
    "performanceResultsUsed": True,
    "figures": [],
    "tables": [],
  }

  for axis in suite["axes"]:
    rows = []
    for point in axis["points"]:
      run_dir = resolve_run_dir(point["runDirectory"])
      result = load_round(run_dir, point["roundLabel"])
      rows.append({
        "axis_id": axis["id"],
        "x_label": point["xLabel"],
        "x_value": point["xValue"],
        "round_label": point["roundLabel"],
        "run_directory": str(run_dir),
        "successful_transactions": result["successfulTransactions"],
        "failed_transactions": result["failedTransactions"],
        "failure_rate": (
          result["failedTransactions"] /
          (result["successfulTransactions"] + result["failedTransactions"])
        ),
        "send_rate_tps": result["observedSendRateTps"],
        "throughput_tps": result["throughputTps"],
        "latency_min_ms": result["latencyMs"]["min"],
        "latency_mean_ms": result["latencyMs"]["mean"],
        "latency_p50_ms": result["latencyMs"]["p50"],
        "latency_p95_ms": result["latencyMs"]["p95"],
        "latency_p99_ms": result["latencyMs"]["p99"],
        "latency_max_ms": result["latencyMs"]["max"],
        "_manifest_path": str(result["manifestPath"]),
        "_run_id": result["runId"],
        "_manifest_sha256": result["manifestSha256"],
        "_summary_sha256": result["summarySha256"],
        "_tx_summary_sha256": result["txSummarySha256"],
        "_tx_jsonl_sha256": result["txJsonlSha256"],
      })
    table = write_table(axis["id"], rows)
    figures = plot_axis(axis, rows)
    manifest["tables"].append({
      "axis": axis["id"],
      "path": str(table),
      "sha256": sha256(table),
      "sourceRuns": [{
        "runId": row["_run_id"],
        "roundLabel": row["round_label"],
        "runDirectory": row["run_directory"],
        "runManifest": row["_manifest_path"],
        "runManifestSha256": row["_manifest_sha256"],
        "caliperSummarySha256": row["_summary_sha256"],
        "transactionSummarySha256": row["_tx_summary_sha256"],
        "transactionJsonlSha256": row["_tx_jsonl_sha256"],
      } for row in rows],
    })
    for figure in figures:
      manifest["figures"].append({
        "axis": axis["id"],
        "path": str(figure),
        "sha256": sha256(figure),
      })

  manifest_path = PLOT_DIR / "figure_manifest.json"
  manifest_path.write_text(f"{json.dumps(manifest, indent=2)}\n", encoding="utf-8")
  print(f"Latency figure manifest: {manifest_path}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
