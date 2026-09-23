#!/usr/bin/env python3
"""Generate vector figures directly from a retained UI-latency run report."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.ticker import AutoMinorLocator, MaxNLocator


COLORS = {"p50": "#000000", "p95": "#555555"}
OPERATION_LABELS = {
    "search": "Search case files",
    "submit": "Submit case file",
    "release": "Open authorized file",
}
PANEL_LABELS = {"search": "(a)", "submit": "(b)", "release": "(c)"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configure_style() -> None:
    """Plain typeset-journal styling: serif text, boxed axes, inward ticks."""
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Times New Roman", "Times", "STIXGeneral", "DejaVu Serif"],
        "mathtext.fontset": "stix",
        "font.size": 7.4,
        "axes.titlesize": 7.6,
        "axes.labelsize": 7.4,
        "xtick.labelsize": 7.0,
        "ytick.labelsize": 7.0,
        "legend.fontsize": 7.0,
        "axes.linewidth": 0.5,
        "axes.edgecolor": "black",
        "axes.labelcolor": "black",
        "text.color": "black",
        "xtick.color": "black",
        "ytick.color": "black",
        "xtick.direction": "in",
        "ytick.direction": "in",
        "xtick.top": True,
        "ytick.right": True,
        "xtick.major.size": 2.6,
        "ytick.major.size": 2.6,
        "xtick.minor.size": 1.4,
        "ytick.minor.size": 1.4,
        "xtick.major.width": 0.5,
        "ytick.major.width": 0.5,
        "xtick.minor.width": 0.4,
        "ytick.minor.width": 0.4,
        "lines.linewidth": 0.9,
        "lines.markersize": 3.2,
        "lines.markeredgewidth": 0.7,
        "legend.frameon": True,
        "legend.framealpha": 1.0,
        "legend.edgecolor": "black",
        "legend.fancybox": False,
        "legend.borderpad": 0.35,
        "legend.handlelength": 2.4,
        "legend.handletextpad": 0.5,
        "legend.labelspacing": 0.28,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.03,
    })


def rows_for(report: dict, operation: str) -> list[dict]:
    rows = [row for row in report["summary"] if row["operation"] == operation]
    return sorted(rows, key=lambda row: row["concurrentSessions"])


def draw_panel(axis, rows: list[dict], operation: str, panel_label: bool = True) -> None:
    x = [row["concurrentSessions"] for row in rows]
    p50 = [row["p50Ms"] for row in rows]
    p95 = [row["p95Ms"] for row in rows]
    axis.plot(x, p50, color=COLORS["p50"], marker="o", markerfacecolor="white",
              linestyle="-", clip_on=False, zorder=3, label="Median (p50)")
    axis.plot(x, p95, color=COLORS["p95"], marker="s", markerfacecolor="white",
              linestyle="--", dashes=(3.2, 1.6), clip_on=False, zorder=3,
              label="p95")
    title = OPERATION_LABELS[operation]
    if panel_label:
        title = f"{PANEL_LABELS[operation]} {title}"
    axis.set_title(title, pad=3.5)
    axis.set_xlabel("Concurrent client sessions")
    axis.set_ylabel("Latency (ms)")
    axis.set_xticks(x)
    axis.yaxis.set_major_locator(MaxNLocator(nbins=5, min_n_ticks=4))
    axis.yaxis.set_minor_locator(AutoMinorLocator(2))
    axis.grid(axis="y", color="black", linestyle=":", linewidth=0.35, alpha=0.3,
              zorder=0)
    axis.set_axisbelow(True)
    axis.set_xmargin(0.07)
    axis.set_ylim(0, max(p95) * 1.12)


def save_figure(fig, base: Path) -> list[Path]:
    paths = [base.with_suffix(".pdf"), base.with_suffix(".png")]
    fig.savefig(paths[0])
    fig.savefig(paths[1], dpi=300)
    plt.close(fig)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path, help="experiments/runs/.../run-report.json")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    report = json.loads(args.report.read_text(encoding="utf-8"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    configure_style()
    outputs: list[Path] = []

    for operation in ("search", "submit", "release"):
        fig, axis = plt.subplots(figsize=(3.25, 2.08))
        draw_panel(axis, rows_for(report, operation), operation, panel_label=False)
        axis.legend(loc="upper left", borderaxespad=0.4).get_frame().set_linewidth(0.5)
        fig.tight_layout(pad=0.45)
        outputs.extend(save_figure(fig, args.output_dir / f"{operation}_latency"))

    fig, axes = plt.subplots(1, 3, figsize=(7.0, 2.02))
    for axis, operation in zip(axes, ("search", "submit", "release")):
        draw_panel(axis, rows_for(report, operation), operation)
    handles, labels = axes[0].get_legend_handles_labels()
    legend = fig.legend(handles, labels, ncol=2, loc="upper center",
                        bbox_to_anchor=(0.5, 1.02), columnspacing=1.6)
    legend.get_frame().set_linewidth(0.5)
    fig.tight_layout(rect=(0, 0, 1, 0.91), w_pad=1.05)
    outputs.extend(save_figure(fig, args.output_dir / "interactive_latency_three_panel"))

    repository_root = Path(__file__).resolve().parent.parent
    try:
        generated_from = str(args.report.resolve().relative_to(repository_root))
    except ValueError:
        generated_from = str(args.report.resolve())

    manifest = {
        "generatedFrom": generated_from,
        "inputSha256": sha256(args.report),
        "runId": report["runId"],
        "metric": "client-observed HTTP latency in milliseconds",
        "curves": ["pooled p50", "pooled p95"],
        "pointSampling": "three simultaneous-request batches; 3N samples per point",
        "outputs": {
            path.name: {"sha256": sha256(path), "bytes": path.stat().st_size}
            for path in outputs
        },
    }
    (args.output_dir / "figure-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
