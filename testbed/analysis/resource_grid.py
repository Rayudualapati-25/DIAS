#!/usr/bin/env python3
"""One-hour run (E6): CPU and memory of every machine as a grid of small panels.

The top row shows CPU and the bottom row memory for M1-M5. Each panel carries a
subfigure label below it, "(a) Node 1: CPU Usage" and so on, so the whole figure is
one PDF that spans the text width at about a third of a page. M1-M4 come from
node-exporter through the testbed's Prometheus, and M5 (the LLM server on the
Mac) from the Mac sampler. The Prometheus series are saved to --series the
first time, so later runs redraw the figure without the testbed.

Usage: python3 resource_grid.py --run <e6 run dir> --mac-samples <csv> --series <csv> --out <path without extension>
"""

import argparse
import csv
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_e6  # noqa: E402
import figstyle  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.axes import Axes  # noqa: E402

Series = dict[str, list[tuple[float, float]]]  # machine -> [(epoch seconds, value)]
Panel = tuple[list[float], list[float], list[float], list[float]]  # CPU minutes, cores, memory minutes, GB

MACHINES = ["m1", "m2", "m3", "m4", "m5"]
VMS = ["m1", "m2", "m3", "m4"]
WIDTH_IN = figstyle.DOUBLE_WIDTH_IN
HEIGHT_IN = 2.7
# The names of the paper's testbed figure (generic_testbed_layout.png).
NAMES = {"m1": "Node 1", "m2": "Node 2", "m3": "Node 3", "m4": "Application node", "m5": "Model node"}
CAPTION_FONT = {"family": "STIXGeneral", "size": 7.5}
LETTERS = "abcdefghij"


def load_window(run_dir: str) -> tuple[float, float]:
    with open(os.path.join(run_dir, "run.json")) as handle:
        run = json.load(handle)
    return run["startedAt"] / 1000, run["finishedAt"] / 1000


def save_series(path: str, cpu: Series, mem: Series) -> None:
    with open(path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["machine", "metric", "epoch_s", "value"])
        for metric, series in (("cpu_cores", cpu), ("mem_used_bytes", mem)):
            for machine in VMS:
                for t, v in series.get(machine, []):
                    writer.writerow([machine, metric, f"{t:.3f}", repr(v)])


def load_series(path: str) -> tuple[Series, Series]:
    series = {"cpu_cores": {}, "mem_used_bytes": {}}
    with open(path) as handle:
        for row in csv.DictReader(handle):
            series[row["metric"]].setdefault(row["machine"], []).append((float(row["epoch_s"]), float(row["value"])))
    return series["cpu_cores"], series["mem_used_bytes"]


def vm_series(path: str, start_s: float, end_s: float) -> tuple[Series, Series]:
    """Whole-VM CPU (cores) and used memory (bytes), fetched once and then read from the CSV."""
    if not os.path.exists(path):
        cpu, mem = analyze_e6.machine_series(start_s, end_s)
        missing = [m for m in VMS if not cpu.get(m) or not mem.get(m)]
        if missing:
            raise SystemExit(f"Prometheus returned no data for {missing}; nothing was saved")
        save_series(path, cpu, mem)
    return load_series(path)


def panels(cpu: Series, mem: Series, mac_rows: list[dict[str, str]], start_s: float) -> dict[str, Panel]:
    """{machine: (minutes, cpu cores, minutes, memory GB)} for M1-M5."""
    out = {}
    for machine in VMS:
        out[machine] = ([(t - start_s) / 60 for t, _ in cpu[machine]], [v for _, v in cpu[machine]],
                        [(t - start_s) / 60 for t, _ in mem[machine]], [v / 1e9 for _, v in mem[machine]])
    minutes = [(float(r["epoch_s"]) - start_s) / 60 for r in mac_rows]
    out["m5"] = (minutes, [float(r["model_cpu_cores"]) for r in mac_rows],
                 minutes, [float(r["model_rss_bytes"]) / 1e9 for r in mac_rows])
    return out


def nice_top(value: float) -> float:
    """Smallest 1, 2, 4 or 5 times a power of ten that is at least `value`."""
    scale = 10 ** math.floor(math.log10(value))
    return next(m * scale for m in (1, 2, 4, 5, 10) if m * scale >= value)


def draw_panel(ax: Axes, minutes: list[float], values: list[float], color: str, top: float, ylabel: str,
               caption: str) -> None:
    ax.plot(minutes, values, color=color, linewidth=0.6)
    ax.set_xlim(0, 60)
    ax.set_xticks([0, 20, 40, 60])
    ax.set_ylim(0, top)
    ax.set_ylabel(ylabel, labelpad=2)
    ax.set_xlabel("Time (min)", labelpad=1.5)
    ax.text(0.5, -0.44, caption, transform=ax.transAxes, ha="center", va="top", fontdict=CAPTION_FONT)


def plot(data: dict[str, Panel], out: str) -> None:
    figstyle.setup()
    plt.rcParams.update({"xtick.labelsize": 6, "ytick.labelsize": 6, "axes.labelsize": 6.5})
    cpu_top = nice_top(1.1 * max(max(data[m][1]) for m in MACHINES))
    vm_mem_top = nice_top(1.1 * max(max(data[m][3]) for m in VMS))
    mac_mem_top = nice_top(1.1 * max(data["m5"][3]))
    fig, axes = plt.subplots(2, len(MACHINES), figsize=(WIDTH_IN, HEIGHT_IN))
    for col, machine in enumerate(MACHINES):
        name = NAMES[machine]
        cpu_t, cpu_v, mem_t, mem_v = data[machine]
        draw_panel(axes[0][col], cpu_t, cpu_v, figstyle.SERIES[0], cpu_top, "CPU (cores)",
                   f"({LETTERS[col]}) {name}: CPU Usage")
        draw_panel(axes[1][col], mem_t, mem_v, figstyle.SERIES[1], mac_mem_top if machine == "m5" else vm_mem_top,
                   "Memory (GB)", f"({LETTERS[col + len(MACHINES)]}) {name}: Mem. Usage")
    fig.subplots_adjust(left=0.06, right=0.995, top=0.98, bottom=0.17, wspace=0.42, hspace=0.85)
    fig.savefig(f"{out}.pdf", bbox_inches="tight", pad_inches=0.02)
    fig.savefig(f"{out}.png", dpi=300, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--mac-samples", required=True)
    parser.add_argument("--series", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    start_s, end_s = load_window(args.run)
    cpu, mem = vm_series(args.series, start_s, end_s)
    mac_rows = analyze_e6.mac_series(args.mac_samples, start_s, end_s)
    if not mac_rows:
        raise SystemExit("no Mac samples inside the run window")
    data = panels(cpu, mem, mac_rows, start_s)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    plot(data, args.out)
    for machine in MACHINES:
        _, cpu_v, _, mem_v = data[machine]
        print(f"{machine}: CPU mean {sum(cpu_v) / len(cpu_v):.2f}, max {max(cpu_v):.2f} cores; "
              f"memory max {max(mem_v):.2f} GB; {len(cpu_v)} CPU samples")


if __name__ == "__main__":
    main()
