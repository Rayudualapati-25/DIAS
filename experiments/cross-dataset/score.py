#!/usr/bin/env python3
"""
Score the cross-dataset runs.

Metric definitions mirror experiments/dias-finetuning/v2/eval/metrics.js so the
numbers are defined exactly as in the paper:
  - decision accuracy: correct / total, where an invalid reply counts as wrong
  - balanced accuracy: mean of the ALLOW recall and the DENY recall
  - macro F1: mean of the two per-class F1 scores
  - Wilson score interval at z = 1.96

Models are compared only on the example ids BOTH models finished, so a run that
was still in flight cannot flatter either side.
"""
import json, os, math, sys, collections

RUN = "experiments/runs/20260924_cross_dataset"
SETS = ["llmac", "org-easy-binary", "org-easy-partial"]  # hard split omitted: ALLOW class absent
MODELS = ["v7", "base"]

def load(model, s):
    p = f"{RUN}/{model}/{s}.pred.jsonl"
    if not os.path.exists(p): return {}
    out = {}
    for l in open(p):
        try:
            r = json.loads(l); out[r["exampleId"]] = r
        except Exception: pass
    return out

def wilson(k, n, z=1.96):
    if n == 0: return None
    p = k / n; d = 1 + z*z/n; c = p + z*z/(2*n)
    s = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))
    return {"point": round(p, 6), "low": round((c-s)/d, 6), "high": round((c+s)/d, 6)}

def per_class(m, c):
    other = "DENY" if c == "ALLOW" else "ALLOW"
    tp = m[c][c]; fn = m[c][other] + m[c]["INVALID"]
    fp = m[other][c]
    rec = tp/(tp+fn) if tp+fn else None
    prec = tp/(tp+fp) if tp+fp else None
    f1 = (2*prec*rec/(prec+rec)) if prec and rec else (0.0 if (prec is not None and rec is not None) else None)
    return rec, prec, f1

def summarize(rows, expected_of):
    """rows: list of prediction records. expected_of: id -> 'ALLOW'/'DENY'."""
    m = {"ALLOW": {"ALLOW": 0, "DENY": 0, "INVALID": 0},
         "DENY":  {"ALLOW": 0, "DENY": 0, "INVALID": 0}}
    valid = 0
    for r in rows:
        e = expected_of[r["exampleId"]]
        p = r["predicted"] if r["predicted"] in ("ALLOW", "DENY") else "INVALID"
        if p != "INVALID": valid += 1
        m[e][p] += 1
    n = len(rows)
    correct = m["ALLOW"]["ALLOW"] + m["DENY"]["DENY"]
    ar, ap, af = per_class(m, "ALLOW"); dr, dp, df = per_class(m, "DENY")
    bal = round((ar+dr)/2, 6) if ar is not None and dr is not None else None
    mf1 = round((af+df)/2, 6) if af is not None and df is not None else None
    return {
        "n": n, "schemaValid": valid, "schemaValidRate": round(valid/n, 6) if n else None,
        "decisionAccuracy": round(correct/n, 6) if n else None,
        "decisionAccuracyCI": wilson(correct, n),
        "balancedAccuracy": bal, "macroF1": mf1,
        "allowRecall": None if ar is None else round(ar, 6),
        "denyRecall": None if dr is None else round(dr, 6),
        "confusion": m,
        "unsafeAllow": m["DENY"]["ALLOW"],   # expected DENY, model said ALLOW
        "overDeny": m["ALLOW"]["DENY"],
    }

def report():
    out = {"generatedAtUtc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "sets": {}}
    for s in SETS:
        preds = {mm: load(mm, s) for mm in MODELS}
        common = set(preds["v7"]) & set(preds["base"])
        if not common:
            out["sets"][s] = {"note": "no completed examples common to both models"}; continue
        cases = {}
        cf = {"llmac": "experiments/cross-dataset/llmac/llmac-reconstruction.cases.jsonl",
              "org-easy-binary": "experiments/cross-dataset/orgaccess/easy-binary.cases.jsonl",
              "org-hard-binary": "experiments/cross-dataset/orgaccess/hard-binary.cases.jsonl",
              "org-easy-partial": "experiments/cross-dataset/orgaccess/easy-partial.cases.jsonl"}[s]
        for l in open(cf):
            r = json.loads(l); cases[r["exampleId"]] = r

        entry = {"comparedOn": len(common)}
        if s == "org-easy-partial":
            # No binary ground truth: rescore the SAME predictions under each mapping.
            for mapping, lab in (("partial_as_ALLOW", "ALLOW"), ("partial_as_DENY", "DENY")):
                exp = {i: lab for i in common}
                entry[mapping] = {mm: summarize([preds[mm][i] for i in sorted(common)], exp)
                                  for mm in MODELS}
        else:
            exp = {}
            for i in common:
                c = cases[i]
                exp[i] = c["label"]["recommendation"] if "label" in c else c["_expected"]
            common = {i for i in common if exp.get(i) in ("ALLOW", "DENY")}
            entry["comparedOn"] = len(common)
            for mm in MODELS:
                rows = [preds[mm][i] for i in sorted(common)]
                entry[mm] = summarize(rows, exp)
                if s == "llmac":
                    # reason code + policy reference fidelity (LLMAC set has both)
                    rc = sum(1 for r in rows
                             if (r.get("reasonCode") or "") == cases[r["exampleId"]]["label"]["reason_code"])
                    pr = 0
                    for r in rows:
                        want = set(cases[r["exampleId"]]["label"]["policy_refs"])
                        got = r.get("policyRefs") or []
                        got = set(got) if isinstance(got, list) else set()
                        if got == want: pr += 1
                    entry[mm]["reasonCodeAccuracy"] = round(rc/len(rows), 6)
                    entry[mm]["policyRefExactAccuracy"] = round(pr/len(rows), 6)
                    # benign vs adversarial
                    for kind in ("benign", "adversarial"):
                        sub = [r for r in rows if cases[r["exampleId"]]["justificationKind"] == kind]
                        if sub:
                            entry[mm][kind] = summarize(sub, exp)
                    # per policy
                    bysc = collections.defaultdict(list)
                    for r in rows: bysc[cases[r["exampleId"]]["scenario"]].append(r)
                    entry[mm]["byPolicy"] = {k: summarize(v, exp) for k, v in sorted(bysc.items())}
        out["sets"][s] = entry
    return out

if __name__ == "__main__":
    r = report()
    os.makedirs(RUN, exist_ok=True)
    json.dump(r, open(f"{RUN}/comparison.json", "w"), indent=2)
    for s, e in r["sets"].items():
        print(f"\n=== {s}  (compared on {e.get('comparedOn','-')}) ===")
        if "note" in e: print(" ", e["note"]); continue
        if s == "org-easy-partial":
            for mapping in ("partial_as_ALLOW", "partial_as_DENY"):
                for mm in MODELS:
                    d = e[mapping][mm]
                    print(f"  {mapping:17} {mm:5} acc {d['decisionAccuracy']:.3f}  valid {d['schemaValidRate']:.3f}")
            continue
        for mm in MODELS:
            d = e[mm]
            extra = ""
            if "reasonCodeAccuracy" in d:
                extra = f"  reasonCode {d['reasonCodeAccuracy']:.3f}  policyRefs {d['policyRefExactAccuracy']:.3f}"
            print(f"  {mm:5} acc {d['decisionAccuracy']:.3f} "
                  f"[{d['decisionAccuracyCI']['low']:.3f},{d['decisionAccuracyCI']['high']:.3f}]  "
                  f"bal {d['balancedAccuracy']:.3f}  F1 {d['macroF1']:.3f}  "
                  f"valid {d['schemaValidRate']:.3f}  unsafeALLOW {d['unsafeAllow']}{extra}")
