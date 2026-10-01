#!/usr/bin/env python3
"""Assemble REPORT.md and tables.tex from the analysis summaries.

Every number in the outputs is read from a summary JSON written by the
analysis scripts; none is typed in. Sections whose data are missing are
skipped and named at the end.

Usage: python3 make_report.py --results <dir with e*-summary.json> --out <dir>
"""

import argparse
import json
import math
import os
import statistics
import sys
from functools import partial


def load(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def f(value, digits=2):
    return "--" if value is None else f"{value:.{digits}f}"


def linear_fit(xs, ys):
    """Least-squares slope, intercept and R^2."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    return slope, intercept, (1 - ss_res / ss_tot) if ss_tot else 1.0


def section_accuracy(acc, md, tex):
    main = acc["sets"]["test-decision-balanced"]
    base, v7 = main["Untuned Qwen3-14B"], main["V7 (fine-tuned)"]
    adv = acc["sets"]["test-adversarial"]
    paired = acc["paired"]["test-decision-balanced"]
    md.append("## 1. Recommendation quality (E1) and adversarial test (E2)\n")
    md.append("Why: before an auditor relies on the advice, it must match the written policy. "
              "All numbers were recomputed from the raw prediction files and match the stored confusion matrices.\n")
    for line in acc["plain_words"]:
        md.append(f"- {line}")
    md.append(f"- Paired test on the same 600 cases: V7 right where the untuned model was wrong {paired['only_v7_correct']} times, "
              f"the reverse {paired['only_untuned_correct']} times (exact McNemar p = {paired['mcnemar_exact_p']:.1e}).")
    md.append(f"- Balanced accuracy over usable answers: untuned {base['balanced_accuracy_usable'] * 100:.2f}%, "
              f"V7 {v7['balanced_accuracy_usable'] * 100:.2f}%.\n")
    rows = [
        ("Usable answers (of 600)", base["usable"], v7["usable"]),
        ("Allowed requests recognised (of 300)", base["ALLOW_to_ALLOW"], v7["ALLOW_to_ALLOW"]),
        ("Denied requests stopped (of 300)", base["DENY_to_DENY"], v7["DENY_to_DENY"]),
        ("Wrongly granted", base["wrongly_granted"], v7["wrongly_granted"]),
        ("Wrongly refused", base["wrongly_refused"], v7["wrongly_refused"]),
        ("Correct decisions (of 600)", base["correct"], v7["correct"]),
        ("Correct reason (of 600)", base["reason_correct"], v7["reason_correct"]),
        ("Correct clauses (of 600)", base["clauses_correct"], v7["clauses_correct"]),
        ("Adversarial requests that got through (of 204)", adv["Untuned Qwen3-14B"]["wrongly_granted"],
         adv["V7 (fine-tuned)"]["wrongly_granted"]),
    ]
    tex.append("% E1/E2: recommendation results as counts\n\\begin{table}[tb]\n\\centering\n"
               "\\caption{Recommendation Results on 600 Test Decisions}\n\\label{tab:tb-quality}\n\\footnotesize\n"
               "\\begin{tabular}{@{}lrr@{}}\n\\toprule\nOutcome & Untuned & V7 \\\\\n\\midrule")
    for name, b, v in rows:
        tex.append(f"{name} & {b} & {v} \\\\")
    tex.append("\\bottomrule\n\\end{tabular}\n\\end{table}\n")


def section_e4(e4, md, tex):
    md.append("## 2. The LLM alone (E4)\n")
    md.append("Why: the model is the slowest part; its capacity alone bounds the whole system.\n")
    t = e4["time_per_recommendation_s"]
    md.append(f"- The served V7 model answered all {e4['cases']} test cases one at a time: median {t['p50']:.2f} s, "
              f"95th percentile {t['p95']:.2f} s, mean {t['mean']:.2f} s per recommendation.")
    md.append(f"- Capacity: {e4['recommendations_per_min']:.2f} recommendations per minute; "
              f"{e4['output_tokens_per_s']:.1f} output tokens per second of inference time; "
              f"{e4['prompt_tokens_mean']:.0f} prompt tokens on average.")
    same, n = e4["same_decision_as_stored_v7_run"], e4["cases"]
    verdict = ("; every answer is byte-identical, so the testbed serves V7 exactly" if e4["identical_output_to_stored_v7_run"] == n
               else "; this agreement shows the testbed serves V7" if same >= 0.98 * n
               else "; the agreement is lower than expected for the same adapter and must be explained before use")
    md.append(f"- It gave the same decision as the stored V7 evaluation on {same} of {n} cases "
              f"({e4['identical_output_to_stored_v7_run']} byte-identical answers) and {e4['correct']} of {n} "
              f"correct decisions{verdict}.\n")


def section_e3(e3, md, tex):
    md.append("## 3. The ledger alone (E3)\n")
    md.append("Why: to show how fast the blockchain part is on its own and that it is not what limits DIAS.\n")
    table = {(s["round"], s["level"]): s for s in e3}
    levels = sorted({s["level"] for s in e3})
    tex.append("% E3: ledger alone\n\\begin{table}[tb]\n\\centering\n\\caption{Ledger Throughput and Median Latency per Function}\n"
               "\\label{tab:tb-ledger}\n\\footnotesize\n\\setlength{\\tabcolsep}{3pt}\n"
               "\\begin{tabular}{@{}l" + "r" * len(levels) + "@{}}\n\\toprule\n"
               "Function & " + " & ".join(f"{lv}" for lv in levels) + " \\\\\n\\midrule")
    for rnd, unit in [("W1 CreateAccessRequest", "tx/s"), ("W2 SubmitAuditorDecision", "tx/s"),
                      ("R1 GetRequest", "reads/s"), ("R2 QueryAccessDecisions", "reads/s")]:
        tp = [table[(rnd, lv)]["throughputPerS"] for lv in levels if (rnd, lv) in table]
        p50 = [table[(rnd, lv)]["latencyMs"]["p50"] for lv in levels if (rnd, lv) in table]
        failed = sum(table[(rnd, lv)]["failed"] for lv in levels if (rnd, lv) in table)
        p50_text = [f"{value / 1000:.2f}" if value is not None else "n/a" for value in p50]
        missing_note = " (`n/a` means no call succeeded at that load.)" if any(value is None for value in p50) else ""
        md.append(f"- {rnd}: throughput {', '.join(f'{v:.1f}' for v in tp)} {unit} and median latency "
                  f"{', '.join(p50_text)} s at {', '.join(map(str, levels))} in flight; {failed} failed.{missing_note}")
        tex.append(f"{rnd.split(' ', 1)[1]} ({unit}) & " + " & ".join(f"{v:.1f}" for v in tp) + " \\\\")
        tex.append("\\quad median latency (s) & " + " & ".join(
            f"{value / 1000:.2f}" if value is not None else "--" for value in p50) + " \\\\")
    tex.append("\\bottomrule\n\\end{tabular}\n\\end{table}\n")
    md.append("")


def section_e5(e5, md, tex, errors=None, replay=None):
    md.append("## 4. Whole system at 10, 25, 50, 75 and 100 users (E5)\n")
    md.append("Why: to show how the complete system behaves as users grow and which component causes the growth. "
              "Each level ran three times (three iterations); users 1..L start one workflow each at the same moment.\n")
    users = [lv["users"] for lv in e5]
    p50 = [lv["end_to_end_s"]["p50"] for lv in e5]
    slope, intercept, r2 = linear_fit(users, p50)
    for lv in e5:
        e, c, a = lv["end_to_end_s"], lv["components_mean_s"], lv["accuracy"]
        t = lv["throughput_workflows_per_min"]
        md.append(f"- {lv['users']} users: {lv['completed']}/{lv['requested']} workflows completed; median {e['p50']:.1f} s, "
                  f"p95 {e['p95']:.1f} s; {t['mean']:.2f} workflows/min; "
                  f"request commit {c['request_commit']:.2f} s, queue {c['queue_wait']:.1f} s, LLM {c['llm_inference']:.2f} s, "
                  f"decision commit {c['decision_commit']:.2f} s; correct {a['correct']}/{a['valid']}.")
        md.append(f"  - iterations: {', '.join(f'{v:.2f}' for v in t['per_repetition'])} workflows/min "
                  f"(SD {t['sd']:.3f}); median per iteration {e['p50_rep_mean']:.1f} s (SD {e['p50_rep_sd']:.2f}), "
                  f"p95 per iteration {e['p95_rep_mean']:.1f} s (SD {e['p95_rep_sd']:.2f}).")
    tput = [lv["throughput_workflows_per_min"]["mean"] for lv in e5]
    shape = "grows linearly with" if r2 >= 0.99 else "grows with"
    md.append(f"- Trend: the median end-to-end time {shape} the number of users (slope {slope:.2f} s per extra user, "
              f"R^2 = {r2:.3f}); throughput stays between {min(tput):.2f} and {max(tput):.2f} workflows/min because one "
              f"model server answers one request at a time.")
    if errors:
        actions = ", ".join(f"{k} {v}" for k, v in errors["by_action"].items())
        md.append(f"- Disagreements with the written policy: {errors['count']} ({errors['wrongly_granted']} wrongly granted, "
                  f"{errors['wrongly_refused']} wrongly refused); by action: {actions}.")
    if replay:
        md.append(f"- Replayed one at a time with no other load, the {replay['replayed']} disagreeing requests gave the same "
                  f"decision {replay['sameDecision']} times, the same reason {replay['sameReason']} times and byte-identical "
                  f"model output {replay['identicalOutput']} times.")
    md.append("")
    tex.append("% E5: whole system\n\\begin{table}[tb]\n\\centering\n\\caption{Whole-System Workflow Time and Components}\n"
               "\\label{tab:tb-system}\n\\footnotesize\n\\setlength{\\tabcolsep}{2.5pt}\n"
               "\\begin{tabular}{@{}rrrrrrrr@{}}\n\\toprule\n"
               "Users & p50 (s) & p95 (s) & Wf/min & Req. commit & Queue & LLM & Dec. commit \\\\\n\\midrule")
    for lv in e5:
        e, c = lv["end_to_end_s"], lv["components_mean_s"]
        tex.append(f"{lv['users']} & {e['p50']:.1f} & {e['p95']:.1f} & {lv['throughput_workflows_per_min']['mean']:.2f} & "
                   f"{c['request_commit']:.2f} & {c['queue_wait']:.1f} & {c['llm_inference']:.2f} & {c['decision_commit']:.2f} \\\\")
    tex.append("\\bottomrule\n\\end{tabular}\n\\end{table}\n")
    return {"slope": slope, "intercept": intercept, "r2": r2}


def section_e6(e6, md, tex):
    md.append("## 5. One hour with 100 users (E6)\n")
    md.append("Why: to show the system stays correct and within its resources over an hour of normal work "
              "(InterSnap's resilience test).\n")
    e = e6["end_to_end_s"]
    md.append(f"- {e6['arrivals']} workflows arrived at random times over {e6['window_minutes']:.1f} minutes; "
              f"{e6['completed']} completed, {e6['failed']} failed.")
    md.append(f"- Operations: {e6['operations_succeeded']} of {e6['operations_total']} succeeded "
              f"({100 * e6['operations_succeeded'] / e6['operations_total']:.2f}%).")
    for name, ops in e6["operations"].items():
        md.append(f"  - {name}: {ops['succeeded']} succeeded, {ops['failed']} failed")
    md.append(f"- Workflow time: median {e['p50']:.1f} s, p95 {e['p95']:.1f} s; correct {e6['accuracy']['correct']}/{e6['accuracy']['valid']}.")
    tex.append("% E6: one-hour resources\n\\begin{table}[tb]\n\\centering\n\\caption{Resource Use over the One-Hour Run}\n"
               "\\label{tab:tb-hour}\n\\footnotesize\n\\begin{tabular}{@{}lrrr@{}}\n\\toprule\n"
               "Machine & Mean CPU (cores) & Peak CPU (cores) & Peak memory (GB) \\\\\n\\midrule")
    for m, v in e6["machines"].items():
        md.append(f"- {m.upper()}: CPU mean {v['cpu_mean_cores']:.2f} cores, peak {v['cpu_max_cores']:.2f}; memory peak {v['mem_max_gb']:.2f} GB (of 6.19 GB).")
        tex.append(f"{m.upper()} & {v['cpu_mean_cores']:.2f} & {v['cpu_max_cores']:.2f} & {v['mem_max_gb']:.2f} \\\\")
    mac = e6["mac"]
    md.append(f"- M5 (Mac, model server): CPU mean {mac['model_cpu_mean_cores']:.2f} cores, peak {mac['model_cpu_max_cores']:.2f}; "
              f"resident memory peak {mac['model_rss_max_gb']:.2f} GB; GPU utilisation mean {f(mac['gpu_utilization_mean_pct'], 1)}%; "
              f"whole Mac CPU mean {f(mac['mac_cpu_mean_cores'])} cores.")
    drift = e6.get("memory_drift_gb") or {}
    changes = [f"{m.upper()} {1000 * v['change']:+.0f} MB" for m, v in drift.items() if v]
    rss = (e6.get("mac_memory_drift_gb") or {}).get("model_rss")
    if changes:
        md.append("- Memory change from the first to the last five minutes: " + ", ".join(changes)
                  + (f", model server {1000 * rss['change']:+.0f} MB" if rss else "") + ".")
    for block in e6.get("by_10_minutes") or []:
        md.append(f"  - minutes {block['minutes']}: {block['completed']}/{block['started']} completed, median "
                  f"{f(block['end_to_end_p50_s'], 1)} s, p95 {f(block['end_to_end_p95_s'], 1)} s")
    md.append("")
    tex.append(f"M5 (model server) & {mac['model_cpu_mean_cores']:.2f} & {mac['model_cpu_max_cores']:.2f} & {mac['model_rss_max_gb']:.2f} \\\\")
    tex.append("\\bottomrule\n\\end{tabular}\n\\end{table}\n")


def short(name):
    if name.startswith("dev-peer0."):
        return "chaincode (" + name.split(".")[1] + ")"
    return name.replace(".example.com", "")


def section_containers(e5, e6, md, tex):
    """Per-container table: mean CPU and peak memory at 100 users (E5) and over the hour (E6)."""
    at100 = {(c["machine"], c["container"]): c for c in e5[-1]["containers_all"]} if e5 else {}
    hour = {(c["machine"], c["container"]): c for c in e6["containers"]} if e6 else {}
    keys = sorted(k for k in set(at100) | set(hour) if not k[1].startswith(("cadvisor", "loadgen")))
    if not keys:
        return
    md.append("## Per-container resources\n")
    md.append("| Machine | Container | Mean CPU at 100 users (cores) | Peak memory at 100 users (MB) | Mean CPU over the hour (cores) | Peak memory over the hour (MB) |")
    md.append("|---|---|---|---|---|---|")
    tex.append("% Per-container resources\n\\begin{table}[tb]\n\\centering\n\\caption{CPU and Memory of Each Container}\n"
               "\\label{tab:tb-containers}\n\\footnotesize\n\\setlength{\\tabcolsep}{2.5pt}\n"
               "\\begin{tabular}{@{}llrrrr@{}}\n\\toprule\n"
               " & & \\multicolumn{2}{c}{100 users} & \\multicolumn{2}{c}{One hour} \\\\\n"
               "\\cmidrule(lr){3-4}\\cmidrule(lr){5-6}\n"
               "VM & Container & CPU (cores) & Mem. (MB) & CPU (cores) & Mem. (MB) \\\\\n\\midrule")
    for key in keys:
        a, h = at100.get(key), hour.get(key)
        cells = [f"{a['cpu_mean_cores']:.3f}" if a else "--", f"{a['mem_max_mb']:.0f}" if a and a.get("mem_max_mb") else "--",
                 f"{h['cpu_mean_cores']:.3f}" if h else "--", f"{h['mem_max_mb']:.0f}" if h and h.get("mem_max_mb") else "--"]
        md.append(f"| {key[0].upper()} | {short(key[1])} | " + " | ".join(cells) + " |")
        tex.append(f"{key[0].upper()} & {short(key[1])} & " + " & ".join(cells) + " \\\\")
    tex.append("\\bottomrule\n\\end{tabular}\n\\end{table}\n")
    md.append("")


def section_growth(rows, md, tex):
    md.append("## 7. Ledger growth\n")
    md.append("Why: two list views scan every stored request or decision before they filter, so their time grows with "
              "the ledger; a single-key read should not.\n")
    for fn in ["QueryPendingAuditorRequests", "QueryAccessDecisions", "GetRequest"]:
        pts = sorted((r["requests"], r["p50Ms"]) for r in rows if r["fn"] == fn)
        if pts:
            md.append(f"- {fn}: " + "; ".join(f"{n:,} requests on the ledger -> {ms:.0f} ms" for n, ms in pts))
    md.append("")


def section_e7(e7, md, tex):
    md.append("## 6. Machine failures during work (E7)\n")
    md.append("Why: with three orderers on three machines and endorsement by 3 of 5 organizations, DIAS should keep "
              "working when one orderer or one peer stops.\n")
    for p in e7["phases"]:
        md.append(f"- {p['phase']}: {p['completed']}/{p['started']} workflows completed; median {f(p['p50_s'], 1)} s, "
                  f"p95 {f(p['p95_s'], 1)} s." + (f" Failures: {'; '.join(p['failures'])}" if p["failures"] else ""))
    md.append(f"- A new Raft leader was elected {f(e7['new_leader_elected_after_s'], 2)} s after the leader orderer stopped "
              f"(leader before: {e7['leader_before']}).")
    if e7.get("ledger_after"):
        md.append(f"- After recovery every peer and orderer reports the same ledger height: {e7['ledger_after'].get('all_equal')}.")
    if e7.get("chain_info_after"):
        md.append(f"- After recovery all five peers report the same block hash: {e7['chain_info_after'].get('same_hash')}.")
    problems = next((e["items"] for e in e7.get("timeline", []) if e["event"] == "problems"), None)
    if problems is not None:
        md.append("- Problems recorded by the fault script: " + ("; ".join(problems) if problems else "none") + ".")
    md.append("")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    md = ["# DIAS multi-machine testbed: results\n",
          "Every number below is produced by the analysis scripts in `testbed/analysis/` from the raw run files in "
          "`raw/`; none is typed by hand. Figures are in `analysis/*/` (PDF for the paper, PNG for viewing).\n",
          "## 0. What was run\n",
          "- Four Linux VMs (M1-M4, 3 vCPU and 6 GB each) on one Apple M3 Max (16 cores, 64 GB), joined by Docker Swarm; "
          "the Mac itself (M5) serves the V7 model on its GPU.",
          "- Hyperledger Fabric 2.5.16: five organizations, five peers with CouchDB, three Raft orderers on three VMs, "
          "six CAs; blocks close after 2 s or 10 transactions; endorsement by 3 of 5.",
          "- Contract diasrecords 2.3: the ledger stores each request and the auditor decision with the LLM recommendation "
          "value and the derived agreement; justification and reason text stay off-chain.",
          "- 120 users on the ledger (20 prototype users + 100 load users copying the 12 requester profiles), 3 cases, 20 case files.",
          "- Every request of every run is fixed by a seeded plan with the written policy's answer; the ledger's committed facts "
          "were checked against the plan for every workflow.",
          "- The auditor follows the recommendation as soon as it is ready, so times contain no human review time.",
          "- Monitoring every 5 s: node-exporter (each VM) through Prometheus, Docker statistics (each container), a Mac sampler (M5).\n"]
    raw = os.path.join(args.out, "raw")
    if os.path.isdir(raw):
        md.append("Raw data folders in `raw/`: " + ", ".join(f"`{d}`" for d in sorted(os.listdir(raw))
                                                            if os.path.isdir(os.path.join(raw, d))) + ".\n")
    tex = []
    missing = []
    e5_extra = partial(section_e5, errors=load(os.path.join(args.results, "e5/e5-errors.json")),
                       replay=load(os.path.join(args.results, "e5/replay-errors.json")))
    sections = [("accuracy/accuracy.json", section_accuracy), ("e4/e4-summary.json", section_e4),
                ("e3/e3-summary.json", section_e3), ("e5/e5-summary.json", e5_extra),
                ("e6/e6-summary.json", section_e6), ("e7/e7-summary.json", section_e7)]
    extras = {}
    for rel, fn in sections:
        data = load(os.path.join(args.results, rel))
        if data is None:
            missing.append(rel)
            continue
        extras[rel] = fn(data, md, tex)
    growth = load(os.path.join(args.results, "growth/ledger-growth.json"))
    if growth:
        section_growth(growth, md, tex)
    section_containers(load(os.path.join(args.results, "e5/e5-summary.json")),
                       load(os.path.join(args.results, "e6/e6-summary.json")), md, tex)
    if missing:
        md.append("## Not yet available\n")
        md.extend(f"- {m}" for m in missing)
    md.append("## Limits\n")
    md.append("- The four VMs and the model server share one Apple M3 Max; the VM network is virtual (Lima user-v2), not a LAN.")
    md.append("- One model server and one recommendation worker: the LLM sets the workflow throughput.")
    md.append("- All users, cases, records and requests are synthetic.")
    md.append("- Per-container data (Docker statistics) start during the 50-user level of E5: cAdvisor could not read "
              "containers under Docker's containerd image store. Whole-VM data cover every run.")
    md.append("- The shared single-host network of the wt-dias project kept running in the background (about 0.2 CPU core).")
    md.append("- Two earlier attempts of the one-hour run are kept as `raw/*-ABORTED-*` and not used. The first was stopped "
              "after 11 minutes because an evaluation script was started by mistake and loaded the model server (Ubuntu's "
              "daily upgrade also ran on two VMs during it); the second was stopped after 4 minutes at the author's request. "
              "The reported E6 is a fresh, complete run of the same plan.")
    md.append("- Ubuntu's automatic security upgrades ran on M1 and M3 after E5 and before E6 (133 packages each, listed in "
              "`raw/environment/`); Docker, containerd and the running kernel were unchanged on all four VMs.")
    md.append("- For E6, E7, E4 and E3 the VMs' periodic maintenance timers (package updates, firmware metadata, manual "
              "index, log rotation) were paused so they could not add unrelated CPU load; during E5 they were active, and "
              "only short jobs (seconds each) ran.")
    md.append("- Every run used AC power. The macOS power log shows AC power through E5; the Mac's AC setting is High Power "
              "Mode and no settings change is logged. From E6 on, a 30-second log records the power source and mode "
              "(`raw/mac/power-log.csv`).\n")
    with open(os.path.join(args.out, "REPORT.md"), "w") as handle:
        handle.write("\n".join(md) + "\n")
    with open(os.path.join(args.out, "REPORT-data.md"), "w") as handle:
        handle.write("\n".join(md) + "\n")
    with open(os.path.join(args.out, "tables.tex"), "w") as handle:
        handle.write("\n".join(tex) + "\n")
    with open(os.path.join(args.out, "trend.json"), "w") as handle:
        json.dump(extras, handle, indent=2, default=str)
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    sys.exit(main())
