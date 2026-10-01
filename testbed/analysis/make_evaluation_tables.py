#!/usr/bin/env python3
"""LaTeX result tables for the five Evaluation Setting items, generated from the result files.

Every number is read from a result file (none is typed in), rounded half-up, and written
as a count first with the percentage in brackets. The tables use the paper's own style
(booktabs, \\footnotesize, caption above) and new labels (tab:res-*), so they can sit next
to the older tables in Results.tex without clashing.

Usage: python3 make_evaluation_tables.py --out <file.tex>
"""

import argparse
import csv
import json
import os
from decimal import ROUND_HALF_UP, Decimal

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MULTIVM = os.path.join(REPO, "experiments/runs/20260924_testbed_multivm/analysis")
REUSE = os.path.join(REPO, "experiments/runs/20260925_reuse_100_users/analysis")
CROSS = os.path.join(REPO, "experiments/runs/20260924_cross_dataset")

TEST_GROUPS = [  # the order of the Evaluation Setting text
    ("test-decision-balanced", "Balanced ALLOW/DENY"),
    ("test-reason-balanced", "Reason-focused"),
    ("test-adversarial", "Misleading or instruction-like"),
    ("test-ood-paraphrase", "Paraphrased"),
    ("test-multi-rule", "Multiple rule violations"),
]
MODELS = [("Untuned Qwen3-14B", "Untuned"), ("V7 (fine-tuned)", "V7")]
LEDGER_OPERATIONS = [
    ("W1 CreateAccessRequest", "Record access request"),
    ("W2 SubmitAuditorDecision", "Record auditor decision"),
    ("R1 GetRequest", "Read one request"),
    ("R2 QueryAccessDecisions", "Read 50 latest decisions"),
]


def fix(value, places):
    return str(Decimal(str(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def num(value, places=0):
    """Thousands separator, half-up rounding."""
    text = fix(value, places)
    whole, _, frac = text.partition(".")
    sign = "-" if whole.startswith("-") else ""
    whole = f"{int(whole.lstrip('-')):,}"
    return f"{sign}{whole}.{frac}" if frac else f"{sign}{whole}"


def pct(count, total):
    return f"{num(count)} ({fix(100 * count / total, 1)}\\%)"


def of(count, total):
    return f"{num(count)} of {num(total)}"


def read_csv(path):
    with open(path) as handle:
        return list(csv.DictReader(handle))


def note(text):
    return f"  \\\\[2pt]\n  \\parbox{{\\linewidth}}{{\\scriptsize {text}}}\n"


def table_quality():
    rows = {(r["set"], r["model"]): r for r in read_csv(os.path.join(MULTIVM, "accuracy/accuracy-sets.csv"))}
    lines = []
    for index, (key, label) in enumerate(TEST_GROUPS):
        for m, (model, short) in enumerate(MODELS):
            r = rows[(key, model)]
            cases = int(r["cases"])
            no_allow = int(r["allow_total"]) == 0
            lines.append(" & ".join([
                label if m == 0 else "", num(cases) if m == 0 else "", short, num(int(r["usable"])),
                pct(int(r["correct"]), cases), num(int(r["wrongly_granted"])),
                "--" if no_allow else num(int(r["wrongly_refused"])),
                num(int(r["reason_correct"])), num(int(r["clauses_correct"])),
            ]) + " \\\\")
        if index < len(TEST_GROUPS) - 1:
            lines.append("\\addlinespace[1pt]")
    body = "\n    ".join(lines)
    return f"""\\begin{{table*}}[tb]
  \\centering
  \\caption{{Recommendation Quality on the Five Test Groups}}
  \\label{{tab:res-quality}}
  \\footnotesize
  \\setlength{{\\tabcolsep}}{{3.5pt}}
  \\begin{{tabular}}{{@{{}}lrlrrrrrr@{{}}}}
    \\toprule
    & & & Valid & Correct & Wrongly & Wrongly & Correct & Exact policy \\\\
    Test group & Requests & Model & output & decision & granted & refused & reason & references \\\\
    \\midrule
    {body}
    \\bottomrule
  \\end{{tabular}}
{note("Counts of requests. Valid output: the answer has the required format; an invalid output counts as an incorrect decision. Wrongly granted: ALLOW where the written policy says DENY. Wrongly refused: DENY where it says ALLOW. The multiple-violation group contains no request the policy allows. Exact policy references: the cited policy clauses equal the expected list.")}\\end{{table*}}
"""


def table_reuse():
    cells = read_csv(os.path.join(REUSE, "reuse-conditions.csv"))
    get = lambda r, d: next(c for c in cells if int(c["repeats"]) == r and c["design"] == d)  # noqa: E731
    lines = []
    for r in sorted({int(c["repeats"]) for c in cells}):
        exact, prop = get(r, "exact-record"), get(r, "property-fingerprint")
        requests = int(exact["requests"])
        lines.append(" & ".join([
            str(r + 1), num(requests),
            pct(int(exact["reviews_avoided"]), requests), pct(int(prop["reviews_avoided"]), requests),
            num(int(exact["grants_on_a_different_record"])), num(int(prop["grants_on_a_different_record"])),
        ]) + " \\\\")
    body = "\n    ".join(lines)
    return f"""\\begin{{table}}[tb]
  \\centering
  \\caption{{Dynamic Authorization Reuse over Eight Rounds}}
  \\label{{tab:res-reuse}}
  \\footnotesize
  \\setlength{{\\tabcolsep}}{{2.5pt}}
  \\begin{{tabular}}{{@{{}}rrrrrr@{{}}}}
    \\toprule
    & & \\multicolumn{{2}}{{c}}{{Reviews avoided}} & \\multicolumn{{2}}{{c}}{{Unapproved}} \\\\
    \\cmidrule(lr){{3-4}} \\cmidrule(l){{5-6}}
    Round & Requests & DIAS & Broader & DIAS & Broader \\\\
    \\midrule
    {body}
    \\bottomrule
  \\end{{tabular}}
{note("Round $k$: the $k$-th submission of the same 300 requests; Requests counts all submissions so far. DIAS: exact-record reuse, measured on the ledger. Broader: the broader rule that reuses an approval for any record with matching properties, replayed on the same requests. Unapproved: automatic grants on a record the auditor did not approve. Reviewing every request again avoids no review and grants nothing without review.")}\\end{{table}}
"""


def table_model_time():
    s = json.load(open(os.path.join(MULTIVM, "e4/e4-summary.json")))
    t = s["time_per_recommendation_s"]
    rows = [
        ("Recommendations completed", of(s["usable"], s["cases"])),
        ("Correct decisions", pct(s["correct"], s["cases"])),
        ("Same output as the earlier V7 evaluation", of(s["identical_output_to_stored_v7_run"], s["cases"])),
        ("Time per recommendation, mean", f"{fix(t['mean'], 2)} s"),
        ("Time per recommendation, median (p50)", f"{fix(t['p50'], 2)} s"),
        ("Time per recommendation, 95th percentile", f"{fix(t['p95'], 2)} s"),
        ("Time per recommendation, maximum", f"{fix(t['max'], 2)} s"),
        ("Recommendations per minute", fix(s["recommendations_per_min"], 2)),
        ("Input length, mean", f"{num(s['prompt_tokens_mean'])} tokens"),
        ("Output length, mean", f"{fix(s['completion_tokens_mean'], 1)} tokens"),
        ("Output tokens per second", fix(s["output_tokens_per_s"], 2)),
    ]
    body = "\n    ".join(f"{a} & {b} \\\\" for a, b in rows)
    return f"""\\begin{{table}}[tb]
  \\centering
  \\caption{{Model Recommendation Time, One Request at a Time}}
  \\label{{tab:res-model-time}}
  \\footnotesize
  \\setlength{{\\tabcolsep}}{{4pt}}
  \\begin{{tabular}}{{@{{}}lr@{{}}}}
    \\toprule
    Measure (600 balanced test requests) & Value \\\\
    \\midrule
    {body}
    \\bottomrule
  \\end{{tabular}}
\\end{{table}}
"""


def table_ledger():
    rows = read_csv(os.path.join(MULTIVM, "e3/e3-functions.csv"))
    lines = []
    for index, (key, label) in enumerate(LEDGER_OPERATIONS):
        if index:
            lines.append("\\addlinespace[2pt]")
        lines.append(f"\\multicolumn{{6}}{{@{{}}l}}{{\\textit{{{label}}}}} \\\\")
        for r in sorted((r for r in rows if r["function"] == key), key=lambda r: int(r["in_flight"])):
            done = int(r["succeeded"])
            lines.append(" & ".join([
                r["in_flight"], num(done), num(int(r["failed"])),
                num(float(r["throughput_per_s"]), 2) if done else "0",
                num(float(r["p50_ms"]), 1) if r["p50_ms"] else "--",
                num(float(r["p95_ms"]), 1) if r["p95_ms"] else "--",
            ]) + " \\\\")
    body = "\n    ".join(lines)
    return f"""\\begin{{table}}[tb]
  \\centering
  \\caption{{Ledger Operations Under Concurrent Load}}
  \\label{{tab:res-ledger}}
  \\footnotesize
  \\setlength{{\\tabcolsep}}{{2.5pt}}
  \\begin{{tabular}}{{@{{}}rrrrrr@{{}}}}
    \\toprule
    In & & & Operations & \\multicolumn{{2}}{{c}}{{Response (ms)}} \\\\
    \\cmidrule(l){{5-6}}
    progress & Completed & Failed & per second & p50 & p95 \\\\
    \\midrule
    {body}
    \\bottomrule
  \\end{{tabular}}
{note("In progress: operations running at once. Each recording level ran for 60 s, and the decision round then decided every request the first round created; each read level ran for 30 s. The 50-latest-decisions read scans every stored decision: at 50 or more in progress, every call passed the client's 30-s limit.")}\\end{{table}}
"""


def table_system():
    levels = read_csv(os.path.join(MULTIVM, "e5/e5-levels.csv"))
    e6 = json.load(open(os.path.join(MULTIVM, "e6/e6-summary.json")))
    lines = []
    for r in levels:
        lines.append(" & ".join([
            f"{r['users']} users", of(int(r["completed"]), int(r["requested"])), fix(r["p50_s"], 2), fix(r["p95_s"], 2),
            f"{fix(r['throughput_per_min_mean'], 2)} $\\pm$ {fix(r['throughput_per_min_sd'], 2)}",
            fix(r["llm_inference_mean_s"], 2), of(int(r["correct"]), int(r["completed"])),
        ]) + " \\\\")
    lines.append("\\midrule")
    lines.append(" & ".join([
        "One hour, 100 users", of(e6["completed"], e6["arrivals"]), fix(e6["end_to_end_s"]["p50"], 2),
        fix(e6["end_to_end_s"]["p95"], 2), fix(e6["throughput_workflows_per_min"], 2),
        fix(e6["components_mean_s"]["llm_inference"], 2), of(e6["accuracy"]["correct"], e6["accuracy"]["of"]),
    ]) + " \\\\")
    body = "\n    ".join(lines)
    total = sum(int(r["completed"]) for r in levels)
    return f"""\\begin{{table*}}[tb]
  \\centering
  \\caption{{Whole-System Performance}}
  \\label{{tab:res-system}}
  \\footnotesize
  \\setlength{{\\tabcolsep}}{{4pt}}
  \\begin{{tabular}}{{@{{}}lrrrrrr@{{}}}}
    \\toprule
    & Workflows & \\multicolumn{{2}}{{c}}{{End-to-end time (s)}} & Throughput & Model time & Correct \\\\
    \\cmidrule(lr){{3-4}}
    Load & completed & Median (p50) & 95th percentile & (workflows/min) & (s, mean) & recommendations \\\\
    \\midrule
    {body}
    \\bottomrule
  \\end{{tabular}}
{note(f"Burst levels: the accounts submit one request each at the same time, three times per level ({num(total)} workflows); throughput is the mean $\\pm$ standard deviation of the three runs. One hour: {num(e6['arrivals'])} requests at random times, about six per minute, which sets the throughput; {num(e6['operations_succeeded'])} of {num(e6['operations_total'])} API and ledger operations succeeded. Times exclude human review.")}\\end{{table*}}
"""


def table_external():
    quality = {(r["set"], r["model"]): r for r in read_csv(os.path.join(MULTIVM, "accuracy/accuracy-sets.csv"))}
    cross = json.load(open(os.path.join(CROSS, "comparison.json")))["sets"]
    lines = []

    def dias_row(model, short, first):
        r = quality[("test-decision-balanced", model)]
        n = int(r["cases"])
        return " & ".join([
            "DIAS balanced test" if first else "", num(n) if first else "", short, num(int(r["usable"])),
            pct(int(r["correct"]), n), of(int(r["allow_recognised"]), int(r["allow_total"])),
            of(int(r["deny_stopped"]), int(r["deny_total"])), num(int(r["wrongly_granted"])),
            num(int(r["wrongly_refused"])),
        ]) + " \\\\"

    def cross_row(key, label, model, short, first):
        s = cross[key][model]
        c = s["confusion"]
        allow_total = sum(c["ALLOW"].values())
        deny_total = sum(c["DENY"].values())
        correct = c["ALLOW"]["ALLOW"] + c["DENY"]["DENY"]
        return " & ".join([
            label if first else "", num(s["n"]) if first else "", short, num(s["schemaValid"]),
            pct(correct, s["n"]), of(c["ALLOW"]["ALLOW"], allow_total), of(c["DENY"]["DENY"], deny_total),
            num(c["DENY"]["ALLOW"]), num(c["ALLOW"]["DENY"]),
        ]) + " \\\\"

    for m, (model, short) in enumerate(MODELS):
        lines.append(dias_row(model, short, m == 0))
    for key, label in [("llmac", "LLMAC policies (reconstructed)"), ("org-easy-binary", "OrgAccess easy (binary)")]:
        lines.append("\\addlinespace[1pt]")
        for m, (model, short) in enumerate([("base", "Untuned"), ("v7", "V7")]):
            lines.append(cross_row(key, label, model, short, m == 0))
    body = "\n    ".join(lines)
    ci = lambda key, model: cross[key][model]["decisionAccuracyCI"]  # noqa: E731
    span = lambda key, model: f"{fix(100 * ci(key, model)['low'], 1)}--{fix(100 * ci(key, model)['high'], 1)}\\%"  # noqa: E731
    return f"""\\begin{{table*}}[tb]
  \\centering
  \\caption{{Comparison on External Access-Control Tasks}}
  \\label{{tab:res-external}}
  \\footnotesize
  \\setlength{{\\tabcolsep}}{{3.5pt}}
  \\begin{{tabular}}{{@{{}}lrlrrrrrr@{{}}}}
    \\toprule
    & & & Valid & Correct & Correctly & Correctly & Wrongly & Wrongly \\\\
    Dataset & Requests & Model & output & decision & allowed & denied & granted & refused \\\\
    \\midrule
    {body}
    \\bottomrule
  \\end{{tabular}}
{note(f"The DIAS rows repeat the balanced group of Table~\\ref{{tab:res-quality}} for comparison. Invalid outputs count as incorrect. 95\\% confidence intervals of the correct-decision rate: LLMAC {span('llmac', 'base')} (untuned) and {span('llmac', 'v7')} (V7); OrgAccess {span('org-easy-binary', 'base')} and {span('org-easy-binary', 'v7')}.")}\\end{{table*}}
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    parts = [
        ("Item 1: Recommendation quality", table_quality()),
        ("Item 2: Dynamic authorization reuse", table_reuse()),
        ("Item 3: Component performance, model alone", table_model_time()),
        ("Item 3: Component performance, ledger alone", table_ledger()),
        ("Item 4: Whole-system performance", table_system()),
        ("Item 5: Comparison on external access-control tasks", table_external()),
    ]
    header = ("% Result tables for the five Evaluation Setting items.\n"
              "% Generated by testbed/analysis/make_evaluation_tables.py from the result files; do not edit numbers by hand.\n"
              "% Needs booktabs (already in main.tex). table* spans both columns.\n\n")
    with open(args.out, "w") as handle:
        handle.write(header + "\n".join(f"% --- {title}\n{tex}" for title, tex in parts))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
