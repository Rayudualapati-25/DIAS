#!/usr/bin/env python3
"""Build retained comparison tables and an SVG plot from evaluation JSON files."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TABLE_DIR = ROOT / "results/tables/qwen3-policy-engine"
DEFAULT_PLOT_DIR = ROOT / "results/plots/qwen3-policy-engine"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_run(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("--run must be LABEL=PATH")
    label, raw_path = value.split("=", 1)
    if not label.strip() or not raw_path.strip():
        raise argparse.ArgumentTypeError("--run must contain a label and path")
    return label.strip(), (ROOT / raw_path).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="append", type=parse_run, required=True)
    parser.add_argument("--table-dir", default=str(DEFAULT_TABLE_DIR))
    parser.add_argument("--plot-dir", default=str(DEFAULT_PLOT_DIR))
    return parser.parse_args()


def percent(value: float | None) -> str:
    return "—" if value is None else f"{100 * value:.2f}%"


def svg_chart(rows: list[dict]) -> str:
    width = 1080
    height = 130 + 95 * len(rows)
    chart_left = 320
    chart_width = 700
    colors = {
        "decisionAccuracy": "#2563eb",
        "jointDecisionReasonAccuracy": "#059669",
        "falseAllowRateAmongNonAllow": "#dc2626",
    }
    labels = {
        "decisionAccuracy": "Decision accuracy",
        "jointDecisionReasonAccuracy": "Joint decision + reason",
        "falseAllowRateAmongNonAllow": "False allow rate",
    }
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="white"/>',
        '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#111827}.title{font-size:22px;font-weight:700}.label{font-size:15px}.small{font-size:13px;fill:#4b5563}.value{font-size:12px;font-weight:600}</style>',
        '<text x="30" y="36" class="title">Qwen3-14B policy-engine evaluation</text>',
        '<text x="30" y="61" class="small">Held-out synthetic policy cases; higher is better except false allow rate.</text>',
    ]
    for tick in range(0, 101, 20):
        x = chart_left + chart_width * tick / 100
        svg.append(f'<line x1="{x:.1f}" y1="78" x2="{x:.1f}" y2="{height - 30}" stroke="#e5e7eb"/>')
        svg.append(f'<text x="{x:.1f}" y="75" text-anchor="middle" class="small">{tick}%</text>')

    for index, row in enumerate(rows):
        y = 102 + index * 95
        svg.append(f'<text x="30" y="{y + 26}" class="label">{html.escape(row["label"])}</text>')
        for offset, key in enumerate(colors):
            value = row[key]
            bar_y = y + offset * 21
            bar_width = chart_width * value
            svg.append(
                f'<rect x="{chart_left}" y="{bar_y}" width="{bar_width:.1f}" height="14" rx="2" fill="{colors[key]}"/>'
            )
            value_x = min(chart_left + bar_width + 6, width - 42)
            svg.append(f'<text x="{value_x:.1f}" y="{bar_y + 12}" class="value">{100 * value:.1f}%</text>')

    legend_x = 30
    legend_y = height - 20
    for key in colors:
        svg.append(f'<rect x="{legend_x}" y="{legend_y - 11}" width="13" height="13" fill="{colors[key]}"/>')
        svg.append(f'<text x="{legend_x + 19}" y="{legend_y}" class="small">{labels[key]}</text>')
        legend_x += 220
    svg.append("</svg>")
    return "\n".join(svg) + "\n"


def main() -> None:
    args = parse_args()
    table_dir = Path(args.table_dir).resolve()
    plot_dir = Path(args.plot_dir).resolve()
    table_dir.mkdir(parents=True, exist_ok=True)
    plot_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    sources = []
    for label, path in args.run:
        report = json.loads(path.read_text())
        metrics = report["metrics"]
        rows.append(
            {
                "label": label,
                "n": metrics["n"],
                "schemaValidRate": metrics["schemaValidRate"],
                "decisionDisagreementRate": metrics.get("decisionDisagreementRate", 0),
                "decisionAccuracy": metrics["decisionAccuracy"],
                "decisionMacroF1": metrics.get("decisionMacroF1"),
                "reasonAccuracy": metrics["reasonAccuracy"],
                "reasonMacroF1": metrics.get("reasonMacroF1"),
                "jointDecisionReasonAccuracy": metrics["jointDecisionReasonAccuracy"],
                "falseAllowRateAmongNonAllow": metrics["falseAllowRateAmongNonAllow"],
                "falseAllowCount": metrics["falseAllowCount"],
                "expectedNonAllowCount": metrics["expectedNonAllowCount"],
                "adversarialJointAccuracy": metrics["adversarialJointAccuracy"],
                "medianLatencyMs": metrics["latencyMs"]["median"],
                "p95LatencyMs": metrics["latencyMs"]["p95"],
            }
        )
        sources.append(
            {
                "label": label,
                "path": display_path(path),
                "sha256": sha256(path),
                "config": report["config"],
            }
        )

    csv_path = table_dir / "metrics.csv"
    with csv_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    markdown_path = table_dir / "metrics.md"
    lines = [
        "# Qwen3-14B policy-engine evaluation",
        "",
        "All rows use the retained held-out synthetic policy suite. False allow is measured only among oracle non-allow cases.",
        "",
        "| Arm | n | Schema valid | Decision/reason disagreement | Decision | Decision macro-F1 | Reason | Reason macro-F1 | Joint | False allow | Adversarial joint | Median latency | p95 latency |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f'| {row["label"]} | {row["n"]} | {percent(row["schemaValidRate"])} | '
            f'{percent(row["decisionDisagreementRate"])} | '
            f'{percent(row["decisionAccuracy"])} | {percent(row["decisionMacroF1"])} | '
            f'{percent(row["reasonAccuracy"])} | {percent(row["reasonMacroF1"])} | '
            f'{percent(row["jointDecisionReasonAccuracy"])} | '
            f'{row["falseAllowCount"]}/{row["expectedNonAllowCount"]} '
            f'({percent(row["falseAllowRateAmongNonAllow"])}) | '
            f'{percent(row["adversarialJointAccuracy"])} | '
            f'{row["medianLatencyMs"]:.1f} ms | {row["p95LatencyMs"]:.1f} ms |'
        )
    markdown_path.write_text("\n".join(lines) + "\n")

    plot_path = plot_dir / "policy_engine_comparison.svg"
    plot_path.write_text(svg_chart(rows))

    manifest_path = table_dir / "artifact_manifest.json"
    manifest = {
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "generator": "experiments/llm_policy_engine/summarize_results.py",
        "sources": sources,
        "artifacts": [],
    }
    for path in (csv_path, markdown_path, plot_path):
        manifest["artifacts"].append(
            {"path": display_path(path), "sha256": sha256(path)}
        )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
