"""Paired statistical tests over the retained model runs.

Every comparison here is paired on the case id, so the two arms are compared on
exactly the same cases. McNemar's exact test is used because the outcomes are
paired and binary; the exact binomial form is used throughout rather than the
chi-square approximation, since the discordant counts are small.

Nothing is called significant on the strength of a rounded difference: the test
statistic, the discordant counts and the p-value are all reported, and the
comparison is only meaningful for the arms that were run on the same split.
"""

import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from scipy import stats

from style import RESULTS, load, write_table, num

RUNS = pathlib.Path(__file__).resolve().parents[2] / "experiments/runs/20260906_seal_precision_e2e"
FIELDS = ("action", "purpose", "decision", "reasonCode")


def rows_by_id(filename):
    data = json.loads((RUNS / filename).read_text())
    return {row["id"]: row for row in data["rows"]}


def joint_correct(row):
    """The joint criterion used throughout: a schema-valid output whose action,
    purpose, decision and reason code all match the expected case."""
    if not row.get("valid"):
        return False
    pred, exp = row.get("prediction") or {}, row["expected"]
    return all(pred.get(f) == exp.get(f) for f in FIELDS)


def decision_correct(row):
    if not row.get("valid"):
        return False
    return (row.get("prediction") or {}).get("decision") == row["expected"]["decision"]


def mcnemar(a_correct, b_correct):
    """Exact McNemar over paired binary outcomes. b and c are the discordant
    pairs: b = only the first arm correct, c = only the second."""
    b = sum(1 for x, y in zip(a_correct, b_correct) if x and not y)
    c = sum(1 for x, y in zip(a_correct, b_correct) if y and not x)
    n = b + c
    p = 1.0 if n == 0 else stats.binomtest(b, n, 0.5, alternative="two-sided").pvalue
    return {"b_only_first": b, "c_only_second": c, "discordant": n, "p": p}


def wilson(successes, total, z=1.959963985):
    """Wilson score interval — behaves sensibly at proportions near 0 and 1,
    where the normal approximation does not."""
    if total == 0:
        return (None, None)
    p = successes / total
    denom = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def verify_against_experiment(pairs, exp01):
    """Recompute each arm's accuracies from the raw rows and check them against
    the figures Experiment 01 reported. A mismatch means the criterion applied
    here is not the criterion behind the published numbers, so it stops."""
    stored = {}
    for arm in exp01["summary"]["arms"]:
        stored[arm["label"]] = arm
    abl = exp01["summary"]["ablation"]
    stored["V6 with subject context"] = abl["withSubject"]
    stored["V6 without subject context"] = abl["withoutSubject"]

    problems = []
    for label, filename in pairs.items():
        rows = list(rows_by_id(filename).values())
        joint = sum(joint_correct(r) for r in rows) / len(rows)
        decision = sum(decision_correct(r) for r in rows) / len(rows)
        want = stored[label]
        for name, got, expected in (("joint", joint, want["jointAccuracy"]),
                                    ("decision", decision, want["decisionAccuracy"])):
            if abs(got - expected) > 1e-9:
                problems.append(f"{label} {name}: recomputed {got:.4f} vs reported {expected:.4f}")
        print(f"  {label:32} n={len(rows):4}  joint={joint:.4f}  decision={decision:.4f}  (matches reported)")
    if problems:
        raise SystemExit("criterion mismatch — refusing to run tests:\n  " + "\n  ".join(problems))


def compare(name, first_label, first_file, second_label, second_file, question):
    first, second = rows_by_id(first_file), rows_by_id(second_file)
    shared = sorted(set(first) & set(second))
    if len(shared) != len(first) or len(shared) != len(second):
        print(f"  NOTE {name}: pairing on {len(shared)} shared ids "
              f"({len(first)} vs {len(second)} available)")

    out = {"comparison": name, "question": question, "pairedCases": len(shared),
           "firstArm": first_label, "secondArm": second_label, "tests": {}}
    for criterion, fn in (("joint", joint_correct), ("decision", decision_correct)):
        a = [fn(first[i]) for i in shared]
        b = [fn(second[i]) for i in shared]
        result = mcnemar(a, b)
        lo_a, hi_a = wilson(sum(a), len(a))
        lo_b, hi_b = wilson(sum(b), len(b))
        result.update({
            "firstAccuracy": sum(a) / len(a), "secondAccuracy": sum(b) / len(b),
            "firstCI95": [lo_a, hi_a], "secondCI95": [lo_b, hi_b],
            "differencePP": (sum(a) - sum(b)) / len(a) * 100,
            "test": "McNemar exact (binomial, two-sided)",
        })
        out["tests"][criterion] = result
        print(f"    {criterion:9} {first_label} {result['firstAccuracy'] * 100:5.1f}%  "
              f"vs {second_label} {result['secondAccuracy'] * 100:5.1f}%  "
              f"b={result['b_only_first']} c={result['c_only_second']}  p={result['p']:.3e}")
    return out


def main():
    exp01 = load("01-model-context.json")
    if not exp01:
        raise SystemExit("01-model-context.json missing")

    arms = {
        "V6 grounded": "proposed_grounded_v6_best.json",
        "V4 grounded": "proposed_grounded_v4.json",
        "V4 short prompt": "baseline_short_v4.json",
        "V6 with subject context": "ablation_full_trusted_subject_v6_best.json",
        "V6 without subject context": "ablation_no_trusted_subject_v6_best.json",
    }
    print("Recomputing arm accuracies from the raw rows:")
    verify_against_experiment(arms, exp01)

    print("\nPaired comparisons:")
    comparisons = [
        compare("v6_vs_v4_grounded", "V6", arms["V6 grounded"], "V4", arms["V4 grounded"],
                "Does the v6 adapter change authorization accuracy relative to v4, "
                "with the same grounded prompt on the same held-out cases?"),
        compare("v4_grounded_vs_short", "V4 grounded", arms["V4 grounded"],
                "V4 short", arms["V4 short prompt"],
                "Does prompt grounding change accuracy at a fixed adapter version?"),
        compare("subject_context_ablation", "with subject context",
                arms["V6 with subject context"], "without subject context",
                arms["V6 without subject context"],
                "Does removing the authenticated subject context change accuracy "
                "on the same validation cases?"),
    ]

    payload = {
        "method": {
            "test": "McNemar exact test (two-sided binomial on discordant pairs)",
            "pairing": "by case id; both arms answer the identical case set",
            "interval": "Wilson score, 95%",
            "jointCriterion": "schema-valid output with action, purpose, decision and "
                              "reason code all matching the expected case",
            "note": "Arms compared here were run on the same split. The v6 short-prompt "
                    "arm was not retained, so prompt grounding is tested only at v4.",
        },
        "comparisons": comparisons,
    }
    (RESULTS / "05-statistics.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\n  wrote {(RESULTS / '05-statistics.json').name}")

    rows = []
    for comp in comparisons:
        for criterion, t in comp["tests"].items():
            rows.append([
                comp["comparison"], criterion, comp["pairedCases"],
                f"{t['firstAccuracy'] * 100:.1f}",
                f"{t['firstCI95'][0] * 100:.1f}--{t['firstCI95'][1] * 100:.1f}",
                f"{t['secondAccuracy'] * 100:.1f}",
                f"{t['secondCI95'][0] * 100:.1f}--{t['secondCI95'][1] * 100:.1f}",
                f"{t['differencePP']:+.1f}",
                t["b_only_first"], t["c_only_second"],
                f"{t['p']:.3g}",
            ])
    write_table("table05_paired_tests",
                ["Comparison", "Criterion", "Paired cases", "Arm A (%)", "A 95% CI",
                 "Arm B (%)", "B 95% CI", "Difference (pp)", "A only", "B only", "p"],
                rows)


if __name__ == "__main__":
    main()
