#!/usr/bin/env python3
"""Reuse experiment analysis: the paper's reuse-scope comparison, from the live run.

After round r every record has had r repeated requests. For every r the three
designs of the old replay are compared on the same stream of requests:
  - no reuse: every request needs the model and an auditor review;
  - exact-record reuse (DIAS), measured live: what the ledger did;
  - property-fingerprint reuse (the SEAL design), replayed: the same requests in
    the order the ledger received them, with the same model answers and the same
    auditor decisions, and the scope key of the old replay (the governed
    properties, with no user identity and no record or case id).
Every count comes from the rows the load generator wrote, and the live grants
are checked against the authorizations the ledger itself returned.

Usage: python3 analyze_reuse.py --run <results/reuse-...> --plan <plan.json> --out <dir>
"""

import argparse
import csv
import hashlib
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_e6  # noqa: E402
import container_stats  # noqa: E402
import figstyle  # noqa: E402
import prom  # noqa: E402

DESIGNS = ["no-reuse", "exact-record", "property-fingerprint"]
DESIGN_LABELS = {"no-reuse": "No reuse", "exact-record": "Exact-record (DIAS, live)",
                 "property-fingerprint": "Property fingerprint (replayed)"}
PAPER_REPEATS = [0, 1, 3, 7]


def pct(values, p):
    ordered = sorted(values)
    return ordered[max(1, math.ceil(p * len(ordered))) - 1] if ordered else None


def mean(values):
    return sum(values) / len(values) if values else None


def load_jsonl(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def fingerprint(stream):
    """The old replay's property-fingerprint scope: governed properties only, no identity, record or case id."""
    verified = stream["verifiedRequest"]
    return canonical_hash({
        "scopeVersion": "seal-property-fingerprint",
        "subject": verified["requester"],
        "request": {
            "action": stream["action"],
            "purpose": stream["purpose"],
            "emergencyFlag": verified["request"]["emergencyFlag"],
            "approvalTokenPresent": verified["request"]["approvalTokenPresent"],
        },
        "record": {k: v for k, v in verified["resource"].items() if k != "caseId"},
    })


def inference_s(row):
    """Model inference time in seconds; the backend reports a breakdown whose `inference` part is the model call."""
    latency = row.get("modelLatencyMs")
    if isinstance(latency, dict):
        latency = latency.get("inference")
    return latency / 1000 if latency is not None else None


def queue_s(row):
    """Seconds a reviewed request waited for the model server: recommendation wait minus the model call."""
    inference = inference_s(row)
    ready = row.get("recommendationReadyMs")
    return ready / 1000 - inference if inference is not None and ready is not None else None


def model_denied(row):
    return row.get("validRecommendation") is True and row.get("recommendation") == "DENY"


def empty_counts():
    return {"requests": 0, "reviews": 0, "automatic_grants": 0, "grants_on_approved_record": 0,
            "grants_on_a_different_record": 0, "grants_to_a_different_user": 0, "authorizations_created": 0}


def replay_fingerprint(rows, keys, approve):
    """Replay the property-fingerprint design over rows in ledger order.

    A request whose key already holds an authorization is granted without review;
    any other request is reviewed with the answer the model gave it live, and an
    approved override of a model DENY creates the authorization for its key.
    """
    held = {}
    counts = empty_counts()
    for row in rows:
        counts["requests"] += 1
        key = keys[row["streamId"]]
        if key in held:
            counts["automatic_grants"] += 1
            origin = held[key]
            if origin["recordId"] == row["recordId"]:
                counts["grants_on_approved_record"] += 1
            else:
                counts["grants_on_a_different_record"] += 1
            if origin["username"] != row["username"]:
                counts["grants_to_a_different_user"] += 1
            continue
        if row.get("path") != "reviewed":
            raise ValueError(f"{row['id']}: the replay reviews a request the ledger granted automatically")
        counts["reviews"] += 1
        if model_denied(row) and approve[row["base"]]:
            held[key] = {"recordId": row["recordId"], "username": row["username"]}
            counts["authorizations_created"] += 1
    return counts


def exact_live(rows):
    """Count what the ledger did, checking every automatic grant against the authorization it matched."""
    created = {r["createdAuthorizationId"]: r for r in rows if r.get("createdAuthorizationId")}
    counts = empty_counts()
    for row in rows:
        counts["requests"] += 1
        if row.get("path") == "reused":
            counts["automatic_grants"] += 1
            origin = created.get(row.get("checkedAuthorizationId"))
            if origin is None:
                raise ValueError(f"{row['id']}: granted by an authorization this run did not create")
            if origin["recordId"] == row["recordId"] and origin["caseId"] == row["caseId"]:
                counts["grants_on_approved_record"] += 1
            else:
                counts["grants_on_a_different_record"] += 1
            if origin["username"] != row["username"]:
                counts["grants_to_a_different_user"] += 1
        elif row.get("path") == "reviewed":
            counts["reviews"] += 1
            if row.get("createdAuthorizationId"):
                counts["authorizations_created"] += 1
    return counts


def no_reuse(rows):
    counts = empty_counts()
    counts["requests"] = counts["reviews"] = len(rows)
    return counts


def ledger_order(rows):
    return sorted(rows, key=lambda r: (r["round"], r.get("submittedAt") or r["startedAt"]))


def conditions(rows, keys, approve, rounds):
    """Cumulative counts after each round, for the three designs."""
    ordered = ledger_order(rows)
    out = []
    for r in range(rounds):
        upto = [row for row in ordered if row["round"] <= r]
        for design, counts in [("no-reuse", no_reuse(upto)), ("exact-record", exact_live(upto)),
                               ("property-fingerprint", replay_fingerprint(upto, keys, approve))]:
            avoided = counts["requests"] - counts["reviews"]
            out.append({"repeats": r, "design": design, **counts, "reviews_avoided": avoided,
                        "review_savings_pct": round(100 * avoided / counts["requests"], 2) if counts["requests"] else None})
    return out


def check_ledger(rows, ledger_after):
    """Every authorization the ledger holds for the plan was created by one reviewed row, with its user and record."""
    created = {r["createdAuthorizationId"]: r for r in rows if r.get("createdAuthorizationId")}
    listed = {a["authorizationId"]: a for a in ledger_after["planAuthorizationList"]}
    mismatched = []
    for authorization_id, row in created.items():
        item = listed.get(authorization_id)
        scope = (item or {}).get("scope") or {}
        user = str(scope.get("stableUserId", "")).split("::")[-1]
        expected = (row["recordId"], row["caseId"], row["username"], row.get("action"), row.get("purpose"), row.get("requestId"))
        actual = (scope.get("recordId"), scope.get("caseId"), user, scope.get("action"), scope.get("purpose"),
                  (item or {}).get("originatingRequestId"))
        if item is None or actual != expected or item.get("status") != "active":
            mismatched.append(authorization_id)
    return {"created_by_rows": len(created), "on_ledger_for_plan": len(listed),
            "only_on_ledger": sorted(set(listed) - set(created)), "mismatched": mismatched,
            "pass": not mismatched and set(listed) == set(created)}


def timing(rows):
    reviewed = [r for r in rows if r.get("path") == "reviewed" and r.get("status") == "completed"]
    reused = [r for r in rows if r.get("path") == "reused" and r.get("status") == "completed"]
    seconds = lambda items, field: [r[field] / 1000 for r in items if r.get(field) is not None]  # noqa: E731
    series = {
        "reviewed_end_to_end": seconds(reviewed, "endToEndMs"),
        "reviewed_request_commit": seconds(reviewed, "submitMs"),
        "reviewed_queue_and_model": seconds(reviewed, "recommendationReadyMs"),
        "reviewed_queue_wait": [v for v in (queue_s(r) for r in reviewed) if v is not None],
        "reviewed_model_inference": [v for v in (inference_s(r) for r in reviewed) if v is not None],
        "reviewed_decision_commit": seconds(reviewed, "decisionMs"),
        "reused_end_to_end": seconds(reused, "endToEndMs"),
    }
    return {label: {"n": len(values), "mean_s": mean(values), "p50_s": pct(values, 0.5), "p95_s": pct(values, 0.95)}
            for label, values in series.items()}


def per_round(rows, windows):
    out = []
    for window in windows:
        in_round = [r for r in rows if r["round"] == window["round"]]
        model = [v for v in (inference_s(r) for r in in_round) if v is not None]
        reused = [r["endToEndMs"] / 1000 for r in in_round if r.get("path") == "reused" and r.get("endToEndMs") is not None]
        queue = [v / 60 for v in (queue_s(r) for r in in_round if r.get("path") == "reviewed") if v is not None]
        out.append({**window, "duration_min": window["durationMs"] / 60000,
                    "model_inference_p50_s": pct(model, 0.5), "queue_wait_p50_min": pct(queue, 0.5),
                    "reused_grant_p50_s": pct(reused, 0.5)})
    return out


def resources(start_s, end_s, container_csv, mac_csv):
    """CPU (cores) and memory (GB) of every machine over the run window, as in E6; never fails the analysis."""
    out = {"window_s": [start_s, end_s]}
    try:
        cpu = prom.window_stats(prom.MACHINE_CPU, start_s, end_s, key=lambda labels: labels["machine"])
        mem = prom.window_stats(prom.MACHINE_MEM_USED, start_s, end_s, key=lambda labels: labels["machine"])
        out["machines"] = {m: {"cpu_mean_cores": cpu[m]["mean"], "cpu_max_cores": cpu[m]["max"],
                               "mem_max_gb": mem[m]["max"] / 1e9 if m in mem else None} for m in sorted(cpu)}
    except Exception as error:  # Prometheus may be unreachable when the analysis is re-run later
        out["machines_error"] = str(error)
    if container_csv and os.path.exists(container_csv):
        out["containers"] = [{"machine": k[0], "container": k[1], **v}
                             for k, v in sorted(container_stats.window(container_csv, start_s, end_s).items())]
    if mac_csv and os.path.exists(mac_csv):
        with open(mac_csv) as handle:
            rows = [r for r in csv.DictReader(handle) if start_s <= float(r["epoch_s"]) <= end_s]
        number = lambda r, k: float(r[k]) if r.get(k) not in (None, "") else None  # noqa: E731
        model_cpu = [v for v in (number(r, "model_cpu_cores") for r in rows) if v is not None]
        rss = [v for v in (number(r, "model_rss_bytes") for r in rows) if v is not None]
        gpu = [v for v in (number(r, "gpu_utilization_pct") for r in rows) if v is not None]
        gpu_mem = [v / 1e9 for v in (number(r, "gpu_in_use_memory_bytes") for r in rows) if v is not None]
        # The model's weights sit in GPU (unified) memory, which the process RSS counts only in part.
        out["mac"] = {"samples": len(rows), "model_cpu_mean_cores": mean(model_cpu),
                      "model_cpu_max_cores": max(model_cpu) if model_cpu else None,
                      "model_rss_max_gb": max(rss) / 1e9 if rss else None, "gpu_utilization_mean_pct": mean(gpu),
                      "gpu_memory_mean_gb": mean(gpu_mem), "gpu_memory_max_gb": max(gpu_mem) if gpu_mem else None}
    return out


def resource_outputs(run_info, windows, container_csv, mac_csv, out_dir):
    """CPU and memory of every machine over the run (with round starts marked) and of every container, as in E6."""
    start_s, end_s = run_info["startedAt"] / 1000, run_info["finishedAt"] / 1000
    marks = [(w["startedAt"] / 1000 - start_s) / 60 for w in windows]
    period = f"over the {(end_s - start_s) / 3600:.1f}-hour run"
    if container_csv and os.path.exists(container_csv):
        containers = analyze_e6.container_table(container_csv, start_s, end_s)
        write_csv(os.path.join(out_dir, "reuse-containers.csv"), [
            {"machine": c["machine"], "container": c["container"], "cpu_mean_cores": round(c["cpu_mean_cores"], 4),
             "cpu_max_cores": round(c["cpu_max_cores"], 4),
             "mem_max_mb": round(c["mem_max_mb"], 1) if c["mem_max_mb"] is not None else None, "samples": c["samples"]}
            for c in containers])
        analyze_e6.plot_containers(containers, out_dir, name="reuse_containers", period=period)
    try:
        cpu, mem = analyze_e6.machine_series(start_s, end_s)
    except Exception as error:  # Prometheus may be unreachable when the analysis is re-run later
        print(f"machine CPU/memory figure skipped: {error}")
        return
    mac_rows = analyze_e6.mac_series(mac_csv, start_s, end_s) if mac_csv and os.path.exists(mac_csv) else []
    analyze_e6.plot_machines(cpu, mem, mac_rows, start_s, out_dir, name="reuse_machines_cpu_memory", marks=marks)
    rows = []
    for machine in sorted(cpu):
        cores = [v for _, v in cpu[machine]]
        gb = [v / 1e9 for _, v in mem.get(machine, [])]
        rows.append({"machine": machine, "cpu_mean_cores": round(mean(cores), 4), "cpu_max_cores": round(max(cores), 4),
                     "mem_mean_gb": round(mean(gb), 3) if gb else None, "mem_max_gb": round(max(gb), 3) if gb else None,
                     "samples": len(cores)})
    if mac_rows:
        model_cpu = [float(r["model_cpu_cores"]) for r in mac_rows]
        model_gb = [float(r["model_rss_bytes"]) / 1e9 for r in mac_rows]
        rows.append({"machine": "m5 (Mac: model server, process memory)", "cpu_mean_cores": round(mean(model_cpu), 4),
                     "cpu_max_cores": round(max(model_cpu), 4), "mem_mean_gb": round(mean(model_gb), 3),
                     "mem_max_gb": round(max(model_gb), 3), "samples": len(mac_rows)})
        gpu_gb = [float(r["gpu_in_use_memory_bytes"]) / 1e9 for r in mac_rows if r.get("gpu_in_use_memory_bytes")]
        if gpu_gb:
            rows.append({"machine": "m5 (Mac: GPU memory in use)", "cpu_mean_cores": None, "cpu_max_cores": None,
                         "mem_mean_gb": round(mean(gpu_gb), 3), "mem_max_gb": round(max(gpu_gb), 3),
                         "samples": len(gpu_gb)})
    write_csv(os.path.join(out_dir, "reuse-machines.csv"), rows)


def write_csv(path, rows):
    with open(path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def plot_scope(cells, out_dir, repeats_shown):
    fig, (left, right) = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=2.4, ncols=2)
    width = 0.26
    xs = list(range(len(repeats_shown)))
    counted = {c["repeats"]: c["requests"] for c in cells if c["design"] == "no-reuse"}
    ticks = [f"{r}\n({counted[r]:,})" for r in repeats_shown]
    tallest = {"reviews": 1, "grants_on_a_different_record": 1}
    for i, design in enumerate(DESIGNS):
        values = [next(c["reviews"] for c in cells if c["repeats"] == r and c["design"] == design) for r in repeats_shown]
        tallest["reviews"] = max([tallest["reviews"], *values])
        bars = left.bar([x + (i - 1) * width for x in xs], values, width, label=DESIGN_LABELS[design],
                        color=figstyle.SERIES[i], hatch=figstyle.HATCHES[i], edgecolor="white", linewidth=0.4)
        figstyle.label_bars(left, bars, fmt="{:,.0f}", size=5.2)
    left.set_xticks(xs, ticks)
    left.set_xlabel("Repeated requests per record (all requests so far)")
    left.set_ylabel("Auditor reviews needed")
    left.set_title("(a) Reviews needed", loc="left")
    left.set_ylim(0, tallest["reviews"] * 1.42)
    left.legend(loc="upper left", fontsize=5.8)
    for i, design in enumerate(DESIGNS[1:], start=1):
        values = [next(c["grants_on_a_different_record"] for c in cells if c["repeats"] == r and c["design"] == design)
                  for r in repeats_shown]
        tallest["grants_on_a_different_record"] = max([tallest["grants_on_a_different_record"], *values])
        bars = right.bar([x + (i - 1.5) * width for x in xs], values, width, label=DESIGN_LABELS[design],
                         color=figstyle.SERIES[i], hatch=figstyle.HATCHES[i], edgecolor="white", linewidth=0.4)
        figstyle.label_bars(right, bars, fmt="{:,.0f}", size=5.6)
    right.set_xticks(xs, ticks)
    right.set_xlabel("Repeated requests per record (all requests so far)")
    right.set_ylabel("Automatic grants on a record\nthe auditor did not approve")
    right.set_title("(b) Grants outside the approved record", loc="left")
    right.set_ylim(0, tallest["grants_on_a_different_record"] * 1.42)
    right.legend(loc="upper left", fontsize=5.8)
    figstyle.save(fig, os.path.join(out_dir, "reuse_scope_by_repeats"))


def plot_rounds(rounds, out_dir):
    fig, ax = figstyle.figure(height=2.3)
    xs = [w["round"] for w in rounds]
    reviewed = [w["reviewed"] for w in rounds]
    reused = [w["reused"] for w in rounds]
    bottom = ax.bar(xs, reviewed, 0.6, label="Reviewed (model and auditor)", color=figstyle.SERIES[0],
                    edgecolor="white", linewidth=0.4)
    top = ax.bar(xs, reused, 0.6, bottom=reviewed, label="Granted by an exact-record authorization",
                 color=figstyle.SERIES[2], hatch=figstyle.HATCHES[2], edgecolor="white", linewidth=0.4)
    figstyle.label_bars(ax, bottom, fmt="{:.0f}", inside=True, size=5.6, color="#ffffff")
    figstyle.label_bars(ax, top, fmt="{:.0f}", inside=True, size=5.6)
    ax.set_xticks(xs, [f"{x}\n{w['duration_min']:.1f}" for x, w in zip(xs, rounds)])
    ax.set_xlabel("Round, and below it the round's duration (min)")
    ax.set_ylabel("Requests in the round")
    ax.set_ylim(0, max(r + u for r, u in zip(reviewed, reused)) * 1.28)
    ax.legend(loc="upper right", fontsize=5.8)
    figstyle.save(fig, os.path.join(out_dir, "reuse_requests_by_round"))


def plot_time(times, rounds, out_dir):
    """(a) Each request's own processing time by component; (b) the wait for the single model server by round."""
    fig, (left, right) = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=2.2, ncols=2)
    parts = [("Request commit", "reviewed_request_commit"), ("Model inference", "reviewed_model_inference"),
             ("Decision commit", "reviewed_decision_commit")]
    start = 0.0
    for i, (label, key) in enumerate(parts):
        value = times[key]["p50_s"] or 0
        bars = left.barh([1], [value], 0.5, left=start, label=label, color=figstyle.SERIES[i],
                         hatch=figstyle.HATCHES[i], edgecolor="white", linewidth=0.4)
        left.text(start + value / 2, 1, f"{value:.2f}", ha="center", va="center", fontsize=5.8,
                  color="#ffffff" if i != 2 else figstyle.INK)
        start += value
    left.text(start + 0.15, 1, f"{start:.2f} s", va="center", fontsize=6.2, color=figstyle.INK)
    reused = times["reused_end_to_end"]["p50_s"] or 0
    left.barh([0], [reused], 0.5, color=figstyle.SERIES[3], hatch=figstyle.HATCHES[3], edgecolor="white",
              linewidth=0.4, label="Request commit with automatic grant")
    left.text(reused + 0.15, 0, f"{reused:.2f} s", va="center", fontsize=6.2, color=figstyle.INK)
    left.set_yticks([0, 1], ["Reused request\n(contract only)", "Reviewed request\n(model and auditor)"])
    left.set_xlim(0, start * 1.3)
    left.set_xlabel("Median processing time per request (s), without queueing")
    left.set_title("(a) Processing time by component", loc="left")
    left.grid(axis="x", color=figstyle.GRID, linewidth=0.5)
    left.grid(axis="y", visible=False)
    left.legend(loc="lower right", fontsize=5.4)

    xs = [w["round"] for w in rounds]
    waits = [w["queue_wait_p50_min"] or 0 for w in rounds]
    bars = right.bar(xs, waits, 0.6, color=[figstyle.SERIES[0]] + [figstyle.SERIES[2]] * (len(xs) - 1),
                     edgecolor="white", linewidth=0.4)
    figstyle.label_bars(right, bars, fmt="{:.1f}", size=5.8)
    right.set_xticks(xs)
    right.set_xlabel("Round (round 0: no authorization exists yet)")
    right.set_ylabel("Median wait for the model server (min)")
    right.set_ylim(0, max(waits) * 1.22 if waits else 1)
    right.set_title("(b) Queue wait of reviewed requests", loc="left")
    figstyle.save(fig, os.path.join(out_dir, "reuse_time_by_path"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--container-stats")
    parser.add_argument("--mac-samples")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    with open(args.plan) as handle:
        plan = json.load(handle)
    with open(os.path.join(args.run, "rounds.json")) as handle:
        windows = json.load(handle)
    run_file = os.path.join(args.run, "run.json")
    run_info = None
    if os.path.exists(run_file):
        with open(run_file) as handle:
            run_info = json.load(handle)
    rows = load_jsonl(os.path.join(args.run, "requests.jsonl"))
    streams = {s["streamId"]: s for s in plan["streams"]}
    keys = {sid: fingerprint(s) for sid, s in streams.items()}
    approve = {b["base"]: b["approveIfModelDenies"] for b in plan["bases"]}
    rounds_done = len(windows)

    planned = {(r["round"], sid) for r in plan["rounds"][:rounds_done] for order in r["order"].values() for sid in order}
    seen = [(row["round"], row["streamId"]) for row in rows]
    failed = [row for row in rows if row.get("status") != "completed"]
    checks = {
        "rows": len(rows), "planned": len(planned), "missing": len(planned - set(seen)),
        "duplicates": len(seen) - len(set(seen)), "failed": len(failed),
        "failures": sorted({f"{r.get('stage')}: {str(r.get('error'))[:120]}" for r in failed}),
        "facts_mismatched": sum(1 for r in rows if r.get("plannedFactsMatch") is False),
    }
    reviewed = [r for r in rows if r.get("path") == "reviewed" and r.get("status") == "completed"]
    valid = [r for r in reviewed if r.get("validRecommendation")]
    model = {"reviewed": len(reviewed), "valid": len(valid), "correct": sum(1 for r in valid if r.get("correct")),
             "overrides_of_model_deny": sum(1 for r in reviewed if r.get("overrideOfModelDeny"))}
    ledger_file = os.path.join(args.run, "ledger-after.json")
    ledger = None
    if os.path.exists(ledger_file):
        with open(ledger_file) as handle:
            ledger = check_ledger(rows, json.load(handle))

    completed = [r for r in rows if r.get("status") == "completed"]
    cells = conditions(completed, keys, approve, rounds_done)
    rounds = per_round(rows, windows)
    times = timing(rows)
    approved_records = sorted({r["recordId"] for r in completed if r.get("createdAuthorizationId")})
    requests_per_round = len(plan["streams"])
    summary = {
        "plan": plan["meta"], "checks": checks, "model_on_reviewed_requests": model, "ledger_check": ledger,
        "records": requests_per_round, "approved_records": len(approved_records),
        "approved_bases": sum(1 for b in plan["bases"] if b["approveIfModelDenies"]),
        "conditions": [c for c in cells if c["repeats"] in PAPER_REPEATS], "rounds": rounds, "time": times,
        "run": {k: run_info.get(k) for k in ["startedAtUtc", "finishedAtUtc", "totals", "planSha256", "codeSha256"]}
        if run_info else None,
        "resources": resources(run_info["startedAt"] / 1000, run_info["finishedAt"] / 1000,
                               args.container_stats, args.mac_samples) if run_info else None,
    }
    with open(os.path.join(args.out, "reuse-summary.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    write_csv(os.path.join(args.out, "reuse-conditions.csv"), cells)
    write_csv(os.path.join(args.out, "reuse-rounds.csv"), rounds)

    shown = [r for r in PAPER_REPEATS if r < rounds_done] or list(range(rounds_done))
    plot_scope(cells, args.out, shown)
    plot_rounds(rounds, args.out)
    plot_time(times, rounds, args.out)
    if run_info:
        resource_outputs(run_info, windows, args.container_stats, args.mac_samples, args.out)
    print(json.dumps({k: summary[k] for k in ["checks", "model_on_reviewed_requests", "ledger_check",
                                              "records", "approved_records"]}, indent=1))
    for cell in summary["conditions"]:
        print(f"r={cell['repeats']} {cell['design']:22s} requests {cell['requests']:5d} reviews {cell['reviews']:5d} "
              f"avoided {cell['reviews_avoided']:5d} ({cell['review_savings_pct']}%) "
              f"other-record grants {cell['grants_on_a_different_record']} other-user grants {cell['grants_to_a_different_user']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
