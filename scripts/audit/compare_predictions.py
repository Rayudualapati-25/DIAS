#!/usr/bin/env python3
"""Compare two DIAS evaluation runs prediction by prediction.

Used to check that a reproduction run matches the retained run that the
manuscript cites. Examples are joined on ``exampleId``; only examples present in
both runs are compared, and missing examples are reported, never dropped
silently.

    python3 scripts/audit/compare_predictions.py <reference-run> <new-run> \
        --sets test-decision-balanced,test-adversarial --out <new-run>/comparison.json
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path


def load(run: Path, name: str) -> dict[str, dict]:
    path = run / "predictions" / f"{name}.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    by_id = {}
    for row in rows:
        if row["exampleId"] in by_id:
            raise SystemExit(f"duplicate exampleId {row['exampleId']} in {path}")
        by_id[row["exampleId"]] = row
    return by_id


def field(row: dict, key: str):
    predicted = row.get("predicted") or {}
    return predicted.get(key)


def summary(rows: list[dict]) -> dict:
    valid = [r for r in rows if r.get("status") == "OK" and r.get("predicted")]
    allow = [r for r in valid if r["expected"]["recommendation"] == "ALLOW"]
    deny = [r for r in valid if r["expected"]["recommendation"] == "DENY"]
    rec = lambda group, label: (sum(field(r, "recommendation") == label for r in group) / len(group)) if group else None
    ra, rd = rec(allow, "ALLOW"), rec(deny, "DENY")
    lat = [r["latencyMs"] for r in rows if isinstance(r.get("latencyMs"), (int, float))]
    return {
        "examples": len(rows), "valid": len(valid),
        "balancedAccuracy": round((ra + rd) / 2, 6) if ra is not None and rd is not None else None,
        "falseAllow": sum(r["expected"]["recommendation"] == "DENY" and field(r, "recommendation") == "ALLOW" for r in valid),
        "falseDeny": sum(r["expected"]["recommendation"] == "ALLOW" and field(r, "recommendation") == "DENY" for r in valid),
        "reasonCodeAccuracy": round(sum(field(r, "reason_code") == r["expected"]["reason_code"] for r in valid) / len(valid), 6) if valid else None,
        "policyRefAccuracy": round(sum(field(r, "policy_refs") == r["expected"]["policy_refs"] for r in valid) / len(valid), 6) if valid else None,
        "latencyMeanMs": round(statistics.fmean(lat), 1) if lat else None,
        "latencyMedianMs": round(statistics.median(lat), 1) if lat else None,
    }


def compare(ref: dict[str, dict], new: dict[str, dict]) -> dict:
    shared = sorted(set(ref) & set(new))
    same = lambda key: sum(field(ref[i], key) == field(new[i], key) for i in shared)
    identical = sum(ref[i].get("predicted") == new[i].get("predicted") and ref[i].get("status") == new[i].get("status") for i in shared)
    diffs = [
        {"exampleId": i, "reference": ref[i].get("predicted"), "new": new[i].get("predicted"),
         "referenceStatus": ref[i].get("status"), "newStatus": new[i].get("status")}
        for i in shared if ref[i].get("predicted") != new[i].get("predicted") or ref[i].get("status") != new[i].get("status")
    ]
    paired = [new[i]["latencyMs"] - ref[i]["latencyMs"] for i in shared
              if isinstance(ref[i].get("latencyMs"), (int, float)) and isinstance(new[i].get("latencyMs"), (int, float))]
    return {
        "compared": len(shared),
        "onlyInReference": sorted(set(ref) - set(new)),
        "onlyInNew": sorted(set(new) - set(ref)),
        "sameStatus": sum(ref[i].get("status") == new[i].get("status") for i in shared),
        "sameRecommendation": same("recommendation"),
        "sameReasonCode": same("reason_code"),
        "samePolicyRefs": same("policy_refs"),
        "identicalFullResponse": identical,
        "differences": diffs,
        "latencyPairedDiffMs": {
            "mean": round(statistics.fmean(paired), 1) if paired else None,
            "median": round(statistics.median(paired), 1) if paired else None,
        },
        "referenceSummaryOnCompared": summary([ref[i] for i in shared]),
        "newSummaryOnCompared": summary([new[i] for i in shared]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("new", type=Path)
    parser.add_argument("--sets", required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = {"reference": str(args.reference), "new": str(args.new), "sets": {}}
    for name in args.sets.split(","):
        report["sets"][name] = compare(load(args.reference, name), load(args.new, name))
        s = report["sets"][name]
        print(f"{name}: compared {s['compared']}, identical {s['identicalFullResponse']}, "
              f"same decision {s['sameRecommendation']}, differences {len(s['differences'])}")
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
