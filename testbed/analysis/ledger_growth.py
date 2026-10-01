#!/usr/bin/env python3
"""Ledger growth: read time of the list queries against the number of requests
on the ledger (from probes.jsonl), with the request counts taken from the runs.

Usage: python3 ledger_growth.py --probes <probes.jsonl> --counts <counts.json> --out <dir>
counts.json maps each probe label to {"requests": N, "decisions": M}.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402

NAMES = {"QueryPendingAuditorRequests": "Auditor pending list (scans all requests)",
         "QueryAccessDecisions": "Decision log, newest 50 (scans all decisions)",
         "GetRequest": "One request by ID (single key)"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probes", required=True)
    parser.add_argument("--counts", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    with open(args.probes) as handle:
        probes = [json.loads(line) for line in handle if line.strip()]
    with open(args.counts) as handle:
        counts = json.load(handle)
    rows = []
    for probe in probes:
        if probe["label"] not in counts:
            continue
        for result in probe["results"]:
            if "meanMs" not in result:
                continue
            rows.append({"label": probe["label"], "requests": counts[probe["label"]]["requests"],
                         "decisions": counts[probe["label"]]["decisions"], **result})
    with open(os.path.join(args.out, "ledger-growth.json"), "w") as handle:
        json.dump(rows, handle, indent=2)
    fig, ax = figstyle.figure(height=2.2)
    for i, fn in enumerate(NAMES):
        pts = sorted((r["requests"], r["p50Ms"]) for r in rows if r["fn"] == fn)
        if not pts:
            continue
        xs, ys = zip(*pts)
        ax.plot(xs, ys, color=figstyle.SERIES[i], marker="osd"[i], markersize=4, linewidth=1.4, label=NAMES[fn],
                markeredgecolor="white", markeredgewidth=0.7)
        for x, y in pts:
            ax.annotate(f"{y:.0f}", (x, y), xytext=(0, 4), textcoords="offset points", ha="center", fontsize=5.6,
                        color=figstyle.INK)
    ax.set_xlabel("Access requests stored on the ledger")
    ax.set_ylabel("Median read time (ms)")
    ax.set_ylim(bottom=0)
    ax.legend(loc="upper left", fontsize=5.8)
    figstyle.save(fig, os.path.join(args.out, "ledger_growth_reads"))
    for r in rows:
        print(r["label"], r["requests"], r["fn"], round(r["p50Ms"], 1), r.get("items"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
