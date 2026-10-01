#!/usr/bin/env python3
"""Single-column, two-panel candidates for the paper's results figures.

The supervisor asked for two related graphs to share one IEEE column instead of
one graph per column, for line thickness and style to carry the series, and for
a readable CPU-usage graph. Every series here differs by line style and marker
as well as colour, so the figures survive grayscale print. Node names follow the
paper's testbed figure (Node 1-3, Application node, Model node).

Figures written to --out:
  pair_resources   (a) CPU of each node, (b) memory of each node   [E6, one hour]
  pair_performance (a) ledger operations vs clients, (b) whole system vs users  [E3, E4, E5]
  reuse_rounds     cumulative reviews avoided and unapproved grants per round   [reuse run]

Usage: python3 paper_pairs.py --repo <DIAS repo root> --out <folder>
"""

import argparse
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

TESTBED_RUN = "experiments/runs/20260924_testbed_multivm"
E6_RUN = f"{TESTBED_RUN}/raw/e6-steady-20260925T023853Z"
E6_SERIES = f"{TESTBED_RUN}/analysis/e6/e6-machines-series.csv"
MAC_SAMPLES = f"{TESTBED_RUN}/raw/mac/mac-samples.csv"
E3_FUNCTIONS = f"{TESTBED_RUN}/analysis/e3/e3-functions.csv"
E5_LEVELS = f"{TESTBED_RUN}/analysis/e5/e5-levels.csv"
E4_MODEL_OPS_PER_S = 0.121  # Table X, model row; one recommendation at a time (E4)
REUSE_CONDITIONS = "experiments/runs/20260925_reuse_100_users/analysis/reuse-conditions.csv"

NODES = ["m1", "m2", "m3", "m4", "m5"]
NAMES = {"m1": "Node 1", "m2": "Node 2", "m3": "Node 3", "m4": "Application node", "m5": "Model node"}
# Line style, marker and width per node: distinguishable without colour.
STYLE = {
    "m1": dict(linestyle="-", marker="o", linewidth=1.0),
    "m2": dict(linestyle="--", marker="s", linewidth=1.0),
    "m3": dict(linestyle=":", marker="^", linewidth=1.3),
    "m4": dict(linestyle="-.", marker="D", linewidth=1.0),
    "m5": dict(linestyle="-", marker="v", linewidth=1.8),
}
BIN_S = 60  # CPU is plotted as one-minute means of the 5 s samples
MARK_EVERY_MIN = 10


def read_csv(path):
    with open(path) as handle:
        return list(csv.DictReader(handle))


def minute_means(points, start_s, end_s):
    """[(epoch s, value)] -> ([minute centre], [mean]) in one-minute bins."""
    bins = {}
    for t, v in points:
        if start_s <= t <= end_s:
            bins.setdefault(int((t - start_s) // BIN_S), []).append(v)
    keys = sorted(bins)
    return [k + 0.5 for k in keys], [sum(bins[k]) / len(bins[k]) for k in keys]


def resource_series(repo):
    with open(os.path.join(repo, E6_RUN, "run.json")) as handle:
        run = json.load(handle)
    start_s, end_s = run["startedAt"] / 1000, run["finishedAt"] / 1000
    cpu, mem = {}, {}
    for row in read_csv(os.path.join(repo, E6_SERIES)):
        target = cpu if row["metric"] == "cpu_cores" else mem
        target.setdefault(row["machine"], []).append((float(row["epoch_s"]), float(row["value"])))
    mac = [r for r in read_csv(os.path.join(repo, MAC_SAMPLES)) if start_s <= float(r["epoch_s"]) <= end_s]
    cpu["m5"] = [(float(r["epoch_s"]), float(r["model_cpu_cores"])) for r in mac]
    # Model node memory is the GPU memory in use: the weights live there, not in the process RSS.
    mem["m5"] = [(float(r["epoch_s"]), float(r["gpu_in_use_memory_bytes"])) for r in mac]
    gpu_util = [float(r["gpu_utilization_pct"]) for r in mac]
    out = {}
    for node in NODES:
        out[node] = (minute_means(cpu[node], start_s, end_s),
                     minute_means([(t, v / 1e9) for t, v in mem[node]], start_s, end_s))
    return out, sum(gpu_util) / len(gpu_util)


def styled(ax, x, y, node, color):
    every = max(1, int(MARK_EVERY_MIN * 60 / BIN_S))
    ax.plot(x, y, color=color, markersize=3, markevery=every, markerfacecolor="white",
            markeredgewidth=0.8, label=NAMES[node], **STYLE[node])


def pair_resources(repo, out):
    data, gpu_util = resource_series(repo)
    fig, (ax_cpu, ax_mem) = figstyle.figure(height=3.9, nrows=2)
    for i, node in enumerate(NODES):
        (cx, cy), (mx, my) = data[node]
        styled(ax_cpu, cx, cy, node, figstyle.SERIES[i])
        styled(ax_mem, mx, my, node, figstyle.SERIES[i])
    for ax in (ax_cpu, ax_mem):
        ax.set_xlim(0, 61)
        ax.set_xticks(range(0, 61, 10))
        ax.set_xlabel("Time (min)", labelpad=1)
    ax_cpu.set_ylim(0, 0.35)
    ax_cpu.set_ylabel("CPU (cores, 1-min mean)")
    ax_mem.set_yscale("log")
    ax_mem.set_ylim(0.7, 25)
    ax_mem.set_yticks([1, 2, 5, 10, 20])
    ax_mem.set_yticklabels(["1", "2", "5", "10", "20"])
    ax_mem.set_ylabel("Memory (GB, log scale)")
    ax_cpu.set_title("(a) CPU usage", fontsize=7.5, loc="left", pad=3)
    ax_mem.set_title("(b) Memory usage (Model node: GPU memory)", fontsize=7.5, loc="left", pad=3)
    ax_cpu.legend(ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.42), handlelength=2.6,
                  columnspacing=1.0)
    fig.subplots_adjust(hspace=0.55, top=0.86)
    figstyle.save(fig, os.path.join(out, "pair_resources"))
    return {n: {"cpu_mean": sum(c[1]) / len(c[1]), "mem_mean_gb": sum(m[1]) / len(m[1])}
            for n, (c, m) in data.items()}, gpu_util


def pair_performance(repo, out):
    rows = read_csv(os.path.join(repo, E3_FUNCTIONS))
    ops = {}
    for r in rows:
        key = r["function"].split()[0]
        ops.setdefault(key, []).append((int(r["in_flight"]), float(r["throughput_per_s"])))
    levels = read_csv(os.path.join(repo, E5_LEVELS))
    users = [int(r["users"]) for r in levels]
    fig, (ax_a, ax_b) = figstyle.figure(height=4.0, nrows=2)
    series = [("W1", "Record access request (write)", "-", "o"),
              ("W2", "Record auditor decision (write)", "--", "s"),
              ("R1", "Read one request", ":", "^"),
              ("R2", "Read 50 latest decisions", "-.", "D")]
    for i, (key, label, ls, mk) in enumerate(series):
        pts = [(x, y) for x, y in ops[key] if y > 0]  # R2 completed no call at 50-100 clients
        ax_a.plot([p[0] for p in pts], [p[1] for p in pts], linestyle=ls, marker=mk, markersize=3.5,
                  markerfacecolor="white", linewidth=1.1, color=figstyle.SERIES[i], label=label)
    ax_a.axhline(E4_MODEL_OPS_PER_S, color=figstyle.INK_2, linewidth=1.0, linestyle=(0, (1, 1.5)))
    ax_a.text(100, E4_MODEL_OPS_PER_S * 1.35, "Model, one request at a time: 0.121/s",
              ha="right", va="bottom", fontsize=6.2, color=figstyle.INK_2)
    ax_a.set_yscale("log")
    ax_a.set_ylim(0.05, 6000)
    ax_a.set_xticks([10, 25, 50, 75, 100])
    ax_a.set_xlabel("Operations in progress (clients)", labelpad=1)
    ax_a.set_ylabel("Completed operations/s (log)")
    ax_a.set_title("(a) Ledger operations and model", fontsize=7.5, loc="left", pad=3)
    ax_a.legend(ncol=2, loc="upper center", bbox_to_anchor=(0.5, 1.38), handlelength=2.6, columnspacing=0.8)

    p50 = [float(r["p50_s"]) for r in levels]
    p95 = [float(r["p95_s"]) for r in levels]
    wpm = [float(r["throughput_per_min_mean"]) for r in levels]
    ax_b.plot(users, p50, linestyle="-", marker="o", markersize=3.5, markerfacecolor="white",
              linewidth=1.1, color=figstyle.SERIES[0], label="Median time (left)")
    ax_b.plot(users, p95, linestyle="--", marker="s", markersize=3.5, markerfacecolor="white",
              linewidth=1.1, color=figstyle.SERIES[1], label="95th percentile time (left)")
    ax_b.set_ylim(0, 900)
    ax_b.set_ylabel("End-to-end time (s)")
    ax_b.set_xlabel("Users submitting at the same time", labelpad=1)
    ax_b.set_xticks(users)
    right = ax_b.twinx()
    right.plot(users, wpm, linestyle=":", marker="^", markersize=3.5, markerfacecolor="white",
               linewidth=1.4, color=figstyle.SERIES[2], label="Throughput (right)")
    right.set_ylim(0, 14)
    right.set_ylabel("Workflows/min")
    right.spines["right"].set_visible(True)
    right.grid(False)
    handles = ax_b.get_legend_handles_labels()[0] + right.get_legend_handles_labels()[0]
    ax_b.legend(handles, [h.get_label() for h in handles], ncol=1, loc="upper left", handlelength=2.4)
    ax_b.set_title("(b) Whole system", fontsize=7.5, loc="left", pad=3)
    fig.subplots_adjust(hspace=0.62, top=0.85)
    figstyle.save(fig, os.path.join(out, "pair_performance"))


def reuse_rounds(repo, out):
    rows = read_csv(os.path.join(repo, REUSE_CONDITIONS))
    exact = [r for r in rows if r["design"] == "exact-record"]
    broad = [r for r in rows if r["design"] == "property-fingerprint"]
    rounds = [int(r["repeats"]) + 1 for r in exact]
    fig, ax = figstyle.figure(height=2.3)
    lines = [
        (exact, "reviews_avoided", "Reviews avoided, DIAS exact scope", "-", "o", 0),
        (broad, "reviews_avoided", "Reviews avoided, broader rule", "--", "s", 1),
        (exact, "grants_on_a_different_record", "Unapproved grants, DIAS exact scope", "-", "^", 2),
        (broad, "grants_on_a_different_record", "Unapproved grants, broader rule", ":", "D", 7),
    ]
    for data, field, label, ls, mk, c in lines:
        ax.plot(rounds, [int(r[field]) for r in data], linestyle=ls, marker=mk, markersize=3.5,
                markerfacecolor="white", linewidth=1.2, color=figstyle.SERIES[c], label=label)
    ax.set_xticks(rounds)
    ax.set_xlabel("Round (each round resends the same 300 requests)", labelpad=1)
    ax.set_ylabel("Requests, cumulative")
    ax.set_ylim(0, 600)
    ax.legend(ncol=1, loc="upper left", handlelength=2.6)
    figstyle.save(fig, os.path.join(out, "reuse_rounds"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    summary, gpu_util = pair_resources(args.repo, args.out)
    pair_performance(args.repo, args.out)
    reuse_rounds(args.repo, args.out)
    for node, s in summary.items():
        print(f"{NAMES[node]}: CPU mean {s['cpu_mean']:.3f} cores; memory mean {s['mem_mean_gb']:.2f} GB")
    print(f"Model node GPU utilisation mean {gpu_util:.1f}%")


if __name__ == "__main__":
    main()
