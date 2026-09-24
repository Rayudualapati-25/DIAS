"""Shared plotting style and helpers for the SEAL paper figures.

Every figure is built from the experiment result JSON. No metric is written into
plotting code: if a number appears on an axis it was read from a result file, so
a figure can never drift away from the run that produced it.
"""

import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

RESULTS = pathlib.Path(__file__).resolve().parent.parent / "results"
FIGURES = RESULTS / "figures"
TABLES = RESULTS / "tables"

# IEEE two-column geometry, in inches.
COL = 3.45
WIDE = 7.16

# Colourblind-safe (Okabe-Ito). Decision classes keep the same colour in every
# figure so a reader can carry the mapping from one plot to the next.
INK = "#1a1a1a"
GRID = "#d9d9d9"
DECISION = {
    "allow": "#009E73",
    "deny": "#D55E00",
    "escalate": "#0072B2",
    "invalid": "#8c8c8c",
}
ARM = {
    "v6": "#0072B2",
    "v4": "#E69F00",
    "v4short": "#CC79A7",
    "with": "#009E73",
    "without": "#D55E00",
}


def apply_style():
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["DejaVu Serif", "Times New Roman", "STIXGeneral"],
        "mathtext.fontset": "dejavuserif",
        "font.size": 8,
        "axes.titlesize": 8.5,
        "axes.labelsize": 8,
        "xtick.labelsize": 7.5,
        "ytick.labelsize": 7.5,
        "legend.fontsize": 7.5,
        "figure.dpi": 150,
        "savefig.dpi": 400,
        "axes.edgecolor": INK,
        "axes.labelcolor": INK,
        "text.color": INK,
        "xtick.color": INK,
        "ytick.color": INK,
        "axes.linewidth": 0.6,
        "xtick.major.width": 0.6,
        "ytick.major.width": 0.6,
        "axes.grid": True,
        "grid.color": GRID,
        "grid.linewidth": 0.5,
        "grid.alpha": 0.9,
        "axes.axisbelow": True,
        "legend.frameon": False,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.02,
    })


def load(name):
    """Load a result file, or return None when that experiment has not run."""
    path = RESULTS / name
    if not path.exists():
        return None
    return json.loads(path.read_text())


def save(fig, stem):
    """Write both the vector PDF for LaTeX and a high-resolution PNG."""
    FIGURES.mkdir(parents=True, exist_ok=True)
    for ext in ("pdf", "png"):
        fig.savefig(FIGURES / f"{stem}.{ext}")
    plt.close(fig)
    print(f"  figure  {stem}.pdf + .png")


def write_table(stem, header, rows):
    """Write a table as CSV, and as a LaTeX booktabs body for direct \\input."""
    TABLES.mkdir(parents=True, exist_ok=True)
    csv_path = TABLES / f"{stem}.csv"
    with csv_path.open("w") as fh:
        fh.write(",".join(str(c) for c in header) + "\n")
        for row in rows:
            cells = []
            for cell in row:
                text = "" if cell is None else str(cell)
                cells.append(f'"{text}"' if ("," in text or '"' in text) else text)
            fh.write(",".join(cells) + "\n")

    tex_path = TABLES / f"{stem}.tex"
    with tex_path.open("w") as fh:
        fh.write("% Generated from experiment result JSON. Do not edit by hand.\n")
        fh.write("\\toprule\n")
        fh.write(" & ".join(_tex(c) for c in header) + " \\\\\n\\midrule\n")
        for row in rows:
            fh.write(" & ".join(_tex("" if c is None else c) for c in row) + " \\\\\n")
        fh.write("\\bottomrule\n")
    print(f"  table   {stem}.csv + .tex  ({len(rows)} rows)")


def _tex(value):
    text = str(value)
    for old, new in (("&", "\\&"), ("%", "\\%"), ("_", "\\_"), ("#", "\\#")):
        text = text.replace(old, new)
    return text


def pct(value, digits=1):
    """Proportion to percentage text, or an em dash when undefined."""
    if value is None:
        return "--"
    return f"{value * 100:.{digits}f}"


def num(value, digits=4):
    return "--" if value is None else f"{value:.{digits}f}"


def bar_labels(ax, bars, values, fmt="{:.1f}", dy=1.0):
    for bar, value in zip(bars, values):
        if value is None:
            continue
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + dy,
                fmt.format(value), ha="center", va="bottom", fontsize=7)
