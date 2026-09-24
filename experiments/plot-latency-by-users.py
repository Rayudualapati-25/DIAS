#!/usr/bin/env python3
"""Single-panel response time against concurrent distinct users.

One line per measured operation. The y value is the mean client-observed
response time of the requests issued at that user count, computed here from the
retained per-request samples rather than read from a summary file.

Search and submission come from the primary distinct-user sweep. The authorized
open comes from the per-user-record release layout, matching the layout the
manuscript reports for that operation.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.ticker import AutoMinorLocator, MaxNLocator

ROOT = Path(__file__).resolve().parent.parent
PRIMARY_RUN = ROOT / "experiments" / "runs" / \
    "2026-08-28T04-15-05-267Z_ui_unique_user_latency" / "raw-samples.jsonl"
ABLATION_RUN = ROOT / "experiments" / "runs" / \
    "2026-08-28T04-18-28-093Z_ui_unique_user_release_layout_ablation" / \
    "raw-samples.jsonl"
OUTPUT_BASE = ROOT / "results" / "plots" / "ui-unique-user-latency" / \
    "latency_by_users"

SERIES = [
    ("search", PRIMARY_RUN, "Search case files", "o", "-", "#000000"),
    ("submit", PRIMARY_RUN, "Submit case file", "s", "--", "#000000"),
    ("release-per-user-record", ABLATION_RUN, "Open authorized file", "^", "-.",
     "#555555"),
]

SUFFIX = {
    "search": "search_by_users",
    "submit": "submit_by_users",
    "release-per-user-record": "open_by_users",
}


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


def read_samples(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def user_count(sample: dict) -> int:
    """Runners name the level differently; accept either key."""
    if "concurrentUsers" in sample:
        return sample["concurrentUsers"]
    return sample["concurrentSessions"]


def mean_by_user_count(samples: list[dict], operation: str) -> dict[int, float]:
    grouped: dict[int, list[float]] = {}
    for sample in samples:
        if sample["operation"] != operation or not sample.get("ok"):
            continue
        grouped.setdefault(user_count(sample), []).append(sample["elapsedMs"])
    return {count: sum(values) / len(values)
            for count, values in sorted(grouped.items())}


def style_axis(axis, levels: list[int], highest: float) -> None:
    axis.set_xlabel("Concurrent distinct users")
    axis.set_ylabel("Response time (ms)")
    axis.set_xticks(levels)
    axis.yaxis.set_major_locator(MaxNLocator(nbins=5, min_n_ticks=4))
    axis.yaxis.set_minor_locator(AutoMinorLocator(2))
    axis.grid(axis="y", color="black", linestyle=":", linewidth=0.35,
              alpha=0.3, zorder=0)
    axis.set_axisbelow(True)
    axis.set_xmargin(0.07)
    axis.set_ylim(0, highest * 1.16)


def build_combined(series: list[tuple]) -> tuple:
    figure, axis = plt.subplots(figsize=(3.33, 2.35))
    highest = 0.0
    levels: list[int] = []
    for operation, source, label, marker, style, color in series:
        means = mean_by_user_count(read_samples(source), operation)
        levels = list(means)
        axis.plot(levels, list(means.values()), color=color, marker=marker,
                  markerfacecolor="white", linestyle=style, clip_on=False,
                  zorder=3, label=label)
        highest = max(highest, max(means.values()))
    style_axis(axis, levels, highest)
    axis.legend(loc="upper left")
    return figure, axis


def build_single(operation: str, source: Path, label: str, marker: str) -> tuple:
    """One operation per figure, sized so three sit side by side unscaled."""
    means = mean_by_user_count(read_samples(source), operation)
    figure, axis = plt.subplots(figsize=(2.30, 1.95))
    axis.plot(list(means), list(means.values()), color="#000000", marker=marker,
              markerfacecolor="white", linestyle="-", clip_on=False, zorder=3)
    axis.set_title(label, pad=3.5)
    style_axis(axis, list(means), max(means.values()))
    print(f"{label:22s}" + "  ".join(
        f"{c}:{v:7.2f}" for c, v in means.items()))
    return figure, axis


def build_panels(series: list[tuple]) -> tuple:
    """All three operations in one full-text-width figure, own y scale each."""
    labels = ["(a)", "(b)", "(c)"]
    figure, axes = plt.subplots(1, 3, figsize=(6.9, 2.05))
    for axis, panel, (operation, source, label, marker, _s, _c) in zip(
            axes, labels, series):
        means = mean_by_user_count(read_samples(source), operation)
        axis.plot(list(means), list(means.values()), color="#000000",
                  marker=marker, markerfacecolor="white", linestyle="-",
                  clip_on=False, zorder=3)
        axis.set_title(f"{panel} {label}", pad=3.5)
        style_axis(axis, list(means), max(means.values()))
    figure.tight_layout(pad=0.4, w_pad=1.4)
    return figure, axes


def save(figure, base: Path) -> None:
    base.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(base.with_suffix(".pdf"))
    figure.savefig(base.with_suffix(".png"), dpi=300)
    plt.close(figure)
    print(f"wrote {base.with_suffix('.pdf').relative_to(ROOT)}")


def main() -> None:
    configure_style()
    for operation, source, label, marker, _style, _color in SERIES:
        figure, _ = build_single(operation, source, label, marker)
        save(figure, OUTPUT_BASE.parent / f"latency_{SUFFIX[operation]}")
    figure, _ = build_panels(SERIES)
    save(figure, OUTPUT_BASE.parent / "latency_three_panel_by_users")
    figure, _ = build_combined(SERIES)
    save(figure, OUTPUT_BASE)


if __name__ == "__main__":
    main()
