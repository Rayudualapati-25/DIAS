"""Ablation analysis: what the authenticated subject context actually buys.

The headline number — joint accuracy falling from 80% to 35% — is easy to
misread as the model becoming worse at deciding. It does not. This script
establishes what changed and what did not, directly from the raw rows:

  * Allow recall is zero in BOTH arms. Neither arm ever proposes Allow on this
    set, so nothing here supports any claim about Allow recall in either
    direction.
  * Decision accuracy is a weak discriminator on this set, because 80 of the 100
    cases are Deny. A model that never proposes Allow already scores 80%.
  * The entire effect is in the reason code, and the emitted reason-code
    distribution shows why.
"""

import json
import pathlib
import sys
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import numpy as np
import matplotlib.pyplot as plt

from style import apply_style, save, write_table, RESULTS, WIDE, ARM, INK

RUNS = pathlib.Path(__file__).resolve().parents[2] / "experiments/runs/20260906_seal_precision_e2e"
ARMS = {
    "with": ("with authenticated subject context", "ablation_full_trusted_subject_v6_best.json"),
    "without": ("without authenticated subject context", "ablation_no_trusted_subject_v6_best.json"),
}
FIELDS = ("action", "purpose", "decision", "reasonCode")


def rows(filename):
    return json.loads((RUNS / filename).read_text())["rows"]


def predicted(row):
    return (row.get("prediction") or {}) if row.get("valid") else {}


def analyse():
    out = {}
    for key, (label, filename) in ARMS.items():
        data = rows(filename)
        truth = Counter(r["expected"]["decision"] for r in data)
        pred = Counter(predicted(r).get("decision", "invalid") for r in data)
        allow_rows = [r for r in data if r["expected"]["decision"] == "allow"]
        allow_pred = Counter(predicted(r).get("decision", "invalid") for r in allow_rows)
        comp = {
            f: sum(1 for r in data if predicted(r).get(f) == r["expected"][f]) / len(data)
            for f in FIELDS
        }
        joint = sum(
            1 for r in data
            if all(predicted(r).get(f) == r["expected"][f] for f in FIELDS)
        ) / len(data)
        out[key] = {
            "label": label, "n": len(data),
            "groundTruthDistribution": dict(truth),
            "predictedDistribution": dict(pred),
            "allowGroundTruthCases": len(allow_rows),
            "allowPredictedAs": dict(allow_pred),
            "allowRecall": allow_pred.get("allow", 0) / len(allow_rows),
            "componentAccuracy": comp,
            "jointAccuracy": joint,
            "majorityClass": truth.most_common(1)[0][0],
            "majorityClassBaselineDecisionAccuracy": max(truth.values()) / len(data),
            "reasonCodesEmitted": dict(Counter(predicted(r).get("reasonCode") for r in data).most_common()),
        }
    return out


def figure(a):
    """Three panels: what did not change, what did, and the mechanism."""
    # Three panels do not fit across one IEEE column width without the reason-code
    # labels colliding with the panel beside them, so the mechanism panel gets the
    # full width of its own row.
    fig = plt.figure(figsize=(WIDE, 4.5))
    gs = fig.add_gridspec(2, 2, height_ratios=[1.0, 1.15], width_ratios=[1.15, 1.0],
                          hspace=0.62, wspace=0.28, top=0.88, bottom=0.09)
    axes = [fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1]), fig.add_subplot(gs[1, :])]
    w, o = a["with"], a["without"]

    # (a) component accuracies, with the trivial baseline drawn in
    ax = axes[0]
    labels = ["Action", "Purpose", "Decision", "Reason\ncode", "Joint"]
    keys = ["action", "purpose", "decision", "reasonCode"]
    wv = [w["componentAccuracy"][k] * 100 for k in keys] + [w["jointAccuracy"] * 100]
    ov = [o["componentAccuracy"][k] * 100 for k in keys] + [o["jointAccuracy"] * 100]
    x = np.arange(len(labels))
    ax.bar(x - 0.2, wv, 0.4, color=ARM["with"], label="with", edgecolor="white", linewidth=0.4)
    ax.bar(x + 0.2, ov, 0.4, color=ARM["without"], label="without", edgecolor="white", linewidth=0.4)
    for xi, (a1, b1) in enumerate(zip(wv, ov)):
        ax.text(xi - 0.2, a1 + 2, f"{a1:.0f}", ha="center", fontsize=6.2)
        ax.text(xi + 0.2, b1 + 2, f"{b1:.0f}", ha="center", fontsize=6.2)
    base = w["majorityClassBaselineDecisionAccuracy"] * 100
    ax.axhline(base, color=INK, linewidth=0.8, linestyle=(0, (4, 2)))
    ax.text(-0.45, base + 2.5, f"always-Deny baseline ({base:.0f}%)",
            ha="left", fontsize=6.2, color="#444444")
    ax.set_xticks(x)
    ax.set_xticklabels(["Action", "Purpose", "Decision", "Reason code", "Joint"],
                       fontsize=6.8, rotation=22, ha="right")
    ax.set_ylabel("Accuracy (%)")
    ax.set_ylim(0, 124)
    ax.set_yticks([0, 20, 40, 60, 80, 100])
    ax.set_title("(a) Accuracy by criterion", loc="left", fontsize=8)
    ax.xaxis.grid(False)

    # (b) what each arm actually proposes — neither ever proposes Allow
    ax = axes[1]
    classes = ["allow", "deny", "escalate"]
    wp = [w["predictedDistribution"].get(c, 0) for c in classes]
    op = [o["predictedDistribution"].get(c, 0) for c in classes]
    gt = [w["groundTruthDistribution"].get(c, 0) for c in classes]
    x = np.arange(len(classes))
    ax.bar(x - 0.27, gt, 0.27, color="#b9c0c9", label="ground truth", edgecolor="white", linewidth=0.4)
    ax.bar(x, wp, 0.27, color=ARM["with"], label="with", edgecolor="white", linewidth=0.4)
    ax.bar(x + 0.27, op, 0.27, color=ARM["without"], label="without", edgecolor="white", linewidth=0.4)
    for xi, (g, ww, oo) in enumerate(zip(gt, wp, op)):
        for dx, v in ((-0.27, g), (0, ww), (0.27, oo)):
            ax.text(xi + dx, v + 1.2, str(v), ha="center", fontsize=6.3)
    ax.annotate("neither arm ever\nproposes Allow", xy=(0.0, 2), xytext=(0.55, 46),
                fontsize=6.4, ha="left", va="center", color="#8a2b06",
                arrowprops=dict(arrowstyle="->", color="#8a2b06", lw=0.7,
                                connectionstyle="arc3,rad=-0.25"))
    ax.set_xticks(x)
    ax.set_xticklabels([c.capitalize() for c in classes], fontsize=7)
    ax.set_ylabel("Cases")
    ax.set_ylim(0, 100)
    ax.set_title("(b) Proposed class", loc="left", fontsize=8)
    ax.xaxis.grid(False)

    # (c) the mechanism: which reason codes each arm emits
    ax = axes[2]
    codes = [c for c, _ in Counter(
        {**{k: v for k, v in w["reasonCodesEmitted"].items()}}).most_common()]
    extra = [c for c in o["reasonCodesEmitted"] if c not in codes]
    codes = (codes + extra)[:10]
    wc = [w["reasonCodesEmitted"].get(c, 0) for c in codes]
    oc = [o["reasonCodesEmitted"].get(c, 0) for c in codes]
    order = np.argsort([-(a1 + b1) for a1, b1 in zip(wc, oc)])
    codes = [codes[i] for i in order]
    wc = [wc[i] for i in order]
    oc = [oc[i] for i in order]
    y = np.arange(len(codes))
    ax.barh(y - 0.2, wc, 0.4, color=ARM["with"], edgecolor="white", linewidth=0.4)
    ax.barh(y + 0.2, oc, 0.4, color=ARM["without"], edgecolor="white", linewidth=0.4)
    for yi, (a1, b1) in enumerate(zip(wc, oc)):
        if a1:
            ax.text(a1 + 1, yi - 0.2, str(a1), va="center", fontsize=6.2)
        if b1:
            ax.text(b1 + 1, yi + 0.2, str(b1), va="center", fontsize=6.2)
    ax.set_yticks(y)
    ax.set_yticklabels([c.replace("_", " ").capitalize() for c in codes], fontsize=6.6)
    ax.invert_yaxis()
    ax.set_xlabel("Cases")
    ax.set_xlim(0, max(max(wc), max(oc)) * 1.22)
    ax.set_title("(c) Reason codes emitted — the mechanism behind the joint-accuracy drop",
                 loc="left", fontsize=8)
    ax.yaxis.grid(False)

    handles, labels_ = axes[0].get_legend_handles_labels()
    h2, l2 = axes[1].get_legend_handles_labels()
    fig.legend([h2[0]] + handles, ["ground truth", "with authenticated subject context",
                                   "without authenticated subject context"],
               loc="upper center", ncol=3, bbox_to_anchor=(0.5, 1.06))
    save(fig, "fig02_subject_context_ablation")


def tables(a):
    w, o = a["with"], a["without"]
    write_table("table02_context_ablation", [
        "Measure", "With authenticated subject context",
        "Without authenticated subject context", "Difference"], [
        ["Action accuracy (%)", f"{w['componentAccuracy']['action']*100:.0f}",
         f"{o['componentAccuracy']['action']*100:.0f}",
         f"{(w['componentAccuracy']['action']-o['componentAccuracy']['action'])*100:+.0f}"],
        ["Purpose accuracy (%)", f"{w['componentAccuracy']['purpose']*100:.0f}",
         f"{o['componentAccuracy']['purpose']*100:.0f}",
         f"{(w['componentAccuracy']['purpose']-o['componentAccuracy']['purpose'])*100:+.0f}"],
        ["Decision accuracy (%)", f"{w['componentAccuracy']['decision']*100:.0f}",
         f"{o['componentAccuracy']['decision']*100:.0f}",
         f"{(w['componentAccuracy']['decision']-o['componentAccuracy']['decision'])*100:+.0f}"],
        ["Reason-code accuracy (%)", f"{w['componentAccuracy']['reasonCode']*100:.0f}",
         f"{o['componentAccuracy']['reasonCode']*100:.0f}",
         f"{(w['componentAccuracy']['reasonCode']-o['componentAccuracy']['reasonCode'])*100:+.0f}"],
        ["Joint accuracy (%)", f"{w['jointAccuracy']*100:.0f}", f"{o['jointAccuracy']*100:.0f}",
         f"{(w['jointAccuracy']-o['jointAccuracy'])*100:+.0f}"],
        ["Allow ground-truth cases", w["allowGroundTruthCases"], o["allowGroundTruthCases"], "0"],
        ["Allow recall", f"{w['allowRecall']:.2f}", f"{o['allowRecall']:.2f}", "0.00"],
        ["Allow proposals made", w["predictedDistribution"].get("allow", 0),
         o["predictedDistribution"].get("allow", 0), "0"],
        ["Always-Deny baseline decision accuracy (%)",
         f"{w['majorityClassBaselineDecisionAccuracy']*100:.0f}",
         f"{o['majorityClassBaselineDecisionAccuracy']*100:.0f}", "0"],
    ])

    codes = sorted(set(w["reasonCodesEmitted"]) | set(o["reasonCodesEmitted"]),
                   key=lambda c: -(w["reasonCodesEmitted"].get(c, 0) + o["reasonCodesEmitted"].get(c, 0)))
    write_table("table08_ablation_reason_codes",
                ["Reason code", "With subject context", "Without subject context", "Change"],
                [[c, w["reasonCodesEmitted"].get(c, 0), o["reasonCodesEmitted"].get(c, 0),
                  f"{o['reasonCodesEmitted'].get(c, 0) - w['reasonCodesEmitted'].get(c, 0):+d}"]
                 for c in codes if c])


def main():
    apply_style()
    a = analyse()
    w, o = a["with"], a["without"]
    payload = {
        "analysis": "authenticated subject-context ablation, matched validation cases",
        "arms": a,
        "findings": [
            "Allow recall is 0.00 in BOTH arms: neither arm proposes Allow for any of the "
            f"{w['allowGroundTruthCases']} Allow ground-truth cases, so this ablation supports "
            "no claim about Allow recall in either direction.",
            f"The set is dominated by Deny ({w['groundTruthDistribution']['deny']} of {w['n']}), "
            f"so a model that never proposes Allow already scores "
            f"{w['majorityClassBaselineDecisionAccuracy']*100:.0f}% decision accuracy. Decision "
            "accuracy is a weak discriminator here, which is why it barely separates the arms.",
            "The ablation's effect is concentrated in the reason code: "
            f"{w['componentAccuracy']['reasonCode']*100:.0f}% against "
            f"{o['componentAccuracy']['reasonCode']*100:.0f}%, while action and purpose are "
            "essentially unchanged.",
            "The mechanism is visible in the emitted reason codes. Without the subject context "
            f"the model collapses onto RBAC_NO_PERMISSION for "
            f"{o['reasonCodesEmitted'].get('RBAC_NO_PERMISSION', 0)} of {o['n']} cases, and the "
            "subject-dependent barriers it can no longer identify — cross-jurisdiction and "
            "credential status — largely disappear from its output.",
        ],
        "correctInterpretation":
            "The authenticated subject context substantially improves joint structured "
            "classification of action, purpose, decision and reason code, principally by "
            "letting the model name the correct subject-dependent barrier. Decision-only "
            "accuracy changes much less, and the ablation says nothing about Allow recall.",
        "incorrectInterpretation":
            "The 80% to 35% joint drop must NOT be read as a change in Allow recall, nor as "
            "the model becoming unable to decide. Allow recall is zero in both arms.",
    }
    (RESULTS / "06-ablation-analysis.json").write_text(json.dumps(payload, indent=2) + "\n")
    print("  wrote 06-ablation-analysis.json")
    for f in payload["findings"]:
        print(f"   - {f}")
    figure(a)
    tables(a)


if __name__ == "__main__":
    main()
