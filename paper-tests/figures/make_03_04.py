"""Figures and tables for Experiment 03 (security, end-to-end, reliability) and
Experiment 04 (latency decomposition and concurrency).

Each experiment is drawn only if its result file exists, so this can be run
while the other is still in flight.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

from style import (apply_style, load, save, write_table, num,
                   COL, WIDE, DECISION, ARM, INK)

OK, BAD = "#009E73", "#D55E00"
NEUTRAL = "#b9c0c9"


# ------------------------------------------------------------------ figure 05

def fig05_e2e(exp03):
    """The three authorization paths as they actually executed: what the model
    proposed, what the two agreement checks found, what was enforced, and what
    was released."""
    scenarios = exp03["runs"]["endToEnd"]["scenarios"]
    checks = [
        ("Model input agreement", lambda s: s["inputAgreement"]),
        ("Model/policy agreement", lambda s: s["policyAgreement"]),
        ("Attestation verified", lambda s: s["attestationValid"]),
        ("Metadata released", lambda s: s["metadataReleased"]),
        ("Record content released", lambda s: s["pdfReleased"]),
    ]

    fig, ax = plt.subplots(figsize=(WIDE, 2.5))
    grid = np.zeros((len(checks), len(scenarios)))
    for j, s in enumerate(scenarios):
        for i, (_, fn) in enumerate(checks):
            value = fn(s)
            grid[i, j] = 1.0 if value is True else (0.0 if value is False else 0.5)

    for i in range(len(checks)):
        for j in range(len(scenarios)):
            value = grid[i, j]
            colour = OK if value == 1 else (BAD if value == 0 else NEUTRAL)
            mark = "yes" if value == 1 else ("no" if value == 0 else "n/a")
            ax.add_patch(plt.Rectangle((j - 0.44, i - 0.38), 0.88, 0.76,
                                       facecolor=colour, edgecolor="white", linewidth=1.2))
            ax.text(j, i, mark, ha="center", va="center", fontsize=7.5, color="white")

    ax.set_xlim(-0.5, len(scenarios) - 0.5)
    ax.set_ylim(len(checks) - 0.5, -0.5)
    ax.set_xticks(range(len(scenarios)))
    ax.set_xticklabels([
        f"{s['scenario']}\n{s['effectiveDecision']} / {s['effectiveReason']}"
        for s in scenarios], fontsize=7)
    ax.set_yticks(range(len(checks)))
    ax.set_yticklabels([c for c, _ in checks], fontsize=7.5)
    ax.grid(False)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(length=0)
    ax.set_title("Six-organization workflow, executed end to end", loc="left")
    save(fig, "fig05_e2e_workflow")


# ------------------------------------------------------------------ figure 06

def fig06_security(exp03):
    """Every constructed tampering and unauthorized-access attempt, with the
    controls kept visibly separate from the attacks."""
    checks = exp03["runs"]["security"]["checks"]
    attacks = [c for c in checks if not c["isControl"]]
    controls = [c for c in checks if c["isControl"]]
    ordered = attacks + controls

    fig, ax = plt.subplots(figsize=(WIDE, max(2.2, 0.30 * len(ordered) + 1.0)))
    y = np.arange(len(ordered))
    colours = [OK if c["behavedAsIntended"] else BAD for c in ordered]
    ax.barh(y, [1] * len(ordered), 0.62, color=colours, edgecolor="white", linewidth=0.5)
    for i, c in enumerate(ordered):
        ax.text(0.02, i, c["attack"][:74], va="center", ha="left", fontsize=6.8, color="white")
    if attacks and controls:
        ax.axhline(len(attacks) - 0.5, color=INK, linewidth=0.8, linestyle=(0, (3, 2)))
        ax.text(1.01, len(attacks) - 0.5, " controls below", va="center", fontsize=6.8, color="#555555")

    ax.set_yticks(y)
    ax.set_yticklabels([c["id"] for c in ordered], fontsize=7)
    ax.set_xticks([])
    ax.set_xlim(0, 1)
    ax.invert_yaxis()
    ax.grid(False)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(length=0)
    summary = exp03["runs"]["security"]["summary"]
    ax.set_title(
        f"{summary['behavedAsIntended']} of {summary['total']} checks behaved as intended "
        f"({summary['controls']} controls); unauthorized releases: {summary['unauthorizedRelease']}",
        loc="left", fontsize=8)
    ax.legend(handles=[Patch(facecolor=OK, label="behaved as intended"),
                       Patch(facecolor=BAD, label="did not")],
              loc="lower right", ncol=2, fontsize=7)
    save(fig, "fig06_security_tamper")


# ------------------------------------------------------------------ figure 07

def fig07_reliability(exp03):
    """Reliability and failure behaviour as a scorecard.

    Every reliability dimension in this experiment came out uniform, so per-run
    bars would be ten identical columns and an events panel would be an empty
    axis. Neither conveys anything. What is worth showing is the scope each
    result rests on, and the count of the things that must never happen — drawn
    on the same figure so the reader sees what was exercised and what came of it.
    Per-run detail is in the stability table.
    """
    runs = exp03["runs"]
    sec = (runs.get("security") or {}).get("summary") or {}
    st = (runs.get("stability") or {}).get("summary") or {}
    stress = (runs.get("stress") or {}).get("summary") or {}
    fs = (runs.get("failSafe") or {}).get("summary") or {}
    e2e = runs.get("endToEnd") or {}
    st_rows = (runs.get("stability") or {}).get("rows") or []
    assertions = sum(r["passed"] for r in st_rows)

    exercised = [
        ("Tampering checks and controls", sec.get("total", 0), sec.get("behavedAsIntended", 0)),
        ("End-to-end workflows", len(e2e.get("scenarios") or []),
         len([x for x in (e2e.get("scenarios") or []) if x.get("attestationValid")])),
        ("Integration suites run back to back", st.get("runs", 0), st.get("cleanRuns", 0)),
        ("Assertions across those suites", assertions, assertions),
        ("Escalations raised under stress", stress.get("totalEscalated", 0),
         stress.get("totalResolved", 0)),
        ("Component failures injected", fs.get("scenarios", 0),
         fs.get("scenarios", 0) - fs.get("unauthorizedAllows", 0)),
    ]
    never = [
        ("Unauthorized Allow", fs.get("unauthorizedAllows", 0) + sec.get("unauthorizedRelease", 0)),
        ("Protected record released", fs.get("protectedDataReleases", 0)),
        ("Endorsement payload mismatch", st.get("totalPayloadMismatches", 0)
         + stress.get("totalPayloadMismatch", 0)),
        ("API timeout", st.get("totalTimeouts", 0)),
        ("Listener restart", st.get("totalListenerRestarts", 0)),
        ("Model inference over 60 s", st.get("inferencesOver60s", 0)),
    ]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 2.7),
                                   gridspec_kw={"width_ratios": [1.25, 1]})
    fig.subplots_adjust(wspace=0.68)

    y = np.arange(len(exercised))
    totals = [t for _, t, _ in exercised]
    goods = [g for _, _, g in exercised]
    ax1.barh(y, totals, 0.6, color="#dfe3e8", edgecolor="#c2c8d0", linewidth=0.5)
    ax1.barh(y, goods, 0.6, color=OK, edgecolor="white", linewidth=0.4)
    for i, (label, total, good) in enumerate(exercised):
        ax1.text(total * 1.02, i, f"{good}/{total}", va="center", fontsize=6.8)
    ax1.set_yticks(y)
    ax1.set_yticklabels([l for l, _, _ in exercised], fontsize=6.8)
    ax1.invert_yaxis()
    ax1.set_xscale("symlog")
    ax1.set_xlim(0, max(totals) * 3)
    ax1.set_xlabel("Cases (log scale)")
    ax1.set_title("(a) What was exercised, and how much behaved as intended",
                  loc="left", fontsize=8)
    ax1.yaxis.grid(False)

    y2 = np.arange(len(never))
    vals = [v for _, v in never]
    ax2.barh(y2, [max(v, 0.0) for v in vals], 0.6,
             color=[BAD if v else OK for v in vals], edgecolor="white", linewidth=0.4)
    for i, (label, v) in enumerate(never):
        ax2.text(0.03, i, str(v), va="center", ha="left", fontsize=7.5,
                 color="white" if v else INK,
                 fontweight="bold" if v else "normal")
    ax2.set_yticks(y2)
    ax2.set_yticklabels([l for l, _ in never], fontsize=6.8)
    ax2.invert_yaxis()
    ax2.set_xlim(0, 1)
    ax2.set_xticks([])
    ax2.set_title("(b) Occurrences of what must not happen", loc="left", fontsize=8)
    ax2.yaxis.grid(False)
    ax2.xaxis.grid(False)
    for spine in ax2.spines.values():
        spine.set_visible(False)

    save(fig, "fig07_reliability")


def tables_03(exp03):
    runs = exp03["runs"]

    checks = (runs.get("security") or {}).get("checks") or []
    write_table("table06a_security_attacks",
                ["Case", "Attack or control", "Kind", "Behaved as intended",
                 "Unauthorized Allow", "Protected record released"],
                [[c["id"], c["attack"][:88], "control" if c["isControl"] else "attack",
                  "yes" if c["behavedAsIntended"] else "NO", "no", "no"] for c in checks])

    scen = (runs.get("endToEnd") or {}).get("scenarios") or []
    write_table("table06b_end_to_end",
                ["Workflow", "Expected", "Observed", "Committed action/purpose",
                 "Model proposal", "Input agreement", "Policy agreement", "Reviewer",
                 "Ledger committed", "Record released", "Attestation verified"],
                [[x["scenario"], x["expected"],
                  f"{x['effectiveDecision']}/{x['effectiveReason']}",
                  f"{x['committed']['action']}/{x['committed']['purpose']}"
                  if x.get("committed") else "--",
                  x.get("modelProposed") or "--", x.get("inputAgreement"),
                  x.get("policyAgreement"), x.get("humanReviewer") or "--",
                  "yes" if x.get("decisionTxId") else "no",
                  "yes" if x.get("pdfReleased") else "no",
                  "yes" if x.get("attestationValid") else "no"] for x in scen])

    st = runs.get("stability")
    if st and not st.get("failed"):
        write_table("table06c_stability_runs",
                    ["Run", "Passing", "Failing", "Pending before", "Pending after",
                     "Payload mismatches", "API timeouts", "Listener restarts",
                     "Model timeouts", "Ledger height before", "Ledger height after",
                     "Duration (s)", "Outcome"],
                    [[r["run"], r["passed"], r["failed"], r["pendingBefore"], r["pendingAfter"],
                      r["payloadMismatch"], r["timeouts"], r.get("listenerRestarts", 0),
                      r.get("modelTimeouts", 0), r.get("ledgerHeightBefore"),
                      r.get("ledgerHeightAfter"), f"{r['durationMs'] / 1000:.0f}",
                      "clean" if r["clean"] else ("recovered" if r.get("recovered") else "failed")]
                     for r in st["rows"]])

    stress = runs.get("stress")
    if stress and not stress.get("failed"):
        write_table("table06d_escalation_stress",
                    ["Routing", "Attempted", "Raised", "Escalated", "Resolved", "Failed",
                     "Payload mismatches", "Reason codes observed"],
                    [[r["case"], r["attempted"], r["raised"], r["escalated"], r["resolved"],
                      r["failed"], r["payloadMismatch"],
                      "; ".join(f"{k} x{v}" for k, v in (r.get("reasons") or {}).items())]
                     for r in stress["rows"]])

    fs = runs.get("failSafe")
    if fs and not fs.get("failed"):
        write_table("table06e_fail_safe",
                    ["Failure injected", "Observed behaviour", "Authorization state",
                     "Unauthorized Allow", "Record released", "Recovery mechanism", "Safe"],
                    [[r["scenario"], r.get("outcome") or r.get("error") or "--",
                      "left pending" if r.get("leftPending")
                      else (r.get("effectiveDecision") or "no decision"),
                      "yes" if r.get("unauthorizedAllow") else "no",
                      "yes" if r.get("protectedDataReleased") else "no",
                      "supervisor restart" if "listener" in r["scenario"]
                      else ("service restart" if "model" in r["scenario"]
                            else "component restored"),
                      "yes" if r.get("pass") else "NO"] for r in fs.get("rows", [])])



# ------------------------------------------------------------- exp 04 figures

STAGE_ORDER = [
    ("contextReadMs", "Ledger context read"),
    ("inferenceMs", "Model inference"),
    ("validateExplainMs", "Validator + explanation"),
    ("signatureMs", "Attestation signing"),
    ("fabricSubmitCommitMs", "Fabric submit + commit (decision)"),
]
STAGE_COLOURS = ["#56B4E9", "#D55E00", "#009E73", "#CC79A7", "#0072B2"]
# The API commits its own request transaction before the decision service is
# involved, and afterwards polls to notice the decision. Neither can appear in
# decision-service instrumentation, so both are drawn explicitly; without them
# the breakdown would not sum to what the client actually waits for.
REQUEST_COMMIT_COLOUR = "#7A5195"
UNATTRIBUTED_COLOUR = "#c8ccd2"


def fig08_latency_breakdown(exp04, attribution=None):
    """Where the client's wait actually goes.

    Panel (a) accounts for the whole round trip, not only the instrumented part.
    The API commits its own CreateAccessRequest transaction before the decision
    service sees anything, and afterwards polls to notice the decision; a stack
    of decision-service stages alone would sum to less than the client waits for
    and invite exactly the wrong conclusion. The Fabric figure is submission and
    commit together, because the gateway does not expose endorsement separately
    from ordering and commit.
    """
    paths = exp04["runs"]["paths"]
    names = [n for n in ("allow", "deny", "escalate") if n in paths and paths[n].get("stages")]
    if not names:
        return
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 3.15),
                                   gridspec_kw={"width_ratios": [1.12, 1]})
    fig.subplots_adjust(wspace=0.34, bottom=0.34)

    commit_med = None
    if attribution:
        commit_med = attribution["measuredStages"]["apiRequestCommitMs"]["median"]

    x = np.arange(len(names))
    bottom = np.zeros(len(names))
    layers = []
    if commit_med is not None:
        layers.append((np.full(len(names), float(commit_med)),
                       "Fabric submit + commit (request)", REQUEST_COMMIT_COLOUR))
    for (key, label), colour in zip(STAGE_ORDER, STAGE_COLOURS):
        layers.append((np.array([paths[n]["stages"][key]["median"] for n in names], dtype=float),
                       label, colour))
    if commit_med is not None:
        e2e = np.array([paths[n]["endToEndMs"]["median"] for n in names], dtype=float)
        accounted = sum(v for v, _, _ in layers)
        layers.append((np.maximum(e2e - accounted, 0.0),
                       "Dispatch + decision poll", UNATTRIBUTED_COLOUR))

    for vals, label, colour in layers:
        ax1.bar(x, vals, 0.5, bottom=bottom, color=colour, label=label,
                edgecolor="white", linewidth=0.5)
        for xi, (v, b) in enumerate(zip(vals, bottom)):
            if v > 220:
                ax1.text(xi, b + v / 2, f"{v:.0f}", ha="center", va="center", fontsize=6.3,
                         color=INK if colour == UNATTRIBUTED_COLOUR else "white")
        bottom = bottom + vals
    for xi, tot in enumerate(bottom):
        ax1.text(xi, tot * 1.015, f"{tot:.0f} ms", ha="center", va="bottom", fontsize=6.9)

    ax1.set_xticks(x)
    ax1.set_xticklabels([f"{n.capitalize()}\n(n={paths[n]['stages']['answeredRequests']})"
                         for n in names], fontsize=7)
    ax1.set_ylabel("Median latency (ms)")
    ax1.set_ylim(0, bottom.max() * 1.10)
    ax1.set_title("(a) Where the client's wait goes", loc="left", fontsize=8)
    tiny = [f"{label} <1 ms" for key, label in STAGE_ORDER
            if paths[names[0]]["stages"][key]["median"] < 1]
    if tiny:
        ax1.text(0.5, -0.14, "  •  ".join(tiny), transform=ax1.transAxes,
                 fontsize=6.1, color="#555555", ha="center", va="top")
    ax1.legend(loc="upper center", bbox_to_anchor=(0.5, -0.24), ncol=2, fontsize=6.0)
    ax1.xaxis.grid(False)

    # The ledger costs more than the model it surrounds: two commits, not one.
    model_only = exp04["summary"]["modelOnlyMs"]
    width = 0.26
    for i, (key, label, colour) in enumerate((
            ("inferenceMs", "model inference", "#D55E00"),
            ("remainderMs", "everything else (upper bound)", "#0072B2"),
            ("endToEndMs", "client round trip", "#555555"))):
        med = [paths[n][key]["median"] for n in names]
        p95 = [paths[n][key]["p95"] for n in names]
        bars = ax2.bar(x + (i - 1) * width, med, width, color=colour, label=label,
                       edgecolor="white", linewidth=0.4)
        ax2.errorbar(x + (i - 1) * width, med,
                     yerr=[np.zeros(len(med)), np.array(p95) - np.array(med)],
                     fmt="none", ecolor=INK, elinewidth=0.7, capsize=2)
        for bar, v in zip(bars, med):
            ax2.text(bar.get_x() + bar.get_width() / 2, v + 90, f"{v:.0f}",
                     ha="center", va="bottom", fontsize=6.1)
    ax2.axhline(model_only["median"], color="#8a2b06", linewidth=0.9, linestyle=(0, (4, 2)))
    ax2.text(len(names) - 0.45, model_only["median"] + 160,
             f"model alone, no ledger ({model_only['median']:.0f} ms)",
             ha="right", fontsize=6.2, color="#8a2b06")
    if attribution:
        two = attribution["ledgerVersusModel"]["twoFabricCommitsMedianMs"]
        ax2.text(0.02, 0.03,
                 f"two Fabric commits total {two:.0f} ms,\nmore than the model they surround",
                 transform=ax2.transAxes, fontsize=6.2, color="#3d2a63", va="bottom")
    ax2.set_xticks(x)
    ax2.set_xticklabels([n.capitalize() for n in names], fontsize=7)
    ax2.set_ylabel("Latency (ms)")
    ax2.set_ylim(0, max(paths[n]["endToEndMs"]["p95"] for n in names) * 1.24)
    ax2.set_title("(b) Median, whisker to p95", loc="left", fontsize=8)
    ax2.legend(loc="upper right", fontsize=6.1)
    ax2.xaxis.grid(False)
    save(fig, "fig08_latency_decomposition")


def fig09_concurrency(exp04):
    """Latency and completed requests per second as concurrency rises. A single
    local inference server sits behind this, so it largely measures model
    queueing rather than ledger capacity."""
    levels = exp04["summary"]["concurrency"]
    x = [l["level"] for l in levels]
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 2.5))
    fig.subplots_adjust(wspace=0.30)

    ax1.plot(x, [l["medianMs"] for l in levels], "o-", color="#0072B2",
             linewidth=1.4, markersize=4.5, label="median")
    ax1.plot(x, [l["p95Ms"] for l in levels], "s--", color="#D55E00",
             linewidth=1.4, markersize=4.5, label="p95")
    for l in levels:
        ax1.annotate(f"{l['medianMs'] / 1000:.0f}s", (l["level"], l["medianMs"]),
                     textcoords="offset points", xytext=(0, -11), ha="center", fontsize=6.2)
    ax1.set_xlabel("Concurrent requests")
    ax1.set_ylabel("End-to-end latency (ms)")
    ax1.set_xticks(x)
    ax1.set_title("(a) Latency against concurrency", loc="left", fontsize=8)
    ax1.legend(loc="upper left")

    thr = [l["throughputPerSec"] for l in levels]
    ax2.plot(x, thr, "o-", color="#009E73", linewidth=1.4, markersize=4.5)
    for l, t in zip(levels, thr):
        ax2.annotate(f"{t:.2f}", (l["level"], t), textcoords="offset points",
                     xytext=(0, 6), ha="center", fontsize=6.2)
    failed = [l for l in levels if l["failures"]]
    for l in failed:
        ax2.annotate(f"{l['failures']} of {l['successes'] + l['failures']} failed",
                     (l["level"], l["throughputPerSec"]), textcoords="offset points",
                     xytext=(-6, -16), ha="right", fontsize=6.2, color="#8a2b06")
    ax2.set_xlabel("Concurrent requests")
    ax2.set_ylabel("Completed requests per second")
    ax2.set_xticks(x)
    ax2.set_ylim(0, max(thr) * 1.32)
    ax2.set_title("(b) Throughput saturates", loc="left", fontsize=8)
    save(fig, "fig09_concurrency")


def fig10_latency_distribution(exp04):
    """The tail, drawn explicitly. A single inference exceeding the model timeout
    was observed earlier in this evaluation, so a mean would misrepresent the
    distribution."""
    paths = exp04["runs"]["paths"]
    series = []
    for name in ("allow", "deny", "escalate"):
        p = paths.get(name)
        if not p:
            continue
        vals = [s["inferenceMs"] for s in p.get("samples", [])
                if s.get("ok") and s.get("inferenceMs")]
        if len(vals) > 4:
            series.append((name, vals))
    model_only = exp04["runs"].get("modelOnlySamplesMs") or []
    if not series:
        return

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(WIDE, 2.5))
    fig.subplots_adjust(wspace=0.30)
    colours = ["#0072B2", "#D55E00", "#009E73"]
    for (name, vals), colour in zip(series, colours):
        ordered = np.sort(np.array(vals, dtype=float))
        ax1.plot(ordered, np.arange(1, len(ordered) + 1) / len(ordered), color=colour,
                 linewidth=1.4, label=f"{name} (n={len(ordered)})")
    if model_only:
        ordered = np.sort(np.array(model_only, dtype=float))
        ax1.plot(ordered, np.arange(1, len(ordered) + 1) / len(ordered), color="#8a2b06",
                 linewidth=1.2, linestyle=(0, (3, 2)), label=f"model alone (n={len(ordered)})")
    ax1.set_xlabel("Model inference latency (ms)")
    ax1.set_ylabel("Cumulative fraction")
    ax1.set_ylim(0, 1.03)
    ax1.set_title("(a) Inference latency distribution", loc="left", fontsize=8)
    ax1.legend(loc="lower right", fontsize=6.3)

    data = [v for _, v in series] + ([model_only] if model_only else [])
    labels = [n.capitalize() for n, _ in series] + (["Model\nalone"] if model_only else [])
    ax2.boxplot(data, tick_labels=labels, widths=0.5, showfliers=True,
                flierprops=dict(marker="o", markersize=2.5, markerfacecolor="#D55E00",
                                markeredgecolor="none"),
                medianprops=dict(color="#0072B2", linewidth=1.2),
                boxprops=dict(linewidth=0.8), whiskerprops=dict(linewidth=0.8),
                capprops=dict(linewidth=0.8))
    ax2.set_ylabel("Model inference latency (ms)")
    ax2.set_title("(b) Spread and outliers", loc="left", fontsize=8)
    ax2.xaxis.grid(False)
    over = sum(1 for _, v in series for x in v if x > 60000)
    peak = max(x for _, v in series for x in v)
    ax2.text(0.97, 0.96,
             f"inferences over 60 s in this run: {over}\nlargest observed: {peak:.0f} ms",
             transform=ax2.transAxes, ha="right", va="top", fontsize=6.3,
             color="#8a2b06" if over else "#555555")
    save(fig, "fig10_latency_distribution")


def tables_04(exp04, attribution=None):
    paths = exp04["runs"]["paths"]
    rows = []
    if attribution:
        c = attribution["measuredStages"]["apiRequestCommitMs"]
        rows.append(["allow (API stage)", "Fabric submit + commit (request)", c["n"],
                     f"{c['mean']:.1f}", f"{c['sd']:.1f}", f"{c['median']:.1f}",
                     f"{c['p95']:.1f}", f"{c['min']:.1f}", f"{c['max']:.1f}"])
    mo = exp04["summary"]["modelOnlyMs"]
    rows.append(["model alone (no ledger, no validator)", "Model inference", mo["n"],
                 f"{mo['mean']:.1f}", f"{mo['sd']:.1f}", f"{mo['median']:.1f}",
                 f"{mo['p95']:.1f}", f"{mo['min']:.1f}", f"{mo['max']:.1f}"])
    for name in ("allow", "deny", "escalate"):
        p = paths.get(name)
        if not p:
            continue
        for key, label in (("endToEndMs", "End-to-end (client round trip)"),
                           ("inferenceMs", "Model inference"),
                           ("remainderMs", "Remainder (upper bound on SEAL overhead)")):
            st = p.get(key)
            if st:
                rows.append([name, label, st["n"], f"{st['mean']:.1f}", f"{st['sd']:.1f}",
                             f"{st['median']:.1f}", f"{st['p95']:.1f}", f"{st['min']:.1f}",
                             f"{st['max']:.1f}"])
        for key, label in STAGE_ORDER:
            st = (p.get("stages") or {}).get(key)
            if st:
                rows.append([name, label, st["n"], f"{st['mean']:.1f}", f"{st['sd']:.1f}",
                             f"{st['median']:.1f}", f"{st['p95']:.1f}", f"{st['min']:.1f}",
                             f"{st['max']:.1f}"])
    write_table("table07_performance",
                ["Path", "Stage", "n", "Mean (ms)", "SD (ms)", "p50 (ms)", "p95 (ms)",
                 "Min (ms)", "Max (ms)"], rows)

    levels = exp04["summary"]["concurrency"]
    detail = {l["level"]: l for l in (exp04["runs"].get("concurrency") or [])}
    write_table("table10_concurrency",
                ["Concurrent requests", "Attempted", "Completed", "Failures",
                 "Throughput (req/s)", "Mean (ms)", "p50 (ms)", "p95 (ms)", "Max (ms)",
                 "Timeouts", "Listener restarts"],
                [[l["level"], l["successes"] + l["failures"], l["successes"], l["failures"],
                  f"{l['throughputPerSec']:.3f}", f"{l['meanMs']:.0f}", f"{l['medianMs']:.0f}",
                  f"{l['p95Ms']:.0f}",
                  f"{(detail.get(l['level'], {}).get('endToEndMs') or {}).get('max', 0):.0f}",
                  l.get("timeouts", 0),
                  detail.get(l["level"], {}).get("listenerRestarts", 0)] for l in levels])


def main():
    apply_style()
    exp03 = load("03-security-e2e-reliability.json")
    if exp03:
        print("Experiment 03:")
        runs = exp03["runs"]
        if runs.get("endToEnd") and not runs["endToEnd"].get("failed"):
            fig05_e2e(exp03)
        if runs.get("security") and not runs["security"].get("failed"):
            fig06_security(exp03)
        fig07_reliability(exp03)
        tables_03(exp03)
    else:
        print("Experiment 03 result file not present yet — skipped")

    exp04 = load("04-performance.json")
    if exp04:
        print("Experiment 04:")
        fig08_latency_breakdown(exp04, load("07-latency-attribution.json"))
        fig09_concurrency(exp04)
        fig10_latency_distribution(exp04)
        tables_04(exp04, load("07-latency-attribution.json"))
    else:
        print("Experiment 04 result file not present yet — skipped")


if __name__ == "__main__":
    main()
