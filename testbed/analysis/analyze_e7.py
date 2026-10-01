#!/usr/bin/env python3
"""E7 analysis: workflows while the Raft leader orderer and then a peer are down.

Each workflow is placed in the phase in which it started (normal, leader
orderer stopped, Court peer stopped, all recovered), and per phase the script
reports how many completed and how long they took. It also reports how long
the remaining orderers needed to elect a new leader (from their logs) and the
ledger check the orchestrator made after the run.

Usage: python3 analyze_e7.py --run <results/e7-...> --out <dir>
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402
from components import load_jsonl  # noqa: E402


def pct(values, p):
    ordered = sorted(values)
    return ordered[max(1, math.ceil(p * len(ordered))) - 1] if ordered else None


def leader_changes(machine, container, since_epoch):
    logs = subprocess.run(["docker", "--context", f"lima-dias-{machine}", "logs", "--timestamps", container],
                          capture_output=True, text=True)
    changes = []
    for line in (logs.stdout + "\n" + logs.stderr).splitlines():
        if "Raft leader changed" not in line or "diaschannel" not in line:
            continue
        stamp = line.split(" ", 1)[0]
        try:
            when = datetime.fromisoformat(stamp.replace("Z", "+00:00")[:26] + "+00:00").timestamp()
        except ValueError:
            continue
        if when >= since_epoch:
            match = re.search(r"Raft leader changed: (\d+) -> (\d+)", line)
            changes.append({"epoch_s": when, "from": match.group(1) if match else None, "to": match.group(2) if match else None})
    return changes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    rows = load_jsonl(os.path.join(args.run, "requests.jsonl"))
    with open(os.path.join(args.run, "fault-timeline.json")) as handle:
        timeline = json.load(handle)
    stops = [e for e in timeline if e["event"] == "stopped"]
    starts = [e for e in timeline if e["event"] == "started"]
    leader_stop = stops[0]["epoch_s"]
    leader_start = starts[0]["epoch_s"]
    peer_stop = stops[1]["epoch_s"]
    peer_start = starts[1]["epoch_s"]
    # The Court peer is stopped a moment after the leader is started again; that gap joins the Court phase so
    # every workflow falls in exactly one phase.
    phases = [("Normal", 0, leader_stop), ("Leader orderer stopped", leader_stop, leader_start),
              ("Court peer stopped", leader_start, peer_start), ("Recovered", peer_start, float("inf"))]
    result = {"phases": [], "timeline": timeline}
    for name, lo, hi in phases:
        group = [r for r in rows if lo <= r["startedAt"] / 1000 < hi]
        done = [r for r in group if r.get("status") == "completed"]
        e2e = [r["endToEndMs"] / 1000 for r in done]
        result["phases"].append({
            "phase": name, "started": len(group), "completed": len(done), "failed": len(group) - len(done),
            "failures": sorted({f"{r.get('stage')}: {str(r.get('error'))[:120]}" for r in group if r.get("status") != "completed"}),
            "p50_s": pct(e2e, 0.5), "p95_s": pct(e2e, 0.95), "max_s": max(e2e) if e2e else None,
            "request_commit_p50_s": pct([r["submitMs"] / 1000 for r in done], 0.5),
            "decision_commit_p50_s": pct([r["decisionMs"] / 1000 for r in done], 0.5),
        })
    before = next(e for e in timeline if e["event"] == "raft_leader_before")["node"]
    stopped_machine = {"orderer1": "m1", "orderer2": "m2", "orderer3": "m3"}
    changes = []
    for node, machine in stopped_machine.items():
        if node == before:
            continue
        for change in leader_changes(machine, f"{node}.example.com", leader_stop):
            changes.append({"observed_by": node, **change, "seconds_after_stop": change["epoch_s"] - leader_stop})
    result["leader_before"] = before
    result["leader_changes_after_stop"] = sorted(changes, key=lambda c: c["epoch_s"])
    first_new = [c for c in result["leader_changes_after_stop"] if c["to"] not in ("0", None)]
    result["new_leader_elected_after_s"] = first_new[0]["seconds_after_stop"] if first_new else None
    result["ledger_after"] = next((e for e in timeline if e["event"] == "ledger_heights_after"), None)
    result["chain_info_after"] = next((e for e in timeline if e["event"] == "chain_info_after"), None)
    with open(os.path.join(args.out, "e7-summary.json"), "w") as handle:
        json.dump(result, handle, indent=2)

    # Latency of every workflow against its start time, with the fault windows shaded.
    t0 = min(r["startedAt"] for r in rows) / 1000
    fig, ax = figstyle.figure(height=2.2)
    for lo, hi, label, color in [(leader_stop, leader_start, "Leader orderer stopped", figstyle.SERIES[3]),
                                 (peer_stop, peer_start, "Court peer stopped", figstyle.SERIES[4])]:
        ax.axvspan((lo - t0) / 60, (hi - t0) / 60, color=color, alpha=0.18, linewidth=0, label=label)
    done = [r for r in rows if r.get("status") == "completed"]
    failed = [r for r in rows if r.get("status") != "completed"]
    ax.scatter([(r["startedAt"] / 1000 - t0) / 60 for r in done], [r["endToEndMs"] / 1000 for r in done], s=8,
               color=figstyle.SERIES[0], edgecolors="none", label=f"Completed ({len(done)})")
    if failed:
        ax.scatter([(r["startedAt"] / 1000 - t0) / 60 for r in failed], [0.5] * len(failed), s=14, marker="x",
                   color=figstyle.SERIES[1], label=f"Failed ({len(failed)})")
    ax.set_xlabel("Time into the run (minutes)")
    ax.set_ylabel("End-to-end workflow time (s)")
    ax.legend(loc="upper left", fontsize=5.8, ncol=2)
    figstyle.save(fig, os.path.join(args.out, "e7_fault_timeline"))
    print(json.dumps({k: result[k] for k in ["phases", "leader_before", "new_leader_elected_after_s"]}, indent=1))
    print("ledger after:", result["ledger_after"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
