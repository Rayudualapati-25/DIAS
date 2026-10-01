#!/usr/bin/env python3
"""E3 analysis: the blockchain part alone, per contract function, at 10-100
transactions in flight. Throughput in committed transactions (or reads) per
second, latency in milliseconds, and the three stages of a write.

Usage: python3 analyze_e3.py --run <results/e3-...> --out <dir>
"""

import argparse
import csv
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import container_stats  # noqa: E402
import figstyle  # noqa: E402
import prom  # noqa: E402

ROUNDS = ["W1 CreateAccessRequest", "W2 SubmitAuditorDecision", "R1 GetRequest", "R2 QueryAccessDecisions"]
SHORT = {"W1 CreateAccessRequest": "Create request (write)", "W2 SubmitAuditorDecision": "Auditor decision (write)",
         "R1 GetRequest": "Read one request", "R2 QueryAccessDecisions": "Decision log, newest 50"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--container-stats", required=True, help="docker-stats sampler CSV (per-container CPU)")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.run, "summary.json")) as handle:
        summary = json.load(handle)
    levels = sorted({s["level"] for s in summary})
    table = {(s["round"], s["level"]): s for s in summary}

    # Resources per machine and per container during each round (the load generator itself is left out).
    for s in summary:
        start, end = s["startedAt"] / 1000, s["finishedAt"] / 1000
        cpu = prom.window_stats(prom.MACHINE_CPU, start, end, key=lambda l: l["machine"])
        s["machines_cpu_mean_cores"] = {m: v["mean"] for m, v in cpu.items()}
        s["machines_cpu_max_cores"] = {m: v["max"] for m, v in cpu.items()}
        mem = prom.window_stats(prom.MACHINE_MEM_USED, start, end, key=lambda l: l["machine"])
        s["machines_mem_max_gb"] = {m: v["max"] / 1e9 for m, v in mem.items()}
        per_container = [(k, v) for k, v in container_stats.window(args.container_stats, start, end).items()
                         if not k[1].startswith(("loadgen", "cadvisor"))]
        top = sorted(per_container, key=lambda item: -item[1]["cpu_mean_cores"])[:6]
        s["top_containers_cpu_mean_cores"] = [{"machine": k[0], "container": k[1], "cpu_mean_cores": v["cpu_mean_cores"],
                                               "mem_max_mb": v["mem_max_mb"]} for k, v in top]
        orderer_fill = prom.histogram_mean("blockcutter_block_fill_duration", start, end, "machine")
        endorse = prom.histogram_mean("endorser_proposal_duration", start, end, "org")
        block_proc = prom.histogram_mean("ledger_block_processing_time", start, end, "org")
        s["fabric_metrics_mean_s"] = {
            "orderer_block_fill": {"/".join(k): v for k, v in orderer_fill.items()},
            "peer_endorsement": {"/".join(k): v for k, v in endorse.items()},
            "peer_block_processing": {"/".join(k): v for k, v in block_proc.items()},
        }
    with open(os.path.join(args.out, "e3-summary.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    with open(os.path.join(args.out, "e3-functions.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["function", "in_flight", "succeeded", "failed", "throughput_per_s", "p50_ms", "p95_ms",
                         "endorse_ms", "orderer_submit_ms", "commit_wait_ms"])
        for rnd in ROUNDS:
            for level in levels:
                s = table.get((rnd, level))
                if not s:
                    continue
                st = s["stagesMeanMs"]
                writer.writerow([rnd, level, s["succeeded"], s["failed"], s["throughputPerS"], s["latencyMs"]["p50"],
                                 s["latencyMs"]["p95"], st["endorse"] if st["endorse"] is not None else "",
                                 st["ordererSubmit"] if st["ordererSubmit"] is not None else "",
                                 st["commitWait"] if st["commitWait"] is not None else ""])

    x = list(range(len(levels)))
    # Throughput: writes and reads in separate panels (very different scales, one axis each).
    fig, axes = figstyle.figure(height=3.4, nrows=2)
    for panel, rounds in enumerate([ROUNDS[:2], ROUNDS[2:]]):
        ax = axes[panel]
        width = 0.36
        for i, rnd in enumerate(rounds):
            vals = [table[(rnd, lv)]["throughputPerS"] if (rnd, lv) in table else 0 for lv in levels]
            bars = ax.bar([xi + (i - 0.5) * width for xi in x], vals, width=width * 0.94,
                          color=figstyle.SERIES[panel * 2 + i], hatch=figstyle.HATCHES[panel * 2 + i],
                          edgecolor="white", linewidth=0.6, label=SHORT[rnd])
            figstyle.label_bars(ax, bars, fmt="{:.1f}", size=5.6)
        ax.set_ylabel("Transactions/s" if panel == 0 else "Reads/s")
        ax.set_xticks(x)
        ax.set_xticklabels([str(lv) for lv in levels])
        top = max(table[(r, lv)]["throughputPerS"] for r in rounds for lv in levels if (r, lv) in table)
        ax.set_ylim(0, top * 1.3)
        ax.legend(loc="upper left", fontsize=6.0)
    axes[1].set_xlabel("Transactions kept in flight (simultaneous clients)")
    figstyle.save(fig, os.path.join(args.out, "e3_throughput"))

    # Latency p50 per function.
    fig, axes = figstyle.figure(height=3.4, nrows=2)
    for panel, rounds in enumerate([ROUNDS[:2], ROUNDS[2:]]):
        ax = axes[panel]
        for i, rnd in enumerate(rounds):
            divisor = 1000 if panel == 0 else 1
            vals = []
            for lv in levels:
                p50 = table[(rnd, lv)]["latencyMs"]["p50"]
                vals.append(p50 / divisor if p50 is not None else float("nan"))
            ax.plot(levels, vals, color=figstyle.SERIES[panel * 2 + i], marker="os"[i], markersize=4.2,
                    linewidth=1.5, label=SHORT[rnd], markeredgecolor="white", markeredgewidth=0.7)
            for lv, v in zip(levels, vals):
                if math.isnan(v):
                    continue
                ax.annotate(f"{v:.2f}" if panel == 0 else f"{v:.0f}", (lv, v), xytext=(0, 4), textcoords="offset points",
                            ha="center", fontsize=5.6, color=figstyle.INK)
        ax.set_xticks(levels)
        ax.set_ylabel("Median latency (s)" if panel == 0 else "Median latency (ms)")
        valid_p50 = [table[(r, lv)]["latencyMs"]["p50"] for r in rounds for lv in levels
                     if table[(r, lv)]["latencyMs"]["p50"] is not None]
        ax.set_ylim(0, max(valid_p50) / divisor * 1.3)
        ax.legend(loc="upper left", fontsize=6.0)
    axes[1].set_xlabel("Transactions kept in flight (simultaneous clients)")
    figstyle.save(fig, os.path.join(args.out, "e3_latency"))

    # Stage split of the two writes.
    fig, axes = figstyle.figure(height=3.2, nrows=2, sharex=True)
    stages = [("endorse", "Endorsement (3 of 5 peers)"), ("ordererSubmit", "Hand-off to ordering"),
              ("commitWait", "Wait for block commit")]
    for panel, rnd in enumerate(ROUNDS[:2]):
        ax = axes[panel]
        bottom = [0.0] * len(levels)
        for i, (key, name) in enumerate(stages):
            vals = [(table[(rnd, lv)]["stagesMeanMs"][key] or 0) / 1000 for lv in levels]
            bars = ax.bar(x, vals, bottom=bottom, width=0.58, color=figstyle.SERIES[i], hatch=figstyle.HATCHES[i],
                          edgecolor="white", linewidth=0.6, label=name if panel == 0 else None)
            for bar, v, b in zip(bars, vals, bottom):
                if v >= 0.25:
                    ax.text(bar.get_x() + bar.get_width() / 2, b + v / 2, f"{v:.2f}", ha="center", va="center",
                            fontsize=5.6, color=figstyle.INK,
                            bbox={"boxstyle": "round,pad=0.1", "facecolor": "white", "edgecolor": "none", "alpha": 0.85})
            bottom = [b + v for b, v in zip(bottom, vals)]
        for xi, total in zip(x, bottom):
            ax.annotate(f"{total:.2f} s", (xi, total), xytext=(0, 2), textcoords="offset points", ha="center",
                        fontsize=5.8, color=figstyle.INK)
        ax.set_title(SHORT[rnd], fontsize=7, loc="left")
        ax.set_ylabel("Mean time (s)")
        ax.set_ylim(0, max(bottom) * 1.25)
    axes[1].set_xticks(x)
    axes[1].set_xticklabels([str(lv) for lv in levels])
    axes[1].set_xlabel("Transactions kept in flight (simultaneous clients)")
    fig.legend(loc="lower center", bbox_to_anchor=(0.55, 1.0), ncol=3, fontsize=6.0)
    figstyle.save(fig, os.path.join(args.out, "e3_write_stages"))
    for rnd in ROUNDS:
        print(rnd, [(lv, table[(rnd, lv)]["throughputPerS"], table[(rnd, lv)]["latencyMs"]["p50"],
                     table[(rnd, lv)]["failed"]) for lv in levels if (rnd, lv) in table])
    return 0


if __name__ == "__main__":
    sys.exit(main())
