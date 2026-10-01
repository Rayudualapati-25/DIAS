#!/usr/bin/env python3
"""E1/E2: recommendation quality recomputed from the raw prediction files.

Reads every stored prediction of the untuned model and of V7 and recomputes all
counts; the stored metric summaries are only used to cross-check. Every score
is also written as a plain question with a count, e.g. "Of the 300 requests
the policy allows, how many did the model recommend allowing?"

Usage: python3 accuracy.py --out <dir>
"""

import argparse
import csv
import json
import math
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RUNS = {
    "Untuned Qwen3-14B": os.path.join(REPO, "experiments/runs/20260912_dias_qwen3_baseline"),
    "V7 (fine-tuned)": os.path.join(REPO, "experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval"),
}
SETS = ["test-decision-balanced", "test-adversarial", "test-reason-balanced", "test-ood-paraphrase",
        "test-multi-rule", "validation-balanced"]


def load(run, name):
    with open(os.path.join(run, "predictions", f"{name}.jsonl")) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def wilson(k, n, z=1.959964):
    if n == 0:
        return [None, None]
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [round(centre - half, 4), round(centre + half, 4)]


def mcnemar_exact(b, c):
    """Two-sided exact McNemar p-value from the discordant counts b and c."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2 ** n)
    return min(1.0, 2 * tail)


def score(rows):
    valid = [r for r in rows if r.get("status") == "OK" and r.get("predicted")]
    out = {"cases": len(rows), "usable": len(valid), "unusable": len(rows) - len(valid)}
    for label in ("ALLOW", "DENY"):
        exp = [r for r in rows if r["expected"]["recommendation"] == label]
        exp_valid = [r for r in exp if r in valid]
        out[f"expected_{label}"] = len(exp)
        out[f"expected_{label}_usable"] = len(exp_valid)
        out[f"{label}_to_ALLOW"] = sum(1 for r in exp_valid if r["predicted"]["recommendation"] == "ALLOW")
        out[f"{label}_to_DENY"] = sum(1 for r in exp_valid if r["predicted"]["recommendation"] == "DENY")
        out[f"{label}_unusable"] = len(exp) - len(exp_valid)
    out["correct"] = sum(1 for r in valid if r["predicted"]["recommendation"] == r["expected"]["recommendation"])
    out["reason_correct"] = sum(1 for r in valid if r["predicted"].get("reason_code") == r["expected"]["reason_code"])
    out["clauses_correct"] = sum(1 for r in valid if list(r["predicted"].get("policy_refs") or []) == list(r["expected"]["policy_refs"]))
    out["wrongly_granted"] = out["DENY_to_ALLOW"]
    out["wrongly_refused"] = out["ALLOW_to_DENY"]
    rec_allow = out["ALLOW_to_ALLOW"] / out["expected_ALLOW_usable"] if out["expected_ALLOW_usable"] else None
    rec_deny = out["DENY_to_DENY"] / out["expected_DENY_usable"] if out["expected_DENY_usable"] else None
    out["balanced_accuracy_usable"] = (rec_allow + rec_deny) / 2 if rec_allow is not None and rec_deny is not None else None
    out["balanced_accuracy_all_cases"] = (
        ((out["ALLOW_to_ALLOW"] / out["expected_ALLOW"]) + (out["DENY_to_DENY"] / out["expected_DENY"])) / 2
        if out["expected_ALLOW"] and out["expected_DENY"] else None)
    out["correct_ci95_all_cases"] = wilson(out["correct"], out["cases"])
    out["wrongly_granted_ci95"] = wilson(out["wrongly_granted"], out["expected_DENY"])
    return out


def per_reason(rows):
    table = {}
    for code in sorted({r["expected"]["reason_code"] for r in rows}):
        group = [r for r in rows if r["expected"]["reason_code"] == code]
        ok = [r for r in group if r.get("status") == "OK" and r.get("predicted")]
        table[code] = {
            "cases": len(group),
            "decision_correct": sum(1 for r in ok if r["predicted"]["recommendation"] == r["expected"]["recommendation"]),
            "reason_correct": sum(1 for r in ok if r["predicted"].get("reason_code") == code),
        }
    return table


def plain_words(name, s):
    return [
        f"{name}: of {s['expected_ALLOW']} requests the policy allows, {s['ALLOW_to_ALLOW']} were recommended for approval "
        f"({s['ALLOW_to_DENY']} wrongly refused, {s['ALLOW_unusable']} unusable answers).",
        f"{name}: of {s['expected_DENY']} requests the policy denies, {s['DENY_to_DENY']} were recommended for denial "
        f"({s['DENY_to_ALLOW']} wrongly granted, {s['DENY_unusable']} unusable answers).",
        f"{name}: {s['correct']} of {s['cases']} decisions correct; {s['usable']} of {s['cases']} answers usable; "
        f"right reason {s['reason_correct']}, right clauses {s['clauses_correct']}.",
    ]


def plot_quality(scores, out):
    models = list(scores)
    metrics = [("usable", "Usable\nanswers"), ("correct", "Correct\ndecisions"),
               ("reason_correct", "Correct\nreason"), ("clauses_correct", "Correct\nclauses")]
    fig, ax = figstyle.figure(height=2.4)
    x = list(range(len(metrics)))
    width = 0.36
    for i, model in enumerate(models):
        vals = [scores[model][key] for key, _ in metrics]
        bars = ax.bar([xi + (i - 0.5) * width for xi in x], vals, width=width * 0.94, color=figstyle.SERIES[i],
                      hatch=figstyle.HATCHES[i], edgecolor="white", linewidth=0.6, label=model)
        figstyle.label_bars(ax, bars, fmt="{:.0f}")
    ax.set_xticks(x)
    ax.set_xticklabels([label for _, label in metrics])
    ax.set_ylabel("Test decisions (of 600)")
    ax.set_ylim(0, 680)
    ax.axhline(600, color=figstyle.INK_2, linewidth=0.6, linestyle=":")
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=2)
    figstyle.save(fig, os.path.join(out, "e1_quality_counts"))


def _segment_label(ax, left, value, row, height=0.62):
    """Value inside a wide segment, just above a narrow one."""
    if value <= 0:
        return
    if value >= 30:
        ax.text(left + value / 2, row, f"{value}", ha="center", va="center", fontsize=6.2, color=figstyle.INK,
                bbox={"boxstyle": "round,pad=0.12", "facecolor": "white", "edgecolor": "none", "alpha": 0.85})
    else:
        ax.text(left + value / 2, row + height / 2 + 0.04, f"{value}", ha="center", va="bottom", fontsize=6.0,
                color=figstyle.INK)


def plot_outcomes(scores, out):
    """Where the 300 allowed and the 300 denied requests ended up, in counts."""
    models = list(scores)
    fig, axes = figstyle.figure(height=2.7, nrows=2, sharex=True)
    styles = {"Correct": (figstyle.SERIES[2], figstyle.HATCHES[0]),
              "Wrongly refused": (figstyle.SERIES[1], figstyle.HATCHES[1]),
              "Wrongly granted": (figstyle.SERIES[4], figstyle.HATCHES[4]),
              "Unusable answer": ("#9b9a95", figstyle.HATCHES[2])}
    for panel, (label, right, wrong, wrong_name) in enumerate([
            ("ALLOW", "ALLOW_to_ALLOW", "ALLOW_to_DENY", "Wrongly refused"),
            ("DENY", "DENY_to_DENY", "DENY_to_ALLOW", "Wrongly granted")]):
        ax = axes[panel]
        for row, model in enumerate(models):
            s = scores[model]
            left = 0
            for value, name in [(s[right], "Correct"), (s[wrong], wrong_name), (s[f"{label}_unusable"], "Unusable answer")]:
                color, hatch = styles[name]
                ax.barh(row, value, left=left, height=0.62, color=color, hatch=hatch, edgecolor="white", linewidth=0.6)
                _segment_label(ax, left, value, row)
                left += value
        ax.set_yticks(range(len(models)))
        ax.set_yticklabels(models)
        ax.set_ylim(-0.5, len(models) - 0.3)
        ax.set_title(f"Requests the policy {'allows' if label == 'ALLOW' else 'denies'} (300)", fontsize=7.2, loc="left")
        ax.grid(axis="x", color=figstyle.GRID, linewidth=0.5)
        ax.grid(axis="y", visible=False)
        ax.set_xlim(0, 300)
    handles = [figstyle.plt.Rectangle((0, 0), 1, 1, facecolor=c, hatch=h, edgecolor="white") for c, h in styles.values()]
    fig.legend(handles, list(styles), loc="lower center", bbox_to_anchor=(0.55, 1.0), ncol=4, fontsize=6.0,
               handlelength=1.5, columnspacing=0.9)
    axes[1].set_xlabel("Requests (count)")
    figstyle.save(fig, os.path.join(out, "e1_outcomes_counts"))


def plot_adversarial(adv, out):
    models = list(adv)
    fig, ax = figstyle.figure(height=1.9)
    labels = ["Stopped (denied)", "Got through (wrongly granted)", "Unusable answer"]
    for row, model in enumerate(models):
        s = adv[model]
        parts = [s["DENY_to_DENY"], s["DENY_to_ALLOW"], s["DENY_unusable"]]
        left = 0
        for i, value in enumerate(parts):
            color = [figstyle.SERIES[2], figstyle.SERIES[4], "#9b9a95"][i]
            hatch = [figstyle.HATCHES[0], figstyle.HATCHES[4], figstyle.HATCHES[2]][i]
            ax.barh(row, value, left=left, height=0.6, color=color, hatch=hatch, edgecolor="white",
                    linewidth=0.6, label=labels[i] if row == 0 else None)
            _segment_label(ax, left, value, row, height=0.6)
            left += value
    ax.set_yticks(range(len(models)))
    ax.set_yticklabels(models)
    ax.set_ylim(-0.5, len(models) - 0.3)
    ax.set_xlim(0, 204)
    ax.set_xlabel("Adversarial requests the policy denies (count, of 204)")
    ax.grid(axis="x", color=figstyle.GRID, linewidth=0.5)
    ax.grid(axis="y", visible=False)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, fontsize=5.8)
    figstyle.save(fig, os.path.join(out, "e2_adversarial_counts"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    result = {"sets": {}, "paired": {}, "plain_words": [], "per_reason_v7": None}
    for set_name in SETS:
        result["sets"][set_name] = {}
        rows_by_model = {}
        for model, run in RUNS.items():
            rows = load(run, set_name)
            rows_by_model[model] = rows
            result["sets"][set_name][model] = score(rows)
            with open(os.path.join(run, "metrics.json")) as handle:
                stored = json.load(handle)["sets"][set_name]
            stored_cm = stored.get("confusionMatrix")
            s = result["sets"][set_name][model]
            recomputed_cm = {"ALLOW": {"ALLOW": s["ALLOW_to_ALLOW"], "DENY": s["ALLOW_to_DENY"]},
                             "DENY": {"ALLOW": s["DENY_to_ALLOW"], "DENY": s["DENY_to_DENY"]}}
            s["matches_stored_confusion_matrix"] = stored_cm == recomputed_cm
            s["matches_stored_valid_count"] = stored.get("schemaValid") == s["usable"]
        base, v7 = (rows_by_model[m] for m in RUNS)
        by_id = {r["exampleId"]: r for r in base}
        ok = lambda r: r.get("status") == "OK" and r.get("predicted") and r["predicted"]["recommendation"] == r["expected"]["recommendation"]
        b = c = both = neither = 0
        for r in v7:
            other = by_id.get(r["exampleId"])
            if other is None:
                continue
            x, y = ok(other), ok(r)
            if x and not y:
                b += 1
            elif y and not x:
                c += 1
            elif x and y:
                both += 1
            else:
                neither += 1
        result["paired"][set_name] = {"pairs": b + c + both + neither, "only_untuned_correct": b, "only_v7_correct": c,
                                      "both_correct": both, "both_wrong": neither, "mcnemar_exact_p": mcnemar_exact(b, c)}
    main_set = result["sets"]["test-decision-balanced"]
    for model, s in main_set.items():
        result["plain_words"].extend(plain_words(model, s))
    adv = result["sets"]["test-adversarial"]
    for model, s in adv.items():
        result["plain_words"].append(
            f"{model}: of {s['expected_DENY']} adversarial requests the policy denies, {s['DENY_to_ALLOW']} got through "
            f"(wrongly granted), {s['DENY_to_DENY']} were stopped, {s['DENY_unusable']} unusable.")
    result["per_reason_v7"] = per_reason(load(RUNS["V7 (fine-tuned)"], "test-reason-balanced"))
    result["per_reason_untuned"] = per_reason(load(RUNS["Untuned Qwen3-14B"], "test-reason-balanced"))
    with open(os.path.join(args.out, "accuracy.json"), "w") as handle:
        json.dump(result, handle, indent=2)
    with open(os.path.join(args.out, "accuracy-sets.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["set", "model", "cases", "usable", "correct", "allow_recognised", "allow_total", "deny_stopped",
                         "deny_total", "wrongly_granted", "wrongly_refused", "reason_correct", "clauses_correct",
                         "balanced_accuracy_usable", "matches_stored"])
        for set_name, models in result["sets"].items():
            for model, s in models.items():
                bal = s["balanced_accuracy_usable"]
                writer.writerow([set_name, model, s["cases"], s["usable"], s["correct"], s["ALLOW_to_ALLOW"], s["expected_ALLOW"],
                                 s["DENY_to_DENY"], s["expected_DENY"], s["wrongly_granted"], s["wrongly_refused"],
                                 s["reason_correct"], s["clauses_correct"], f"{bal:.4f}" if bal is not None else "",
                                 s["matches_stored_confusion_matrix"] and s["matches_stored_valid_count"]])
    plot_quality(main_set, args.out)
    plot_outcomes(main_set, args.out)
    plot_adversarial(adv, args.out)
    for line in result["plain_words"]:
        print(line)
    print("paired test (600 set):", result["paired"]["test-decision-balanced"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
