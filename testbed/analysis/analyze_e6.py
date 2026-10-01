#!/usr/bin/env python3
"""E6 analysis: the one-hour run with 100 users (after InterSnap's resilience test).

Outputs:
  - success and failure count per operation type (InterSnap Fig. 13 style);
  - CPU (cores) and memory (GB) of every machine over the hour, M1-M4 from
    node-exporter inside the VMs and M5 (the Mac with the model) from the Mac
    sampler (InterSnap Fig. 14 style, one panel per machine);
  - per-container mean and peak CPU and peak memory over the hour;
  - workflow latency over time and read latency against ledger size.

Usage: python3 analyze_e6.py --run <results/e6-...> --mac-samples <csv> --out <dir>
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
from components import COMPONENTS, index_trace, load_jsonl, split  # noqa: E402


def pct(values, p):
    ordered = sorted(v for v in values if v is not None)
    if not ordered:
        return None
    return ordered[max(1, math.ceil(p * len(ordered))) - 1]


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def operation_counts(rows, trace, start_ms, end_ms):
    """Successes and failures per operation type in the run window."""
    ops = {
        "Access request (ledger write)": [0, 0],
        "LLM recommendation": [0, 0],
        "Pending list (read)": [0, 0],
        "Auditor review (read)": [0, 0],
        "Auditor decision (ledger write)": [0, 0],
        "Requester read-back (read)": [0, 0],
        "Access-log entry (ledger write)": [0, 0],
    }
    for row in rows:
        submitted = row.get("submitStatus") == 202
        ops["Access request (ledger write)"][0 if submitted else 1] += 1
        if not submitted:
            continue
        if row.get("stage") in ("recommendation",) and row.get("status") != "completed":
            ops["LLM recommendation"][1] += 1
        elif row.get("generationStatus") is not None:
            ops["LLM recommendation"][0 if row.get("generationStatus") == "OK" else 1] += 1
        if "pendingListStatus" in row:
            ops["Pending list (read)"][0 if row["pendingListStatus"] == 200 else 1] += 1
        if "reviewStatus" in row:
            ops["Auditor review (read)"][0 if row["reviewStatus"] == 200 else 1] += 1
        if "decisionStatus" in row:
            ops["Auditor decision (ledger write)"][0 if row["decisionStatus"] == 201 else 1] += 1
        if "readBackStatus" in row:
            ops["Requester read-back (read)"][0 if row["readBackStatus"] == 200 else 1] += 1
    for event in trace:
        if event.get("event") == "fabric.submit" and event.get("fn") == "RecordAccessEvent":
            if start_ms <= event["at"] <= end_ms:
                ops["Access-log entry (ledger write)"][0 if event.get("successful") else 1] += 1
    return ops


def machine_series(start_s, end_s):
    cpu = {labels["machine"]: values for labels, values in prom.range_query(prom.MACHINE_CPU, start_s, end_s)}
    mem = {labels["machine"]: values for labels, values in prom.range_query(prom.MACHINE_MEM_USED, start_s, end_s)}
    return cpu, mem


def mac_series(path, start_s, end_s):
    rows = []
    with open(path) as handle:
        for row in csv.DictReader(handle):
            t = float(row["epoch_s"])
            if start_s <= t <= end_s:
                rows.append(row)
    return rows


def drift(series, start_s, end_s, scale=1.0, span_s=300):
    """Mean of the first and of the last five minutes of a [(t, value)] series, and the change between them."""
    first = [v / scale for t, v in series if t < start_s + span_s]
    last = [v / scale for t, v in series if t > end_s - span_s]
    if not first or not last:
        return None
    return {"first_5_min": mean(first), "last_5_min": mean(last), "change": mean(last) - mean(first)}


def by_ten_minutes(rows, start_ms, bins=6):
    """Workflows grouped by the ten-minute block in which they started (the last arrival joins the last block)."""
    out = []
    for i in range(bins):
        group = [r for r in rows if min(int((r["startedAt"] - start_ms) // 600000), bins - 1) == i]
        done = [r for r in group if r.get("status") == "completed"]
        e2e = [r["endToEndMs"] / 1000 for r in done]
        out.append({"minutes": f"{10 * i}-{10 * (i + 1)}", "started": len(group), "completed": len(done),
                    "end_to_end_p50_s": pct(e2e, 0.5), "end_to_end_p95_s": pct(e2e, 0.95)})
    return out


def container_table(container_csv, start_s, end_s):
    table = []
    for key, stats in sorted(container_stats.window(container_csv, start_s, end_s).items()):
        table.append({"machine": key[0], "container": key[1], **stats})
    return table


def plot_operations(ops, out):
    names = list(ops)
    ok = [ops[n][0] for n in names]
    bad = [ops[n][1] for n in names]
    fig, ax = figstyle.figure(height=2.5)
    y = list(range(len(names)))[::-1]
    bars = ax.barh(y, ok, height=0.62, color=figstyle.SERIES[2], edgecolor="white", label="Succeeded")
    ax.barh(y, bad, left=ok, height=0.62, color=figstyle.SERIES[1], hatch=figstyle.HATCHES[1], edgecolor="white",
            label="Failed")
    for yi, s, f in zip(y, ok, bad):
        total = s + f
        rate = 100.0 * s / total if total else 0
        ax.annotate(f"{s}/{total} ({rate:.1f}%)", (total, yi), xytext=(3, 0), textcoords="offset points",
                    ha="left", va="center", fontsize=6.0, color=figstyle.INK)
    ax.set_yticks(y)
    ax.set_yticklabels(names)
    ax.set_xlabel("Operations in the one-hour run (count)")
    ax.set_xlim(0, max(o + b for o, b in zip(ok, bad)) * 1.45)
    ax.grid(axis="x", color=figstyle.GRID, linewidth=0.5)
    ax.grid(axis="y", visible=False)
    ax.legend(loc="lower right")
    figstyle.save(fig, os.path.join(out, "e6_operations"))


def plot_machines(cpu, mem, mac_rows, start_s, out, name="e6_machines_cpu_memory", marks=None):
    """One small panel per machine: CPU in cores (top row) and memory in GB (bottom row).

    `marks` are minutes at which to draw a thin vertical line in every panel (for example round starts).
    """
    machines = ["m1", "m2", "m3", "m4", "m5"]
    titles = {"m1": "M1 (Police,\norderer 1)", "m2": "M2 (Forensics, Prosecution,\norderer 2)",
              "m3": "M3 (Court, Audit,\norderer 3)", "m4": "M4 (backend,\nmonitoring)", "m5": "M5 (Mac:\nLLM server)"}
    fig, axes = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=3.1, nrows=2, ncols=5, sharex=True)
    for col, machine in enumerate(machines):
        if machine == "m5":
            t = [(float(r["epoch_s"]) - start_s) / 60 for r in mac_rows]
            cpu_vals = [float(r["model_cpu_cores"]) for r in mac_rows]
            mem_vals = [float(r["model_rss_bytes"]) / 1e9 for r in mac_rows]
            cpu_label, mem_label = "LLM server CPU", "LLM server memory"
            cpu_cap, mem_cap = None, None
        else:
            t = [(ts - start_s) / 60 for ts, _ in cpu.get(machine, [])]
            cpu_vals = [v for _, v in cpu.get(machine, [])]
            mem_t = [(ts - start_s) / 60 for ts, _ in mem.get(machine, [])]
            mem_vals = [v / 1e9 for _, v in mem.get(machine, [])]
            cpu_cap, mem_cap = 3.0, 6.19
        top, bottom = axes[0][col], axes[1][col]
        top.plot(t, cpu_vals, color=figstyle.SERIES[0], linewidth=0.9)
        bottom.plot(t if machine == "m5" else mem_t, mem_vals, color=figstyle.SERIES[1], linewidth=0.9)
        top.set_title(titles[machine], fontsize=6.4)
        if cpu_cap:
            top.set_ylim(0, cpu_cap)
            bottom.set_ylim(0, mem_cap)
        else:
            top.set_ylim(0, max(cpu_vals) * 1.25 if cpu_vals else 1)
            bottom.set_ylim(0, max(mem_vals) * 1.25 if mem_vals else 1)
        if cpu_vals:
            top.text(0.98, 0.93, f"mean {mean(cpu_vals):.2f}, max {max(cpu_vals):.2f}", transform=top.transAxes,
                     ha="right", va="top", fontsize=5.6, color=figstyle.INK)
        if mem_vals:
            bottom.text(0.98, 0.93, f"max {max(mem_vals):.2f} GB", transform=bottom.transAxes, ha="right", va="top",
                        fontsize=5.6, color=figstyle.INK)
        bottom.set_xlabel("Minutes", fontsize=6.5)
    for mark in marks or []:
        for ax in [*axes[0], *axes[1]]:
            ax.axvline(mark, color=figstyle.INK_2, linewidth=0.4, linestyle=":")
    axes[0][0].set_ylabel("CPU (cores)")
    axes[1][0].set_ylabel("Memory (GB)")
    figstyle.save(fig, os.path.join(out, name))


SHORT_NAMES = {"dias-backend": "backend", "prometheus": "prometheus"}


def short_name(name):
    if name.startswith("dev-peer0."):
        return f"chaincode ({name.split('.')[1]})"
    for prefix in ("peer0.", "orderer"):
        if name.startswith(prefix):
            return name.replace(".example.com", "")
    return SHORT_NAMES.get(name, name)


def plot_containers(containers, out, name="e6_containers", period="over the hour"):
    """Mean CPU (cores) and peak memory (MB) of every container over the run, by machine."""
    keep = [c for c in containers if not c["container"].startswith(("cadvisor", "loadgen"))]
    keep.sort(key=lambda c: (c["machine"], c["container"]))
    labels = [f"{c['machine'].upper()}  {short_name(c['container'])}" for c in keep]
    fig, axes = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=0.18 * len(keep) + 0.9, ncols=2, sharey=True)
    y = list(range(len(keep)))[::-1]
    machine_color = {"m1": figstyle.SERIES[0], "m2": figstyle.SERIES[1], "m3": figstyle.SERIES[2], "m4": figstyle.SERIES[3]}
    for panel, (key, xlabel, fmt) in enumerate([("cpu_mean_cores", f"Mean CPU {period} (cores)", "{:.3f}"),
                                                ("mem_max_mb", f"Peak memory {period} (MB)", "{:.0f}")]):
        ax = axes[panel]
        vals = [c[key] or 0 for c in keep]
        bars = ax.barh(y, vals, height=0.66, color=[machine_color[c["machine"]] for c in keep], edgecolor="white")
        for bar, v in zip(bars, vals):
            ax.annotate(fmt.format(v), (v, bar.get_y() + bar.get_height() / 2), xytext=(2, 0), textcoords="offset points",
                        va="center", fontsize=5.4, color=figstyle.INK)
        ax.set_xlabel(xlabel)
        ax.set_xlim(0, max(vals) * 1.3 if vals else 1)
        ax.grid(axis="x", color=figstyle.GRID, linewidth=0.5)
        ax.grid(axis="y", visible=False)
    axes[0].set_yticks(y)
    axes[0].set_yticklabels(labels, fontsize=5.8)
    figstyle.save(fig, os.path.join(out, name))


def plot_latency_over_time(rows, start_ms, out):
    done = [r for r in rows if r.get("status") == "completed"]
    t = [(r["startedAt"] - start_ms) / 60000 for r in done]
    e2e = [r["endToEndMs"] / 1000 for r in done]
    fig, ax = figstyle.figure(height=2.1)
    ax.scatter(t, e2e, s=6, color=figstyle.SERIES[0], edgecolors="none", label="One workflow")
    ax.axhline(pct(e2e, 0.5), color=figstyle.SERIES[1], linewidth=1.0, linestyle="--",
               label=f"Median {pct(e2e, 0.5):.1f} s")
    ax.axhline(pct(e2e, 0.95), color=figstyle.SERIES[3], linewidth=1.0, linestyle=":",
               label=f"95th percentile {pct(e2e, 0.95):.1f} s")
    ax.set_xlabel("Time into the run (minutes)")
    ax.set_ylabel("End-to-end workflow time (s)")
    ax.set_ylim(0, max(e2e) * 1.15)
    ax.legend(loc="upper left", ncol=1)
    figstyle.save(fig, os.path.join(out, "e6_latency_over_time"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--mac-samples", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--container-stats", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    rows = load_jsonl(os.path.join(args.run, "requests.jsonl"))
    trace = load_jsonl(os.path.join(args.run, "backend-trace.jsonl"))
    with open(os.path.join(args.run, "run.json")) as handle:
        run = json.load(handle)
    start_ms, end_ms = run["startedAt"], run["finishedAt"]
    start_s, end_s = start_ms / 1000, end_ms / 1000
    ops = operation_counts(rows, trace, start_ms, end_ms)
    by_request, _ = index_trace(trace)
    splits = [p for p in (split(r, by_request.get(r.get("requestId"), {})) for r in rows) if p]
    cpu, mem = machine_series(start_s, end_s)
    mac_rows = mac_series(args.mac_samples, start_s, end_s)
    containers = container_table(args.container_stats, start_s, end_s)
    done = [r for r in rows if r.get("status") == "completed"]
    valid = [r for r in done if r.get("validRecommendation")]
    e2e = [r["endToEndMs"] / 1000 for r in done]
    summary = {
        "window_minutes": (end_ms - start_ms) / 60000,
        "arrivals": len(rows),
        "completed": len(done),
        "failed": len(rows) - len(done),
        "operations": {k: {"succeeded": v[0], "failed": v[1]} for k, v in ops.items()},
        "operations_total": sum(v[0] + v[1] for v in ops.values()),
        "operations_succeeded": sum(v[0] for v in ops.values()),
        "end_to_end_s": {"mean": mean(e2e), "p50": pct(e2e, 0.5), "p95": pct(e2e, 0.95), "max": max(e2e) if e2e else None},
        "components_mean_s": {k: mean([p[k] for p in splits]) for k in COMPONENTS},
        "throughput_workflows_per_min": len(done) / ((end_ms - start_ms) / 60000),
        "accuracy": {"valid": len(valid), "of": len(done), "correct": sum(1 for r in valid if r.get("correct")),
                     "reason_correct": sum(1 for r in valid if r.get("reasonCorrect"))},
        "read_latency_ms": {
            "pending_list": {"p50": pct([r.get("pendingListMs") for r in done], 0.5), "p95": pct([r.get("pendingListMs") for r in done], 0.95)},
            "auditor_review": {"p50": pct([r.get("reviewMs") for r in done], 0.5), "p95": pct([r.get("reviewMs") for r in done], 0.95)},
            "read_back": {"p50": pct([r.get("readBackMs") for r in done], 0.5), "p95": pct([r.get("readBackMs") for r in done], 0.95)},
        },
        "machines": {m: {"cpu_mean_cores": mean([v for _, v in cpu.get(m, [])]), "cpu_max_cores": max([v for _, v in cpu.get(m, [])] or [0]),
                         "mem_max_gb": max([v for _, v in mem.get(m, [])] or [0]) / 1e9} for m in ["m1", "m2", "m3", "m4"]},
        "mac": {"model_cpu_mean_cores": mean([float(r["model_cpu_cores"]) for r in mac_rows]),
                "model_cpu_max_cores": max([float(r["model_cpu_cores"]) for r in mac_rows] or [0]),
                "model_rss_max_gb": max([float(r["model_rss_bytes"]) for r in mac_rows] or [0]) / 1e9,
                "gpu_utilization_mean_pct": mean([float(r["gpu_utilization_pct"]) for r in mac_rows if r["gpu_utilization_pct"]]),
                "mac_cpu_mean_cores": mean([float(r["mac_cpu_cores_used"]) for r in mac_rows]),
                "samples": len(mac_rows)},
        "memory_drift_gb": {m: drift(mem.get(m, []), start_s, end_s, scale=1e9) for m in ["m1", "m2", "m3", "m4"]},
        "mac_memory_drift_gb": {
            "model_rss": drift([(float(r["epoch_s"]), float(r["model_rss_bytes"])) for r in mac_rows], start_s, end_s, 1e9),
            "mac_used": drift([(float(r["epoch_s"]), float(r["mac_memory_used_bytes"])) for r in mac_rows], start_s, end_s, 1e9),
        },
        "by_10_minutes": by_ten_minutes(rows, start_ms),
        "containers": containers,
    }
    with open(os.path.join(args.out, "e6-summary.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    with open(os.path.join(args.out, "e6-containers.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["machine", "container", "cpu_mean_cores", "cpu_max_cores", "mem_max_mb"])
        for c in containers:
            writer.writerow([c["machine"], c["container"], f"{c['cpu_mean_cores']:.3f}", f"{c['cpu_max_cores']:.3f}",
                             f"{c['mem_max_mb']:.0f}" if c["mem_max_mb"] is not None else ""])
    plot_operations(ops, args.out)
    plot_machines(cpu, mem, mac_rows, start_s, args.out)
    plot_latency_over_time(rows, start_ms, args.out)
    plot_containers(containers, args.out)
    print(json.dumps({k: summary[k] for k in ["arrivals", "completed", "failed", "operations_total", "operations_succeeded",
                                              "end_to_end_s", "throughput_workflows_per_min", "accuracy", "machines", "mac"]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
