"""Shared figure style for the testbed results (IEEE single column).

Colors come from the validated categorical palette in fixed order and are never
cycled; every series also carries a hatch pattern, so the figures stay readable
in grayscale print and for color-blind readers. Values are printed on the marks
in ink colors, never in the series color, and every axis is in real units.
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
HATCHES = ["", "///", "...", "xxx", "\\\\\\", "---", "+++", "ooo"]
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#d9d8d4"
SURFACE = "#ffffff"
COLUMN_WIDTH_IN = 3.5
DOUBLE_WIDTH_IN = 7.16


def setup():
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 7.5,
        "axes.titlesize": 8,
        "axes.labelsize": 7.5,
        "xtick.labelsize": 7,
        "ytick.labelsize": 7,
        "legend.fontsize": 6.8,
        "axes.edgecolor": INK_2,
        "axes.linewidth": 0.6,
        "axes.labelcolor": INK,
        "xtick.color": INK_2,
        "ytick.color": INK_2,
        "xtick.major.width": 0.6,
        "ytick.major.width": 0.6,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "grid.color": GRID,
        "grid.linewidth": 0.5,
        "axes.axisbelow": True,
        "legend.frameon": False,
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "hatch.linewidth": 0.5,
        "hatch.color": "#ffffff",
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })


def figure(width=COLUMN_WIDTH_IN, height=2.3, ncols=1, nrows=1, **kwargs):
    setup()
    return plt.subplots(nrows=nrows, ncols=ncols, figsize=(width, height), **kwargs)


def label_bars(ax, bars, fmt="{:.2f}", inside=False, size=6.2, color=INK):
    """Print each bar's exact value at its end (or centred inside a segment)."""
    for bar in bars:
        height = bar.get_height()
        if height is None or height != height:  # NaN
            continue
        x = bar.get_x() + bar.get_width() / 2
        if inside:
            if height <= 0:
                continue
            y = bar.get_y() + height / 2
            ax.text(x, y, fmt.format(height), ha="center", va="center", fontsize=size, color=color)
        else:
            ax.annotate(fmt.format(height), (x, bar.get_y() + height), xytext=(0, 1.5),
                        textcoords="offset points", ha="center", va="bottom", fontsize=size, color=color)


def save(fig, path_without_ext):
    fig.tight_layout(pad=0.4)
    fig.savefig(f"{path_without_ext}.pdf", bbox_inches="tight")
    fig.savefig(f"{path_without_ext}.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
