#!/usr/bin/env python3
"""Capacity of each component in one unit (operations per minute), from E3, E4, E5.

The whole workflow cannot run faster than its slowest component; this figure
puts the components side by side so the bottleneck is visible. The value axis is
logarithmic because the components differ by orders of magnitude; every bar
carries its exact value.

Usage: python3 capacity_figure.py --analysis <run>/analysis
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", required=True)
    args = parser.parse_args()
    a = args.analysis
    e3 = json.load(open(os.path.join(a, "e3", "e3-summary.json")))
    e4 = json.load(open(os.path.join(a, "e4", "e4-summary.json")))
    e5 = json.load(open(os.path.join(a, "e5", "e5-summary.json")))
    best = lambda rnd: max(s["throughputPerS"] for s in e3 if s["round"] == rnd) * 60
    rows = [
        ("Read one request (ledger)", best("R1 GetRequest")),
        ("Create request (ledger write)", best("W1 CreateAccessRequest")),
        ("Auditor decision (ledger write)", best("W2 SubmitAuditorDecision")),
        ("Decision log, newest 50 (ledger read)", best("R2 QueryAccessDecisions")),
        ("LLM recommendation (model alone)", e4["recommendations_per_min"]),
        ("Whole approval/deny workflow (100 users)", e5[-1]["throughput_workflows_per_min"]["mean"]),
    ]
    rows.sort(key=lambda r: r[1])
    fig, ax = figstyle.figure(height=2.3)
    y = list(range(len(rows)))
    colors = [figstyle.SERIES[1] if "LLM" in n or "workflow" in n else figstyle.SERIES[0] for n, _ in rows]
    bars = ax.barh(y, [v for _, v in rows], height=0.6, color=colors, edgecolor="white")
    for bar, (_, v) in zip(bars, rows):
        ax.annotate(f"{v:,.1f}" if v < 100 else f"{v:,.0f}", (v, bar.get_y() + bar.get_height() / 2), xytext=(3, 0),
                    textcoords="offset points", va="center", fontsize=6.0, color=figstyle.INK)
    ax.set_xscale("log")
    ax.set_yticks(y)
    ax.set_yticklabels([n for n, _ in rows], fontsize=6.3)
    ax.set_xlabel("Operations per minute (log scale)")
    ax.set_xlim(1, max(v for _, v in rows) * 8)
    ax.grid(axis="x", color=figstyle.GRID, linewidth=0.5)
    ax.grid(axis="y", visible=False)
    out = os.path.join(a, "capacity")
    os.makedirs(out, exist_ok=True)
    json.dump([{"component": n, "per_minute": v} for n, v in rows], open(os.path.join(out, "capacity.json"), "w"), indent=2)
    figstyle.save(fig, os.path.join(out, "capacity_by_component"))
    for n, v in rows:
        print(f"{n}: {v:.1f}/min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
