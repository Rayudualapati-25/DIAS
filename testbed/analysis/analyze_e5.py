#!/usr/bin/env python3
"""E5 analysis: whole-system latency, components, throughput, accuracy and
resources at 10, 25, 50, 75 and 100 simultaneous users.

Usage: python3 analyze_e5.py --run <results/e5-...> --out <dir>
Every number written here is computed from the raw rows of the run, the
backend trace and Prometheus; nothing is typed in by hand.
"""

import argparse
import csv
import json
import math
import os
import statistics
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import container_stats  # noqa: E402
import figstyle  # noqa: E402
import prom  # noqa: E402
from components import COMPONENTS, LABELS, index_trace, load_jsonl, split  # noqa: E402

MACHINE_NAMES = {"m1": "M1", "m2": "M2", "m3": "M3", "m4": "M4"}


def pct(values, p):
    """Nearest-rank percentile (the value below which p of the samples fall)."""
    ordered = sorted(values)
    if not ordered:
        return None
    rank = max(1, math.ceil(p * len(ordered)))
    return ordered[rank - 1]


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def sd(values):
    values = [v for v in values if v is not None]
    return statistics.stdev(values) if len(values) > 1 else 0.0


def wilson(k, n, z=1.959964):
    if n == 0:
        return (None, None)
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (centre - half, centre + half)


def resources(windows, container_csv):
    """Per machine (node-exporter via Prometheus) and per container (docker-stats sampler)
    CPU in cores and memory in MB over the batch windows. Container data exist only for
    windows after the sampler started; windows before it are left out, not guessed."""
    machine = {}
    container = {}
    first = container_stats.first_sample_time(container_csv) if container_csv else None
    for window in windows:
        start, end = window["startedAt"] / 1000.0, window["finishedAt"] / 1000.0
        cpu = prom.window_stats(prom.MACHINE_CPU, start, end, key=lambda l: l["machine"])
        mem = prom.window_stats(prom.MACHINE_MEM_USED, start, end, key=lambda l: l["machine"])
        for name in cpu:
            slot = machine.setdefault(name, {"cpu_mean": [], "cpu_max": [], "mem_max_mb": []})
            slot["cpu_mean"].append(cpu[name]["mean"])
            slot["cpu_max"].append(cpu[name]["max"])
            if name in mem:
                slot["mem_max_mb"].append(mem[name]["max"] / 1e6)
        if first is None or start < first:
            continue
        for key, stats in container_stats.window(container_csv, start, end).items():
            slot = container.setdefault(key, {"cpu_mean": [], "cpu_max": [], "mem_max_mb": []})
            slot["cpu_mean"].append(stats["cpu_mean_cores"])
            slot["cpu_max"].append(stats["cpu_max_cores"])
            if stats["mem_max_mb"] is not None:
                slot["mem_max_mb"].append(stats["mem_max_mb"])
    fold = lambda slot: {"cpu_mean_cores": mean(slot["cpu_mean"]), "cpu_max_cores": max(slot["cpu_max"]),
                         "mem_max_mb": max(slot["mem_max_mb"]) if slot["mem_max_mb"] else None}
    return ({k: fold(v) for k, v in machine.items()}, {k: fold(v) for k, v in container.items()})


def ledger_tx_rate(windows):
    """Committed transactions per second on the channel during the batches (police peer view)."""
    rates = []
    for window in windows:
        start, end = window["startedAt"] / 1000.0, window["finishedAt"] / 1000.0
        inc = prom.counter_increase('ledger_transaction_count{channel="diaschannel",org="police"}', start, end, "org")
        total = sum(inc.values())
        rates.append(total / (end - start))
    return mean(rates)


def analyze(run_dir, container_csv=None):
    rows = [row for row in load_jsonl(os.path.join(run_dir, "requests.jsonl")) if row.get("phase") == "measured"]
    trace_by_request, _ = index_trace(load_jsonl(os.path.join(run_dir, "backend-trace.jsonl")))
    with open(os.path.join(run_dir, "batches.json")) as handle:
        batches = json.load(handle)
    levels = sorted({row["level"] for row in rows})
    per_level = []
    component_rows = []
    for level in levels:
        level_rows = [row for row in rows if row["level"] == level]
        completed = [row for row in level_rows if row["status"] == "completed"]
        splits = []
        for row in completed:
            parts = split(row, trace_by_request.get(row["requestId"], {}))
            if parts is not None:
                splits.append(parts)
                component_rows.append({"level": level, "repetition": row["repetition"], "requestId": row["requestId"], **parts})
        e2e = [row["endToEndMs"] / 1000.0 for row in completed]
        level_batches = [b for b in batches if b["level"] == level]
        reps = sorted({row["repetition"] for row in level_rows})
        rep_p50 = [pct([r["endToEndMs"] / 1000.0 for r in completed if r["repetition"] == rep], 0.5) for rep in reps]
        rep_p95 = [pct([r["endToEndMs"] / 1000.0 for r in completed if r["repetition"] == rep], 0.95) for rep in reps]
        valid = [row for row in completed if row.get("validRecommendation")]
        correct = [row for row in valid if row.get("correct")]
        reason_ok = [row for row in valid if row.get("reasonCorrect")]
        allow_rows = [row for row in valid if row["expected"] == "ALLOW"]
        deny_rows = [row for row in valid if row["expected"] == "DENY"]
        machine, container = resources(level_batches, container_csv)
        inference = [p["llm_inference"] for p in splits]
        completion = [p["completion_tokens"] for p in splits if p["completion_tokens"]]
        per_level.append({
            "users": level,
            "repetitions": len(reps),
            "requested": len(level_rows),
            "completed": len(completed),
            "failed": len(level_rows) - len(completed),
            "facts_match_plan": sum(1 for r in completed if r.get("plannedFactsMatch")),
            "end_to_end_s": {"mean": mean(e2e), "p50": pct(e2e, 0.5), "p95": pct(e2e, 0.95), "max": max(e2e) if e2e else None,
                             "p50_rep_mean": mean(rep_p50), "p50_rep_sd": sd(rep_p50),
                             "p95_rep_mean": mean(rep_p95), "p95_rep_sd": sd(rep_p95)},
            "components_mean_s": {key: mean([p[key] for p in splits]) for key in COMPONENTS},
            "components_p95_s": {key: pct([p[key] for p in splits], 0.95) for key in COMPONENTS},
            "ledger_stages_mean_s": {key: mean([p[key] for p in splits]) for key in [
                "request_endorse", "request_order_submit", "request_commit_wait",
                "decision_endorse", "decision_order_submit", "decision_commit_wait"]},
            "split_check_max_abs_s": max(abs(p["split_check"]) for p in splits) if splits else None,
            "notify_delay_s": {"mean": mean([p["notify_delay"] for p in splits]), "max": max(p["notify_delay"] for p in splits) if splits else None},
            "traced": len(splits),
            "throughput_workflows_per_min": {"mean": mean([b["workflowsPerMinute"] for b in level_batches]),
                                             "sd": sd([b["workflowsPerMinute"] for b in level_batches]),
                                             "per_repetition": [b["workflowsPerMinute"] for b in level_batches]},
            "llm": {"inference_mean_s": mean(inference), "inference_p95_s": pct(inference, 0.95),
                    "prompt_tokens_mean": mean([p["prompt_tokens"] for p in splits]),
                    "cached_prompt_tokens_mean": mean([p["cached_prompt_tokens"] for p in splits]),
                    "completion_tokens_mean": mean(completion),
                    "output_tokens_per_inference_s": (sum(completion) / sum(inference)) if inference and completion else None,
                    "capacity_per_min": 60.0 / mean([p["llm_inference"] + p["llm_prompt_check"] for p in splits]) if splits else None},
            "ledger_tx_per_s": ledger_tx_rate(level_batches),
            "accuracy": {"valid": len(valid), "of": len(completed), "correct": len(correct),
                         "reason_correct": len(reason_ok),
                         "allow_correct": sum(1 for r in allow_rows if r["correct"]), "allow_total": len(allow_rows),
                         "deny_correct": sum(1 for r in deny_rows if r["correct"]), "deny_total": len(deny_rows),
                         "correct_ci95": wilson(len(correct), len(valid))},
            "machines": machine,
            "containers_top": sorted(
                [{"machine": k[0], "container": k[1], **v} for k, v in container.items()],
                key=lambda item: -item["cpu_mean_cores"])[:12],
            "containers_all": [{"machine": k[0], "container": k[1], **v} for k, v in container.items()],
        })
    return per_level, component_rows


def write_tables(per_level, component_rows, out):
    with open(os.path.join(out, "e5-levels.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["users", "completed", "requested", "p50_s", "p95_s", "mean_s", "max_s",
                         "throughput_per_min_mean", "throughput_per_min_sd", "llm_inference_mean_s",
                         "ledger_tx_per_s", "valid", "correct", "reason_correct"])
        for lv in per_level:
            e = lv["end_to_end_s"]
            writer.writerow([lv["users"], lv["completed"], lv["requested"], f"{e['p50']:.2f}", f"{e['p95']:.2f}",
                             f"{e['mean']:.2f}", f"{e['max']:.2f}",
                             f"{lv['throughput_workflows_per_min']['mean']:.2f}", f"{lv['throughput_workflows_per_min']['sd']:.2f}",
                             f"{lv['llm']['inference_mean_s']:.2f}", f"{lv['ledger_tx_per_s']:.2f}",
                             lv["accuracy"]["valid"], lv["accuracy"]["correct"], lv["accuracy"]["reason_correct"]])
    with open(os.path.join(out, "e5-components.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["users"] + [LABELS[k] for k in COMPONENTS] + ["end_to_end_mean"])
        for lv in per_level:
            writer.writerow([lv["users"]] + [f"{lv['components_mean_s'][k]:.3f}" for k in COMPONENTS]
                            + [f"{lv['end_to_end_s']['mean']:.3f}"])
    with open(os.path.join(out, "e5-component-rows.csv"), "w", newline="") as handle:
        keys = list(component_rows[0].keys())
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows(component_rows)
    with open(os.path.join(out, "e5-resources.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["users", "machine", "container", "cpu_mean_cores", "cpu_max_cores", "mem_max_mb"])
        for lv in per_level:
            for name, m in sorted(lv["machines"].items()):
                writer.writerow([lv["users"], name, "(whole VM)", f"{m['cpu_mean_cores']:.3f}", f"{m['cpu_max_cores']:.3f}", f"{m['mem_max_mb']:.0f}"])
            for c in sorted(lv["containers_all"], key=lambda item: (item["machine"], item["container"])):
                writer.writerow([lv["users"], c["machine"], c["container"], f"{c['cpu_mean_cores']:.3f}", f"{c['cpu_max_cores']:.3f}",
                                 f"{c['mem_max_mb']:.0f}" if c["mem_max_mb"] is not None else ""])


def plot_latency(per_level, out):
    users = [lv["users"] for lv in per_level]
    p50 = [lv["end_to_end_s"]["p50"] for lv in per_level]
    p95 = [lv["end_to_end_s"]["p95"] for lv in per_level]
    fig, ax = figstyle.figure(height=2.3)
    for values, name, color, marker, dy, va in [(p95, "95th percentile (p95)", figstyle.SERIES[1], "s", 5, "bottom"),
                                                (p50, "Median (p50)", figstyle.SERIES[0], "o", -7, "top")]:
        ax.plot(users, values, color=color, linewidth=1.6, marker=marker, markersize=4.5, label=name,
                markeredgecolor="white", markeredgewidth=0.8)
        for x, y in zip(users, values):
            ax.annotate(f"{y:.1f}", (x, y), xytext=(4 if va == "top" else 0, dy), textcoords="offset points",
                        ha="left" if va == "top" else "center", va=va, fontsize=6.2, color=figstyle.INK)
    ax.set_xticks(users)
    ax.set_xlabel("Simultaneous users")
    ax.set_ylabel("End-to-end workflow time (s)")
    ax.set_ylim(0, max(p95) * 1.15)
    ax.set_xlim(min(users) - 6, max(users) + 8)
    ax.legend(loc="upper left")
    figstyle.save(fig, os.path.join(out, "e5_latency_by_users"))


SERVICE = [("request_commit", "Request commit (ledger)"), ("llm_inference", "LLM inference"),
           ("decision_commit", "Decision commit (ledger)"), ("other", "API, prompt, auditor pickup")]


def plot_components(per_level, out):
    """Top: mean time per workflow including the wait for the model queue.
    Bottom: the same workflows without the queue wait, so every component is readable."""
    users = [lv["users"] for lv in per_level]
    x = list(range(len(users)))
    comp = [lv["components_mean_s"] for lv in per_level]
    service = {key: [] for key, _ in SERVICE}
    for c in comp:
        service["request_commit"].append(c["request_commit"])
        service["llm_inference"].append(c["llm_inference"])
        service["decision_commit"].append(c["decision_commit"])
        service["other"].append(c["request_api"] + c["llm_prompt_check"] + c["auditor_pickup"] + c["decision_api"])
    queue = [c["queue_wait"] for c in comp]
    service_total = [sum(service[k][i] for k, _ in SERVICE) for i in range(len(users))]
    fig, (top, bottom) = figstyle.figure(height=4.0, nrows=2, sharex=True,
                                         gridspec_kw={"height_ratios": [1.15, 1.0]})
    # Top panel: queue wait on top of the service time.
    b1 = top.bar(x, service_total, width=0.6, color=figstyle.SERIES[2], hatch=figstyle.HATCHES[2], edgecolor="white",
                 linewidth=0.6, label="Service time (all components below)")
    b2 = top.bar(x, queue, bottom=service_total, width=0.6, color=figstyle.SERIES[1], hatch=figstyle.HATCHES[1],
                 edgecolor="white", linewidth=0.6, label="Waiting in the LLM queue")
    for xi, q, s in zip(x, queue, service_total):
        top.text(xi, s + q / 2, f"{q:.1f}", ha="center", va="center", fontsize=6.0, color=figstyle.INK,
                 bbox={"boxstyle": "round,pad=0.12", "facecolor": "white", "edgecolor": "none", "alpha": 0.85})
        top.annotate(f"{q + s:.1f} s", (xi, q + s), xytext=(0, 2), textcoords="offset points", ha="center",
                     va="bottom", fontsize=6.0, color=figstyle.INK)
    top.set_ylabel("Mean time (s)")
    top.set_ylim(0, max(q + s for q, s in zip(queue, service_total)) * 1.14)
    top.legend(loc="upper left", fontsize=6.0)
    top.set_title("(a) Whole workflow, including the wait for the model", fontsize=7, loc="left")
    # Bottom panel: service components only.
    base = [0.0] * len(users)
    for i, (key, name) in enumerate(SERVICE):
        vals = service[key]
        bars = bottom.bar(x, vals, bottom=base, width=0.6, color=figstyle.SERIES[[0, 2, 3, 4][i]],
                          hatch=figstyle.HATCHES[[0, 2, 3, 4][i]], edgecolor="white", linewidth=0.6, label=name)
        for bar, v, b0 in zip(bars, vals, base):
            if v >= 0.3:
                bottom.text(bar.get_x() + bar.get_width() / 2, b0 + v / 2, f"{v:.2f}", ha="center", va="center",
                            fontsize=5.8, color=figstyle.INK,
                            bbox={"boxstyle": "round,pad=0.1", "facecolor": "white", "edgecolor": "none", "alpha": 0.85})
        base = [b0 + v for b0, v in zip(base, vals)]
    for xi, total in zip(x, base):
        bottom.annotate(f"{total:.2f} s", (xi, total), xytext=(0, 2), textcoords="offset points", ha="center",
                        va="bottom", fontsize=6.0, color=figstyle.INK)
    bottom.set_ylabel("Mean time (s)")
    bottom.set_ylim(0, max(base) * 1.35)
    bottom.legend(loc="upper left", ncol=2, fontsize=5.8)
    bottom.set_title("(b) The same workflows without the queue wait", fontsize=7, loc="left")
    bottom.set_xticks(x)
    bottom.set_xticklabels([str(u) for u in users])
    bottom.set_xlabel("Simultaneous users")
    figstyle.save(fig, os.path.join(out, "e5_components_by_users"))


def plot_throughput(per_level, out, measured_capacity=None):
    users = [lv["users"] for lv in per_level]
    tput = [lv["throughput_workflows_per_min"]["mean"] for lv in per_level]
    err = [lv["throughput_workflows_per_min"]["sd"] for lv in per_level]
    # Prefer the capacity measured with the model alone (E4); otherwise the in-run service time.
    capacity = measured_capacity or mean([lv["llm"]["capacity_per_min"] for lv in per_level])
    fig, ax = figstyle.figure(height=2.2)
    x = list(range(len(users)))
    bars = ax.bar(x, tput, width=0.58, color=figstyle.SERIES[0], edgecolor="white", yerr=err,
                  error_kw={"elinewidth": 0.7, "capsize": 2.5, "ecolor": figstyle.INK_2}, label="Completed workflows (mean of 3 runs)")
    for bar, v in zip(bars, tput):
        ax.text(bar.get_x() + bar.get_width() / 2, v * 0.5, f"{v:.2f}", ha="center", va="center", fontsize=6.4,
                color=figstyle.INK, bbox={"boxstyle": "round,pad=0.15", "facecolor": "white", "edgecolor": "none", "alpha": 0.9})
    ax.axhline(capacity, color=figstyle.SERIES[1], linewidth=1.2, linestyle="--",
               label=f"LLM capacity alone: {capacity:.2f} per minute")
    ax.set_xticks(x)
    ax.set_xticklabels([str(u) for u in users])
    ax.set_xlabel("Simultaneous users")
    ax.set_ylabel("Workflows per minute")
    ax.set_ylim(0, max(max(tput), capacity) * 1.35)
    ax.legend(loc="upper left", fontsize=6.0)
    figstyle.save(fig, os.path.join(out, "e5_throughput_by_users"))


def plot_resources(per_level, out):
    users = [lv["users"] for lv in per_level]
    machines = ["m1", "m2", "m3", "m4"]
    fig, axes = figstyle.figure(height=3.3, nrows=2, sharex=True)
    for panel, (key, ylabel, scale, fmt) in enumerate([("cpu_mean_cores", "Mean CPU (cores)", 1.0, "{:.2f}"),
                                                       ("mem_max_mb", "Peak memory (GB)", 1 / 1000.0, "{:.2f}")]):
        ax = axes[panel]
        top = 0
        ends = []
        for i, machine in enumerate(machines):
            vals = [(lv["machines"].get(machine, {}).get(key) or 0) * scale for lv in per_level]
            top = max(top, max(vals))
            ax.plot(users, vals, color=figstyle.SERIES[i], marker="osD^"[i], markersize=3.8, linewidth=1.3,
                    label=MACHINE_NAMES[machine], markeredgecolor="white", markeredgewidth=0.6)
            ends.append([vals[-1], vals[-1], f"{MACHINE_NAMES[machine]} {fmt.format(vals[-1])}"])
        # Keep end labels apart: at least 9% of the axis height between neighbours.
        gap = top * 1.35 * 0.09
        ends.sort(key=lambda e: e[0])
        for j in range(1, len(ends)):
            if ends[j][1] - ends[j - 1][1] < gap:
                ends[j][1] = ends[j - 1][1] + gap
        for value, y, text in ends:
            ax.annotate(text, (users[-1], value), xytext=(users[-1] + 3, y), textcoords="data",
                        va="center", fontsize=5.6, color=figstyle.INK)
        ax.set_ylabel(ylabel)
        ax.set_ylim(0, max(top * 1.35, max(e[1] for e in ends) * 1.08))
    axes[0].text(0.01, 0.97, "each VM has 3 vCPUs", transform=axes[0].transAxes, va="top", fontsize=5.8, color=figstyle.INK_2)
    axes[1].text(0.01, 0.97, "each VM has 6.19 GB", transform=axes[1].transAxes, va="top", fontsize=5.8, color=figstyle.INK_2)
    axes[0].legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=4, fontsize=6.0)
    axes[1].set_xticks(users)
    axes[1].set_xlim(min(users) - 5, max(users) + 22)
    axes[1].set_xlabel("Simultaneous users")
    figstyle.save(fig, os.path.join(out, "e5_resources_by_users"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--container-stats", default=None)
    parser.add_argument("--llm-capacity", type=float, default=None,
                        help="recommendations per minute measured with the model alone (E4)")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    per_level, component_rows = analyze(args.run, args.container_stats)
    with open(os.path.join(args.out, "e5-summary.json"), "w") as handle:
        json.dump(per_level, handle, indent=2)
    # The recommendations that disagreed with the written policy, by action and by kind of mistake.
    wrong = [row for row in load_jsonl(os.path.join(args.run, "requests.jsonl"))
             if row.get("phase") == "measured" and row.get("validRecommendation") and not row.get("correct")]
    errors = {
        "count": len(wrong),
        "wrongly_granted": sum(1 for r in wrong if r["expected"] == "DENY" and r["recommendation"] == "ALLOW"),
        "wrongly_refused": sum(1 for r in wrong if r["expected"] == "ALLOW" and r["recommendation"] == "DENY"),
        "by_action": dict(Counter(r["action"] for r in wrong).most_common()),
        "by_profile": dict(Counter(r["profile"] for r in wrong).most_common()),
    }
    with open(os.path.join(args.out, "e5-errors.json"), "w") as handle:
        json.dump(errors, handle, indent=2)
    write_tables(per_level, component_rows, args.out)
    plot_latency(per_level, args.out)
    plot_components(per_level, args.out)
    plot_throughput(per_level, args.out, args.llm_capacity)
    plot_resources(per_level, args.out)
    for lv in per_level:
        e = lv["end_to_end_s"]
        a = lv["accuracy"]
        print(f"{lv['users']:>3} users: {lv['completed']}/{lv['requested']} done, p50 {e['p50']:.1f} s, p95 {e['p95']:.1f} s, "
              f"{lv['throughput_workflows_per_min']['mean']:.2f}/min, LLM {lv['llm']['inference_mean_s']:.2f} s, "
              f"correct {a['correct']}/{a['valid']}, split check {lv['split_check_max_abs_s']:.4f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
