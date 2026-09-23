#!/usr/bin/env python3
"""Fixture test for the strict Caliper latency plotter."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]
PLOTTER = REPO_DIR / "results" / "plots" / "caliper_latency_axes.py"
AXES = [
  "concurrent_clients_vs_lookup_latency",
  "offered_tps_vs_write_latency",
  "query_result_count_vs_latency",
  "policy_path_vs_latency",
  "elapsed_time_vs_latency",
]


def write_json(path: Path, value: object) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(f"{json.dumps(value, indent=2)}\n", encoding="utf-8")


def make_round(label: str, latency_ms: float) -> dict:
  return {
    "label": label,
    "phase": "measurement",
    "successfulTransactions": 1,
    "failedTransactions": 0,
    "observedSendRateTps": 1.0,
    "throughputTps": 1.0,
    "latencyMinSeconds": latency_ms / 1000,
    "latencyMaxSeconds": latency_ms / 1000,
    "latencyAverageSeconds": latency_ms / 1000,
  }


def main() -> int:
  with tempfile.TemporaryDirectory(prefix="caliper-latency-plotter-") as tmp:
    project = Path(tmp)
    run_dir = project / "experiments" / "runs" / "fixture-run"
    labels = [f"round-{index}" for index in range(1, 6)]
    write_json(run_dir / "run-manifest.json", {
      "runId": "fixture-run",
      "status": "completed",
    })
    write_json(run_dir / "caliper-summary.json", {
      "rounds": [make_round(label, 10 + index) for index, label in enumerate(labels)],
    })
    write_json(run_dir / "caliper-transaction-summary.json", {
      "rounds": [{
        "roundLabel": label,
        "count": 1,
        "successfulTransactions": 1,
        "failedTransactions": 0,
        "latencyMs": {
          "min": 10 + index,
          "mean": 10 + index,
          "p50": 10 + index,
          "p95": 10 + index,
          "p99": 10 + index,
          "max": 10 + index,
        },
      } for index, label in enumerate(labels)],
    })
    (run_dir / "caliper-transactions.jsonl").write_text(
      "".join(
        f"{json.dumps({'roundLabel': label, 'status': 'success', 'latencyMs': 10 + index})}\n"
        for index, label in enumerate(labels)
      ),
      encoding="utf-8",
    )
    suite_path = project / "experiments" / "runs" / "suite" / "suite-manifest.json"
    write_json(suite_path, {
      "status": "completed",
      "axes": [{
        "id": axis_id,
        "title": f"Fixture {axis_id}",
        "xAxis": "Fixture x",
        "points": [{
          "runDirectory": "experiments/runs/fixture-run",
          "roundLabel": labels[index],
          "xValue": index + 1,
          "xLabel": str(index + 1),
        }],
      } for index, axis_id in enumerate(AXES)],
    })
    env = {**os.environ, "CALIPER_LATENCY_PROJECT_DIR": str(project)}
    subprocess.run(
      [sys.executable, str(PLOTTER), "--suite-manifest", str(suite_path)],
      check=True,
      cwd=str(REPO_DIR),
      env=env,
    )
    figure_manifest = project / "results" / "plots" / "caliper-latency" / "figure_manifest.json"
    if not figure_manifest.exists():
      raise AssertionError("fixture plotter did not write figure_manifest.json")
    generated = json.loads(figure_manifest.read_text(encoding="utf-8"))
    if len(generated["figures"]) != 10 or len(generated["tables"]) != 5:
      raise AssertionError("fixture plotter did not emit 5 PNG/PDF pairs and 5 CSVs")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
