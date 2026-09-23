"""Figures and tables for Experiment 01 (model effectiveness, subject-context
ablation) and Experiment 02 (validator safety, explanation correctness).

Run: python3 paper-tests/figures/make_01_02.py
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import numpy as np
import matplotlib.pyplot as plt

from style import (apply_style, load, save, write_table, pct, num,
                   COL, WIDE, DECISION, ARM, INK, bar_labels)

CLASSES = ["allow", "deny", "escalate"]
PRED = ["allow", "deny", "escalate", "invalid"]


def arm_by_label(exp01, label):
    for arm in exp01["summary"]["arms"]:
        if arm["label"] == label:
            return arm
    raise KeyError(f"arm not found: {label}")


def metrics_by_label(exp01, label):
    for run in exp01["runs"]:
        if run["label"] == label:
            return run["metrics"]
    raise KeyError(f"metrics not found: {label}")


# ------------------------------------------------------------------ figure 01

def fig01_model_effectiveness(exp01):
    """Three retained arms on the same held-out split: what fine-tuning and
    prompt grounding change, and what it costs on each side of the error."""
    labels = ["V6 grounded", "V4 grounded", "V4 short prompt"]
    colours = [ARM["v6"], ARM["v4"], ARM["v4short"]]
    arms = [arm_by_label(exp01, lab) for lab in labels]
    n = arms[0]["n"]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 2.5),
                                   gridspec_kw={"width_ratios": [1.55, 1]})

    groups = [("Joint", "jointAccuracy"), ("Decision", "decisionAccuracy"),
              ("Reason code", "reasonAccuracy")]
    x = np.arange(len(groups))
    width = 0.26
    for i, (arm, colour, label) in enumerate(zip(arms, colours, labels)):
        vals = [arm[key] * 100 for _, key in groups]
        bars = ax1.bar(x + (i - 1) * width, vals, width, color=colour,
                       label=f"{label} (n={arm['n']})", edgecolor="white", linewidth=0.4)
        bar_labels(ax1, bars, vals, "{:.1f}", dy=0.8)
    ax1.set_xticks(x)
    ax1.set_xticklabels([g for g, _ in groups])
    ax1.set_ylabel("Accuracy (%)")
    ax1.set_ylim(0, 112)
    ax1.set_yticks([0, 20, 40, 60, 80, 100])
    ax1.legend(loc="lower left", ncol=1)
    ax1.set_title("(a) Accuracy by criterion", loc="left")
    ax1.xaxis.grid(False)
    lowest = min(min(a["actionAccuracy"], a["purposeAccuracy"]) for a in arms)
    ax1.text(0.5, 0.965,
             f"Action and purpose accuracy $\\geq$ {lowest * 100:.1f}% for every arm",
             transform=ax1.transAxes, ha="center", va="top", fontsize=6.8, color="#555555")

    # Both error directions, because zero false Allow is only meaningful when the
    # false Deny count that buys it is shown next to it.
    x2 = np.arange(2)
    for i, (arm, colour) in enumerate(zip(arms, colours)):
        vals = [arm["falseAllowCount"], arm["falseDenyCount"]]
        bars = ax2.bar(x2 + (i - 1) * width, vals, width, color=colour,
                       edgecolor="white", linewidth=0.4)
        bar_labels(ax2, bars, vals, "{:.0f}", dy=0.35)
    ax2.set_xticks(x2)
    ax2.set_xticklabels([f"False Allow\n(of {arms[0]['nonAllowGroundTruth']} non-Allow)",
                         f"False Deny\n(of {n} cases)"])
    ax2.set_ylabel("Cases")
    ax2.set_ylim(0, max(a["falseDenyCount"] for a in arms) * 1.30)
    ax2.set_title("(b) Errors by direction", loc="left")
    ax2.xaxis.grid(False)

    save(fig, "fig01_model_effectiveness")

# The subject-context ablation figure and its table are produced by
# make_ablation_analysis.py, which reads the raw rows and can therefore report
# Allow recall and the emitted reason-code distribution alongside the
# accuracies. Keeping a second version here would create two sources for one
# figure.

def fig03_confusion(exp01):
    """V6 on the held-out split, and the same model on the matched ablation
    cases with the subject context removed."""
    panels = [
        ("(a) V6, authenticated subject context", metrics_by_label(exp01, "V6 grounded")),
        ("(b) V6, subject context removed", exp01["summary"]["ablation"]["withoutSubject"]),
    ]
    fig, axes = plt.subplots(1, 2, figsize=(WIDE, 2.6))
    fig.subplots_adjust(wspace=0.42)

    for index, (ax, (title, metrics)) in enumerate(zip(axes, panels)):
        cm = metrics["confusionMatrix"]
        mat = np.array([[cm[t][p] for p in PRED] for t in CLASSES], dtype=float)
        row_totals = mat.sum(axis=1, keepdims=True)
        shading = np.divide(mat, row_totals, out=np.zeros_like(mat), where=row_totals > 0)

        ax.imshow(shading, cmap="Blues", vmin=0, vmax=1, aspect="auto")
        for i in range(mat.shape[0]):
            for j in range(mat.shape[1]):
                count = int(mat[i, j])
                share = shading[i, j]
                ax.text(j, i, f"{count}\n{share * 100:.0f}%", ha="center", va="center",
                        fontsize=7, color="white" if share > 0.55 else INK)
        ax.set_xticks(range(len(PRED)))
        ax.set_xticklabels([p.capitalize() for p in PRED])
        ax.set_yticks(range(len(CLASSES)))
        ax.set_yticklabels([f"{c.capitalize()}\n(n={int(row_totals[i][0])})"
                            for i, c in enumerate(CLASSES)])
        ax.set_xlabel("Model proposal")
        if index == 0:
            ax.set_ylabel("Ground truth")
        ax.set_title(f"{title}, n={metrics['n']}", loc="left")
        ax.grid(False)
        ax.set_xticks(np.arange(-0.5, len(PRED), 1), minor=True)
        ax.set_yticks(np.arange(-0.5, len(CLASSES), 1), minor=True)
        ax.tick_params(which="minor", length=0)
        ax.grid(which="minor", color="white", linewidth=1.2)

    save(fig, "fig03_v6_confusion_matrix")


# ------------------------------------------------------------------ figure 04

def fig04_validator_safety(exp02):
    """What the deterministic validator did with proposals that should not be
    enforced, and whether the explanation matched the effective decision."""
    s = exp02["summary"]
    safety, malformed, expl = s["safety"], s["malformed"], s["explanation"]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 2.35),
                                   gridspec_kw={"width_ratios": [1.25, 1]})

    bars_spec = [
        ("Model/policy or model/input\ndisagreements detected",
         safety["disagreementsDetected"], safety["disagreementCases"], DECISION["escalate"]),
        ("Unsafe proposals\nautomatically enforced",
         safety["unsafeProposalsEnforced"], safety["unsafeProposals"], DECISION["deny"]),
        ("Malformed outputs rejected\nbefore use",
         malformed["rejectedBeforeUse"], malformed["totalCases"], DECISION["escalate"]),
        ("Malformed outputs that\nbecame Allow",
         malformed["becameAllow"], malformed["totalCases"], DECISION["deny"]),
        ("Reason codes whose explanation\nmatched the effective decision",
         expl["reasonCodesChecked"] if expl["allDecisionsMatchReason"] else 0,
         expl["reasonCodesChecked"], DECISION["allow"]),
    ]
    y = np.arange(len(bars_spec))
    for i, (label, got, total, colour) in enumerate(bars_spec):
        ax1.barh(i, total, 0.55, color="#eceff3", edgecolor="#c9ced6", linewidth=0.5)
        ax1.barh(i, got, 0.55, color=colour, edgecolor="white", linewidth=0.4)
        ax1.text(total + 0.25, i, f"{got}/{total}", va="center", fontsize=7.5)
    ax1.set_yticks(y)
    ax1.set_yticklabels([b[0] for b in bars_spec], fontsize=7)
    ax1.invert_yaxis()
    ax1.set_xlim(0, max(b[2] for b in bars_spec) + 3)
    ax1.set_xlabel("Cases (shaded bar is the total constructed)")
    ax1.set_title("(a) Evaluated safety and explanation checks", loc="left")
    ax1.yaxis.grid(False)

    # Where the validator sent each constructed unsafe proposal.
    cases = exp02["runs"]["safety"]
    counts = {}
    for case in cases:
        key = case["effectiveDecision"]
        counts[key] = counts.get(key, 0) + 1
    if counts:
        keys = [k for k in ["allow", "deny", "escalate"] if k in counts] + \
               [k for k in counts if k not in ("allow", "deny", "escalate")]
        vals = [counts[k] for k in keys]
        bars = ax2.bar(range(len(keys)), vals, 0.5,
                       color=[DECISION.get(k, "#8c8c8c") for k in keys],
                       edgecolor="white", linewidth=0.4)
        bar_labels(ax2, bars, vals, "{:.0f}", dy=0.06)
        ax2.set_xticks(range(len(keys)))
        ax2.set_xticklabels([k.capitalize() for k in keys])
        ax2.set_ylim(0, max(vals) * 1.25)
    ax2.set_ylabel("Cases")
    ax2.set_xlabel("Effective decision after the validator")
    ax2.set_title(f"(b) Outcome of the {safety['totalCases']} safety cases", loc="left")
    ax2.xaxis.grid(False)

    save(fig, "fig04_validator_safety")


# ------------------------------------------------------------------- tables

def tables(exp01, exp02):
    labels = ["V6 grounded", "V4 grounded", "V4 short prompt"]
    rows = []
    for lab in labels:
        a = arm_by_label(exp01, lab)
        m = metrics_by_label(exp01, lab)
        rows.append([
            a["label"], a["modelVersion"], a["arm"], a["n"],
            pct(a["jointAccuracy"]), pct(a["decisionAccuracy"]), pct(a["reasonAccuracy"]),
            pct(a["actionAccuracy"]), pct(a["purposeAccuracy"]),
            num(a["macroF1"]), a["falseAllowCount"], a["falseDenyCount"],
            a["schemaRejected"], m["inferenceLatencyMs"]["median"], m["inferenceLatencyMs"]["p95"],
        ])
    write_table(
        "table01_model_metrics",
        ["Arm", "Model", "Prompt", "n", "Joint (%)", "Decision (%)", "Reason (%)",
         "Action (%)", "Purpose (%)", "Macro F1", "False Allow", "False Deny",
         "Schema rejected", "Median inference (ms)", "p95 inference (ms)"],
        rows)

    s = exp02["summary"]
    safety, malformed, expl = s["safety"], s["malformed"], s["explanation"]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 2.35),
                                   gridspec_kw={"width_ratios": [1.25, 1]})

    bars_spec = [
        ("Model/policy or model/input\ndisagreements detected",
         safety["disagreementsDetected"], safety["disagreementCases"], DECISION["escalate"]),
        ("Unsafe proposals\nautomatically enforced",
         safety["unsafeProposalsEnforced"], safety["unsafeProposals"], DECISION["deny"]),
        ("Malformed outputs rejected\nbefore use",
         malformed["rejectedBeforeUse"], malformed["totalCases"], DECISION["escalate"]),
        ("Malformed outputs that\nbecame Allow",
         malformed["becameAllow"], malformed["totalCases"], DECISION["deny"]),
        ("Reason codes whose explanation\nmatched the effective decision",
         expl["reasonCodesChecked"] if expl["allDecisionsMatchReason"] else 0,
         expl["reasonCodesChecked"], DECISION["allow"]),
    ]
    y = np.arange(len(bars_spec))
    for i, (label, got, total, colour) in enumerate(bars_spec):
        ax1.barh(i, total, 0.55, color="#eceff3", edgecolor="#c9ced6", linewidth=0.5)
        ax1.barh(i, got, 0.55, color=colour, edgecolor="white", linewidth=0.4)
        ax1.text(total + 0.25, i, f"{got}/{total}", va="center", fontsize=7.5)
    ax1.set_yticks(y)
    ax1.set_yticklabels([b[0] for b in bars_spec], fontsize=7)
    ax1.invert_yaxis()
    ax1.set_xlim(0, max(b[2] for b in bars_spec) + 3)
    ax1.set_xlabel("Cases (shaded bar is the total constructed)")
    ax1.set_title("(a) Evaluated safety and explanation checks", loc="left")
    ax1.yaxis.grid(False)

    # Where the validator sent each constructed unsafe proposal.
    cases = exp02["runs"]["safety"]
    counts = {}
    for case in cases:
        key = case["effectiveDecision"]
        counts[key] = counts.get(key, 0) + 1
    if counts:
        keys = [k for k in ["allow", "deny", "escalate"] if k in counts] + \
               [k for k in counts if k not in ("allow", "deny", "escalate")]
        vals = [counts[k] for k in keys]
        bars = ax2.bar(range(len(keys)), vals, 0.5,
                       color=[DECISION.get(k, "#8c8c8c") for k in keys],
                       edgecolor="white", linewidth=0.4)
        bar_labels(ax2, bars, vals, "{:.0f}", dy=0.06)
        ax2.set_xticks(range(len(keys)))
        ax2.set_xticklabels([k.capitalize() for k in keys])
        ax2.set_ylim(0, max(vals) * 1.25)
    ax2.set_ylabel("Cases")
    ax2.set_xlabel("Effective decision after the validator")
    ax2.set_title(f"(b) Outcome of the {safety['totalCases']} safety cases", loc="left")
    ax2.xaxis.grid(False)

    save(fig, "fig04_validator_safety")


# ------------------------------------------------------------------- tables

def tables(exp01, exp02):
    labels = ["V6 grounded", "V4 grounded", "V4 short prompt"]
    rows = []
    for lab in labels:
        a = arm_by_label(exp01, lab)
        m = metrics_by_label(exp01, lab)
        rows.append([
            a["label"], a["modelVersion"], a["arm"], a["n"],
            pct(a["jointAccuracy"]), pct(a["decisionAccuracy"]), pct(a["reasonAccuracy"]),
            pct(a["actionAccuracy"]), pct(a["purposeAccuracy"]),
            num(a["macroF1"]), a["falseAllowCount"], a["falseDenyCount"],
            a["schemaRejected"], m["inferenceLatencyMs"]["median"], m["inferenceLatencyMs"]["p95"],
        ])
    write_table(
        "table01_model_metrics",
        ["Arm", "Model", "Prompt", "n", "Joint (%)", "Decision (%)", "Reason (%)",
         "Action (%)", "Purpose (%)", "Macro F1", "False Allow", "False Deny",
         "Schema rejected", "Median inference (ms)", "p95 inference (ms)"],
        rows)

    abl = exp01["summary"]["ablation"]
    keys = [("Joint accuracy (%)", "jointAccuracy"), ("Decision accuracy (%)", "decisionAccuracy"),
            ("Reason-code accuracy (%)", "reasonAccuracy"), ("Action accuracy (%)", "actionAccuracy"),
            ("Purpose accuracy (%)", "purposeAccuracy"), ("Macro F1", "macroF1")]
    arows = []
    for name, key in keys:
        w, o = abl["withSubject"][key], abl["withoutSubject"][key]
        scale = 1 if key == "macroF1" else 100
        digits = 4 if key == "macroF1" else 1
        arows.append([name, f"{w * scale:.{digits}f}", f"{o * scale:.{digits}f}",
                      f"{(w - o) * scale:+.{digits}f}"])
    arows.append(["False Allow (of %d non-Allow)" % abl["withSubject"]["nonAllowGroundTruth"],
                  abl["withSubject"]["falseAllowCount"], abl["withoutSubject"]["falseAllowCount"],
                  abl["withoutSubject"]["falseAllowCount"] - abl["withSubject"]["falseAllowCount"]])
    arows.append(["Schema-valid outputs", abl["withSubject"]["schemaValid"],
                  abl["withoutSubject"]["schemaValid"],
                  abl["withoutSubject"]["schemaValid"] - abl["withSubject"]["schemaValid"]])
    write_table("table02_context_ablation",
                ["Metric", "With authenticated subject context",
                 "Without authenticated subject context", "Difference"], arows)

    s = exp02["summary"]
    write_table(
        "table03_safety_xai",
        ["Check", "Observed", "Constructed cases", "Outcome"],
        [
            ["Model/policy and model/input disagreements detected",
             s["safety"]["disagreementsDetected"], s["safety"]["disagreementCases"],
             "all detected" if s["safety"]["disagreementDetectionRate"] == 1 else "incomplete"],
            ["Unsafe proposals automatically enforced",
             s["safety"]["unsafeProposalsEnforced"], s["safety"]["unsafeProposals"], "none enforced"],
            ["False Allows after the validator",
             s["safety"]["falseAllowsAfterValidator"], s["safety"]["totalCases"], "none observed"],
            ["Malformed model outputs rejected before use",
             s["malformed"]["rejectedBeforeUse"], s["malformed"]["totalCases"], "all rejected"],
            ["Malformed outputs that became Allow",
             s["malformed"]["becameAllow"], s["malformed"]["totalCases"], "none"],
            ["Reason codes exercised",
             s["explanation"]["activeReasonCodes"], s["explanation"]["reasonCodesChecked"], "all exercised"],
            ["Explanation consistent with the effective decision",
             "yes" if s["explanation"]["allDecisionsMatchReason"] else "no",
             s["explanation"]["reasonCodesChecked"], "consistent"],
            ["Decisive attributes correct",
             "yes" if s["explanation"]["allDecisiveAttributesCorrect"] else "no",
             s["explanation"]["reasonCodesChecked"], "correct"],
            ["Proposed text retained after a disagreement",
             "yes" if s["explanation"]["disagreementRetainedProposedText"] else "no",
             s["safety"]["disagreementCases"], "replaced"],
        ])

    # Per-class behaviour for V6: the zero false Allow figure is only readable
    # next to the Allow recall that pays for it.
    m = metrics_by_label(exp01, "V6 grounded")
    prows = []
    for cls in CLASSES:
        c = m["perClass"][cls]
        prows.append([cls.capitalize(), c["support"], c["tp"], c["fp"], c["fn"],
                      num(c["precision"]), num(c["recall"]), num(c["f1"])])
    prows.append(["Macro average", m["n"], "--", "--", "--", "--", "--", num(m["macroF1"])])
    write_table("table04_v6_per_class",
                ["Class", "Support", "TP", "FP", "FN", "Precision", "Recall", "F1"], prows)


def main():
    apply_style()
    exp01, exp02 = load("01-model-context.json"), load("02-safety-xai.json")
    if not exp01 or not exp02:
        raise SystemExit("experiment 01/02 results missing — run them first")
    print("Experiments 01 and 02:")
    fig01_model_effectiveness(exp01)
    fig03_confusion(exp01)
    fig04_validator_safety(exp02)
    tables(exp01, exp02)


if __name__ == "__main__":
    main()
