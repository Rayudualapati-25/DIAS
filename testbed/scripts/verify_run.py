#!/usr/bin/env python3
"""Check that a finished workflow run (E6 or E7) is complete and was measured
under the intended conditions, before any of its numbers are used.

Checks:
  1. every planned request has exactly one row, and run.json agrees with the rows;
  2. the facts the ledger committed match the plan for every workflow;
  3. no model answer reused a cached prompt beyond the shared instruction prefix
     (a larger cache hit would make that answer unrealistically fast);
  4. the Mac ran on AC power in High Power Mode for the whole run;
  5. the Mac and per-container recorders have no gaps longer than 20 s.

Writes verify.json into the run folder and exits 1 if any check fails.

Usage: python3 verify_run.py --run <results dir> --plan <plan json> --trace <backend-trace.jsonl>
         --power-log <power-log.csv> --mac-samples <mac-samples.csv> --container-stats <container-stats.csv>
"""

import argparse
import csv
import json
import os
import sys

MAX_GAP_S = 20
# The shared instruction prefix the model server may reuse is about 300 tokens (E5: 307 on average).
MAX_SHARED_PREFIX_TOKENS = 600


def load_jsonl(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def max_gap(times, start_s, end_s):
    inside = sorted(t for t in times if start_s <= t <= end_s)
    if not inside:
        return None
    edges = [inside[0] - start_s] + [b - a for a, b in zip(inside, inside[1:])] + [end_s - inside[-1]]
    return max(edges)


def main():
    parser = argparse.ArgumentParser()
    for name in ["--run", "--plan", "--trace", "--power-log", "--mac-samples", "--container-stats"]:
        parser.add_argument(name, required=True)
    args = parser.parse_args()
    rows = load_jsonl(os.path.join(args.run, "requests.jsonl"))
    with open(os.path.join(args.run, "run.json")) as handle:
        run = json.load(handle)
    with open(args.plan) as handle:
        plan = json.load(handle)
    start_s, end_s = run["startedAt"] / 1000, run["finishedAt"] / 1000
    checks = {}

    planned = {a["id"] for a in plan["arrivals"]}
    seen = [r["id"] for r in rows]
    completed = [r for r in rows if r.get("status") == "completed"]
    checks["rows_match_plan"] = {
        "planned": len(planned), "rows": len(rows), "unique": len(set(seen)),
        "completed": len(completed), "run_json_completed": run["completed"], "run_json_failed": run["failed"],
        "failed_ids": [r["id"] for r in rows if r.get("status") != "completed"],
        "pass": set(seen) == planned and len(seen) == len(set(seen)) and run["completed"] == len(completed)
                and run["failed"] == len(rows) - len(completed),
    }
    mismatched = [r["id"] for r in completed if not r.get("plannedFactsMatch")]
    checks["facts_match_plan"] = {"mismatched_ids": mismatched, "pass": not mismatched}

    ids = {r.get("requestId") for r in rows}
    cached = [e.get("cachedPromptTokens") for e in load_jsonl(args.trace)
              if e.get("event") == "model.response" and e.get("requestId") in ids]
    cached = [c for c in cached if c is not None]
    large = [c for c in cached if c > MAX_SHARED_PREFIX_TOKENS]
    checks["prompt_cache"] = {"answers": len(cached), "max_cached_tokens": max(cached) if cached else None,
                              "answers_above_shared_prefix": len(large), "pass": bool(cached) and not large}

    with open(args.power_log) as handle:
        power = [r for r in csv.DictReader(handle) if start_s <= float(r["epoch_s"]) <= end_s]
    off = [r for r in power if r["power_source"] != "AC Power" or r["powermode"] != "2"]
    checks["power"] = {"samples": len(power), "not_ac_high_power": len(off),
                       "max_gap_s": max_gap([float(r["epoch_s"]) for r in power], start_s, end_s),
                       "pass": bool(power) and not off}

    with open(args.mac_samples) as handle:
        mac_times = [float(r["epoch_s"]) for r in csv.DictReader(handle)]
    gaps = {"mac": max_gap(mac_times, start_s, end_s)}
    by_machine = {}
    with open(args.container_stats) as handle:
        for r in csv.DictReader(handle):
            by_machine.setdefault(r["machine"], set()).add(float(r["epoch_s"]))
    for machine, times in sorted(by_machine.items()):
        gaps[machine] = max_gap(times, start_s, end_s)
    checks["recorder_gaps_s"] = {**gaps, "pass": all(g is not None and g <= MAX_GAP_S for g in gaps.values())}

    ok = all(c["pass"] for c in checks.values())
    result = {"run": os.path.basename(os.path.normpath(args.run)), "window_utc": [run.get("startedAtUtc"), run.get("finishedAtUtc")],
              "all_checks_pass": ok, "checks": checks}
    with open(os.path.join(args.run, "verify.json"), "w") as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps(result, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
