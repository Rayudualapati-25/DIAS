#!/usr/bin/env python3
"""Figure for the ledger-growth experiment.

Reads ledger_growth.json (unindexed baseline) and, if present,
ledger_growth_indexed.json (after CouchDB indexes are deployed).

Log-log axes are deliberate: on them a flat operation has slope 0 and an
operation whose cost is linear in collection size has slope 1, so the two
regimes are separable by eye rather than by assertion.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).parent

SERIES = (
    ("pointRead", "point read  (getState)", "o", "#1f77b4"),
    ("decision", "access decision  (point reads + commit)", "^", "#9467bd"),
    ("auditTrail", "audit trail  (scoped range scan)", "v", "#8c564b"),
    ("accessLog", "access log  (full range scan)", "s", "#2ca02c"),
    ("richQuery", "record search  (rich query, no index)", "D", "#d62728"),
)


def load(name: str) -> dict | None:
    path = HERE / name
    if not path.exists():
        return None
    with path.open() as handle:
        return json.load(handle)


def slope(xs: list[float], ys: list[float]) -> float:
    """Least-squares slope in log-log space: the scaling exponent."""
    import math
    lx = [math.log10(x) for x in xs]
    ly = [math.log10(y) for y in ys]
    n = len(lx)
    mx, my = sum(lx) / n, sum(ly) / n
    num = sum((a - mx) * (b - my) for a, b in zip(lx, ly))
    den = sum((a - mx) ** 2 for a in lx)
    return num / den if den else 0.0


def main() -> None:
    base = load("ledger_growth.json")
    if base is None:
        raise SystemExit("ledger_growth.json not found — run ledger_growth.js first")
    indexed = load("ledger_growth_indexed.json")

    points = base["points"]
    x = [p["recordCount"] for p in points]

    has_index_arm = indexed is not None
    fig, axes = plt.subplots(
        1, 2 if has_index_arm else 1,
        figsize=(11.5, 4.4) if has_index_arm else (7.2, 4.8),
    )
    ax = axes[0] if has_index_arm else axes

    # A null is an operation that failed every sample. It is plotted as a gap
    # with an explicit failure marker, never as a value, and it is excluded
    # from the fitted slope so a timeout cannot flatten the trend.
    timed_out: list[tuple[float, float]] = []
    print(f"{'operation':<40} {'slope':>7}  {'first':>9} {'last':>9}  failed")
    for key, label, marker, colour in SERIES:
        pairs = [(p["recordCount"], p["operations"][key]["p50Ms"]) for p in points]
        good = [(a, b) for a, b in pairs if b is not None]
        failed_at = [a for a, b in pairs if b is None]
        gx = [a for a, _ in good]
        gy = [b for _, b in good]
        ax.plot(gx, gy, marker=marker, color=colour, linewidth=1.8,
                markersize=6, label=label)
        if failed_at and gy:
            # Mark where the operation stopped returning results at all. The
            # explanatory text is drawn once, after the loop, so overlapping
            # per-series labels cannot pile up on the same point.
            ax.scatter(failed_at, [gy[-1]] * len(failed_at), marker="x",
                       s=90, color=colour, linewidths=2.2, zorder=5)
            timed_out.append((failed_at[0], gy[-1]))
        s = slope(gx, gy) if len(good) > 1 else float("nan")
        note = f"  from {failed_at[0]:,}" if failed_at else ""
        print(f"{label:<40} {s:>7.2f}  {gy[0]:>8.1f}ms {gy[-1]:>8.1f}ms{note}")

    if timed_out:
        first_x = min(p[0] for p in timed_out)
        top_y = max(p[1] for p in timed_out)
        ax.annotate(
            "x  exceeds the 5 s query deadline\n     (no result returned)",
            xy=(first_x, top_y), xytext=(-14, 30), textcoords="offset points",
            fontsize=8.5, color="#444444", ha="right",
            arrowprops=dict(arrowstyle="->", color="#444444", linewidth=1),
        )

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("records in the ledger")
    ax.set_ylabel("median latency (ms)")
    ax.set_title("(a) Latency vs ledger size" if has_index_arm
                 else "Latency vs ledger size")
    ax.grid(True, which="both", alpha=0.25)
    ax.set_xticks(x)
    ax.set_xticklabels([f"{v // 1000}k" if v >= 1000 else str(v) for v in x])
    ax.legend(frameon=False, fontsize=8, loc="upper left")

    if has_index_arm:
        ax2 = axes[1]
        ipoints = indexed["points"]
        ix = [p["recordCount"] for p in ipoints]
        before = [p["operations"]["richQuery"]["p50Ms"] for p in points
                  if p["recordCount"] in set(ix)]
        after = [p["operations"]["richQuery"]["p50Ms"] for p in ipoints]

        width = 0.38
        pos = range(len(ix))
        ax2.bar([p - width / 2 for p in pos], before, width,
                label="no index", color="#d62728")
        ax2.bar([p + width / 2 for p in pos], after, width,
                label="CouchDB index", color="#2ca02c")
        ax2.set_xticks(list(pos))
        ax2.set_xticklabels([f"{v // 1000}k" if v >= 1000 else str(v) for v in ix])
        ax2.set_xlabel("records in the ledger")
        ax2.set_ylabel("median search latency (ms)")
        ax2.set_title("(b) Effect of a state-database index")
        ax2.grid(True, axis="y", alpha=0.25)
        ax2.legend(frameon=False, fontsize=9)
        for i, (b, a) in enumerate(zip(before, after)):
            if a:
                ax2.annotate(f"{b / a:.0f}x", xy=(i, max(b, a)),
                             ha="center", va="bottom", fontsize=8.5)

    fig.suptitle(
        "Ledger growth on the live 5-organisation Fabric network "
        f"(median of {base['method']['repetitions']} repetitions)",
        fontsize=10.5,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    out = HERE / "ledger_growth.png"
    fig.savefig(out, dpi=200)
    fig.savefig(HERE / "ledger_growth.pdf")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
