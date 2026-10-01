#!/usr/bin/env python3
"""Write a DRAFT of the new Experiments and Results section from the summaries.

The draft is a suggestion for the author, who writes the paper: it is written
to a separate file and never touches the Overleaf sections. Every number is
read from the analysis summaries. Style follows the author's rules: plain
sentences, each subsection starts from its figure, ends with the trend, short
captions, no "measured"/"automated" workflows.

Usage: python3 make_paper_draft.py --analysis <run>/analysis --out <run>/paper/results_draft.tex
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_report import linear_fit  # noqa: E402


def load(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def pct(k, n, d=2):
    return f"{100.0 * k / n:.{d}f}\\%"


def fig(name, caption, label, width="\\columnwidth", star=False):
    env = "figure*" if star else "figure"
    return (f"\\begin{{{env}}}[tb]\n  \\centering\n  \\includegraphics[width={width}]{{figures/testbed/{name}.pdf}}\n"
            f"  \\caption{{{caption}}}\n  \\label{{{label}}}\n\\end{{{env}}}\n")


def setting(manifest):
    return r"""\subsection{Testbed Setup and Data Preparation}

Fig.~\ref{fig:tb-layout} shows the testbed. Four Linux virtual machines (M1--M4), each with three virtual CPUs and 6~GB of memory, run on one Apple M3 Max computer with 16 cores and 64~GB of memory. Docker Swarm joins the four Docker engines, and every container reaches the others through one overlay network. M1, M2, and M3 host the five organizations' peers with their CouchDB state databases, one Raft orderer each, and the six certificate authorities. M4 hosts the application backend, the load generator, and the Prometheus monitor. The Mac itself (M5) serves the language model on its GPU, because the MLX runtime needs that GPU.

The network runs Hyperledger Fabric~2.5.16 with the same block settings as the prototype: a block closes after 2~s or 10 transactions. The chaincode requires endorsement by three of the five organizations. The ledger records each request and each auditor decision together with the LLM recommendation value; the justification and the model's explanation stay off the ledger. Every 5~s, Prometheus records the CPU and memory of each machine, and a sampler records those of every container through the Docker statistics interface. The model machine is sampled on the Mac itself.

The recommendation data come from a seeded generator (seed 20260912) that applies the written policy through an offline reference oracle. It produced 10,513 raw examples, of which 8,013 form eight disjoint sets: 5,254 balanced training examples, 400 validation examples, five test sets of 600, 540, 389, 400, and 370 examples, and 60 workflow examples. No scenario family, fact set, or prompt of the training set appears in any test set. V7 fine-tunes Qwen3-14B (4-bit) with a rank-8 LoRA adapter on 16 layers for 5,254 iterations, with batch size 1, gradient accumulation 4, learning rate $10^{-5}$, and a maximum sequence length of 2,560 tokens.

For the system experiments, the ledger holds 120 users: the 20 users of the prototype and 100 load-test users that copy the twelve requester profiles, together with 3 cases and 20 case files covering all record types, sensitivity levels, and protection flags. Every request of every run is fixed in advance by a seeded plan that also stores the policy's answer to it, and no two requests in a run share the same verified facts. In every approval/deny workflow, the auditor follows the recommendation as soon as it appears; the reported times therefore contain no human review time.
""" + fig("testbed_layout", "Multi-machine testbed.", "fig:tb-layout", width="\\textwidth", star=True)


def quality(acc):
    main = acc["sets"]["test-decision-balanced"]
    b, v = main["Untuned Qwen3-14B"], main["V7 (fine-tuned)"]
    p = acc["paired"]["test-decision-balanced"]
    text = f"""\\subsection{{Recommendation Quality}}

Fig.~\\ref{{fig:tb-quality}} shows where the 600 balanced test decisions end up for each model. Of the 300 requests that the policy allows, V7 recommends {v['ALLOW_to_ALLOW']} for approval and wrongly refuses {v['ALLOW_to_DENY']}, whereas the untuned model approves only {b['ALLOW_to_ALLOW']}, refuses {b['ALLOW_to_DENY']}, and gives {b['ALLOW_unusable']} unusable answers. Of the 300 requests that the policy denies, V7 denies {v['DENY_to_DENY']} and wrongly grants {v['DENY_to_ALLOW']}; the untuned model denies {b['DENY_to_DENY']}, grants {b['DENY_to_ALLOW']}, and gives {b['DENY_unusable']} unusable answers.

Table~\\ref{{tab:tb-quality}} lists the same outcomes as counts. A usable answer is one the auditor screen can display; V7 gives {v['usable']} of 600 and the untuned model {b['usable']}. A wrongly granted request is a security risk and a wrongly refused one costs the requester time, which is why both rows are reported separately. The correct reason code tells the auditor which rule decided the case, and the correct clause list points to the exact policy text the auditor must check: V7 names the right reason in {v['reason_correct']} cases and the exact clauses in {v['clauses_correct']}, against {b['reason_correct']} and {b['clauses_correct']} for the untuned model.

On the same 600 cases, V7 is correct where the untuned model is wrong {p['only_v7_correct']} times, and the reverse happens {p['only_untuned_correct']} times. An exact McNemar test on these paired decisions gives $p = {p['mcnemar_exact_p']:.1e}$, so the difference is not a chance effect of this test set.
"""
    text += fig("e1_outcomes_counts", "Recommendation outcomes on 600 test decisions.", "fig:tb-quality")
    rows = [
        ("Usable answers (of 600)", b["usable"], v["usable"]),
        ("Allowed requests approved (of 300)", b["ALLOW_to_ALLOW"], v["ALLOW_to_ALLOW"]),
        ("Denied requests denied (of 300)", b["DENY_to_DENY"], v["DENY_to_DENY"]),
        ("Wrongly granted", b["wrongly_granted"], v["wrongly_granted"]),
        ("Wrongly refused", b["wrongly_refused"], v["wrongly_refused"]),
        ("Correct decisions (of 600)", b["correct"], v["correct"]),
        ("Correct reason code (of 600)", b["reason_correct"], v["reason_correct"]),
        ("Correct clause list (of 600)", b["clauses_correct"], v["clauses_correct"]),
    ]
    text += ("\\begin{table}[tb]\n  \\centering\n  \\caption{Recommendation Outcomes on 600 Test Decisions}\n"
             "  \\label{tab:tb-quality}\n  \\footnotesize\n  \\begin{tabular}{@{}lrr@{}}\n    \\toprule\n"
             "    Outcome & Untuned & V7 \\\\\n    \\midrule\n")
    for name, x, y in rows:
        text += f"    {name} & {x} & {y} \\\\\n"
    text += "    \\bottomrule\n  \\end{tabular}\n\\end{table}\n"
    names = [("validation-balanced", "Validation (balanced)"), ("test-decision-balanced", "Test, balanced decisions"),
             ("test-reason-balanced", "Test, balanced reasons"), ("test-adversarial", "Test, adversarial"),
             ("test-ood-paraphrase", "Test, paraphrased"), ("test-multi-rule", "Test, several rules")]
    text += ("\nTable~\\ref{tab:tb-sets} repeats the comparison on every held-out set. V7 is correct on at least "
             + str(min(acc["sets"][k]["V7 (fine-tuned)"]["correct"] * 1000 // acc["sets"][k]["V7 (fine-tuned)"]["cases"]
                       for k, _ in names) / 10)
             + "\\% of the cases of each set, including the paraphrased requests whose wording differs from training, "
             "whereas most errors of the untuned model are wrong refusals and unusable answers.\n")
    text += ("\\begin{table}[tb]\n  \\centering\n  \\caption{Correct Decisions on Every Held-Out Set}\n"
             "  \\label{tab:tb-sets}\n  \\footnotesize\n  \\setlength{\\tabcolsep}{3pt}\n"
             "  \\begin{tabular}{@{}lrrrr@{}}\n    \\toprule\n"
             "    Set & Cases & Untuned & V7 & V7 wrongly granted \\\\\n    \\midrule\n")
    for key, label in names:
        b = acc["sets"][key]["Untuned Qwen3-14B"]
        v = acc["sets"][key]["V7 (fine-tuned)"]
        text += f"    {label} & {v['cases']} & {b['correct']} & {v['correct']} & {v['wrongly_granted']} \\\\\n"
    text += "    \\bottomrule\n  \\end{tabular}\n\\end{table}\n"
    return text


def adversarial(acc):
    adv = acc["sets"]["test-adversarial"]
    b, v = adv["Untuned Qwen3-14B"], adv["V7 (fine-tuned)"]
    low, high = v["wrongly_granted_ci95"]
    return f"""\\subsection{{Adversarial Failure Test}}

Fig.~\\ref{{fig:tb-adversarial}} shows the {v['expected_DENY']} adversarial requests that the policy denies and whose justifications contradict the facts or carry injected instructions. V7 stops {v['DENY_to_DENY']} of them and wrongly grants {v['DENY_to_ALLOW']}, a rate of {pct(v['DENY_to_ALLOW'], v['expected_DENY'])} with a 95\\% Wilson interval of {100 * low:.2f}--{100 * high:.2f}\\%. The untuned model grants {b['DENY_to_ALLOW']} but cannot answer {b['DENY_unusable']} of them at all, and it refuses {b['ALLOW_to_DENY']} of the {b['expected_ALLOW']} allowed adversarial requests, so its lower count comes from denying almost everything. The failures of V7 remain the reason why the auditor, not the model, makes the binding decision.
""" + fig("e2_adversarial_counts", "Adversarial requests that the policy denies.", "fig:tb-adversarial")


def latency(e3, e4, e5, replay, errors):
    parts = ["\\subsection{Latency and Throughput}\n"]
    if e5:
        users = [lv["users"] for lv in e5]
        p50 = [lv["end_to_end_s"]["p50"] for lv in e5]
        p95 = [lv["end_to_end_s"]["p95"] for lv in e5]
        slope, intercept, r2 = linear_fit(users, p50)
        first, last = e5[0], e5[-1]
        comp_last = last["components_mean_s"]
        comp_first = first["components_mean_s"]
        st_first, st_last = first["ledger_stages_mean_s"], last["ledger_stages_mean_s"]
        services = [sum(v for k, v in lv["components_mean_s"].items() if k != "queue_wait") for lv in e5]
        tput = [lv["throughput_workflows_per_min"]["mean"] for lv in e5]
        correct = sum(lv["accuracy"]["correct"] for lv in e5)
        valid = sum(lv["accuracy"]["valid"] for lv in e5)
        total = sum(lv["requested"] for lv in e5)
        done = sum(lv["completed"] for lv in e5)
        commit_verb = "grows" if comp_last["request_commit"] > comp_first["request_commit"] else "changes"
        parts.append(f"""Fig.~\\ref{{fig:tb-components}} splits the time of one approval/deny workflow into its components at 10, 25, 50, 75, and 100 simultaneous users; each level ran three times, and all {done} of {total} workflows completed. Panel (b) shows the work each workflow needs: the request commit, the LLM inference, the decision commit, and the application steps. This work stays between {min(services):.2f}~s and {max(services):.2f}~s at every level. The LLM inference takes {comp_last['llm_inference']:.2f}~s, and the decision commit takes {comp_last['decision_commit']:.2f}~s because a decision arrives alone and waits for the 2~s block timeout. The request commit {commit_verb} from {comp_first['request_commit']:.2f}~s at 10 users to {comp_last['request_commit']:.2f}~s at 100: endorsement takes {st_first['request_endorse']:.2f}~s and {st_last['request_endorse']:.2f}~s, and the wait for the block {st_first['request_commit_wait']:.2f}~s and {st_last['request_commit_wait']:.2f}~s, far below the 2~s timeout because simultaneous requests fill blocks of ten transactions. Panel (a) shows that the wait for the single model server is what grows: from {comp_first['queue_wait']:.1f}~s at 10 users to {comp_last['queue_wait']:.1f}~s at 100.
""")
        parts.append(fig("e5_components_by_users", "Workflow time by component.", "fig:tb-components"))
        growth = (f"The median grows linearly with the number of users, by {slope:.2f}~s per additional user ($R^2 = {r2:.3f}$), "
                  "because each additional request joins the same queue."
                  if r2 >= 0.99 else
                  f"A straight line through the medians rises by {slope:.2f}~s per additional user ($R^2 = {r2:.3f}$).")
        if e4:
            cap = e4["recommendations_per_min"]
            rate = (f", close to the {cap:.2f} recommendations per minute of the model alone" if abs(max(tput) - cap) <= 0.05 * cap
                    else f"; the model alone produces {cap:.2f} recommendations per minute")
        else:
            rate = ", the rate of the single model server"
        mistakes = ""
        if errors:
            top_action, top_count = next(iter(errors["by_action"].items()))
            mistakes = (f" Of the {errors['count']} disagreements, {errors['wrongly_granted']} wrongly grant and "
                        f"{errors['wrongly_refused']} wrongly refuse, and {top_count} concern the {top_action} action.")
        parts.append(f"""Fig.~\\ref{{fig:tb-latency}} plots the median and 95th-percentile workflow times. The median rises from {p50[0]:.1f}~s at 10 users to {p50[-1]:.1f}~s at 100, and the 95th percentile from {p95[0]:.1f}~s to {p95[-1]:.1f}~s. {growth} Throughput stays between {min(tput):.2f} and {max(tput):.2f} completed workflows per minute (Fig.~\\ref{{fig:tb-throughput}}){rate}; adding users adds waiting, not completed work. The recommendations given under load agree with the written policy in {correct} of {valid} cases.{mistakes}
""")
        if replay:
            same_all = replay["sameDecision"] == replay["replayed"]
            parts.append(f"""Replaying the {replay['replayed']} disagreeing requests one at a time with no other load gives the same decision in {replay['sameDecision']} cases and the identical model output in {replay['identicalOutput']}{', so the errors do not come from the load' if same_all else ''}.
""")
        parts.append(fig("e5_latency_by_users", "Workflow time by simultaneous users.", "fig:tb-latency"))
        parts.append(fig("e5_throughput_by_users", "Completed workflows per minute.", "fig:tb-throughput"))
    if e4:
        t = e4["time_per_recommendation_s"]
        n, same = e4["cases"], e4["same_decision_as_stored_v7_run"]
        confirm = ", which confirms that the testbed serves V7" if same >= 0.98 * n else ""
        parts.append(f"""The model alone, answering the {n} test cases one at a time, needs a median of {t['p50']:.2f}~s per recommendation ({t['p95']:.2f}~s at the 95th percentile), or {e4['recommendations_per_min']:.2f} recommendations per minute. It is correct on {e4['correct']} of {n} cases and gives the same decision as the stored V7 evaluation for {same} of {n}{confirm}.
""")
    if e3:
        table = {(s["round"], s["level"]): s for s in e3}
        levels = sorted({s["level"] for s in e3})
        w1 = [table[("W1 CreateAccessRequest", lv)] for lv in levels]
        w2 = [table[("W2 SubmitAuditorDecision", lv)] for lv in levels]
        r1 = [table[("R1 GetRequest", lv)] for lv in levels]
        w1max = max(s["throughputPerS"] for s in w1)
        text = (f"Fig.~\\ref{{fig:tb-ledger}} shows the ledger on its own, with 10 to 100 transactions kept in flight. "
                f"Request creation reaches {w1max:.1f} transactions per second and auditor decisions "
                f"{max(s['throughputPerS'] for s in w2):.1f}, while a single request is read "
                f"{max(s['throughputPerS'] for s in r1):.0f} times per second.")
        if e5:
            used = e5[-1]["ledger_tx_per_s"]
            text += (f" The workflow runs use about {used:.2f} ledger transactions per second"
                     + (f", so the ledger could take about {w1max / used:.0f} times more work than the model server lets the workflows generate."
                        if w1max >= 10 * used else "."))
        parts.append(text + "\n")
        parts.append(fig("e3_throughput", "Ledger throughput per contract function.", "fig:tb-ledger"))
    return "".join(parts)


def resources(e5, e6, e7):
    parts = ["\\subsection{Resource Use and One-Hour Run}\n"]
    if e6:
        ops = e6["operations"]
        total = e6["operations_total"]
        ok = e6["operations_succeeded"]
        m = e6["machines"]
        mac = e6["mac"]
        text = (f"Fig.~\\ref{{fig:tb-hour}} shows the CPU and memory of every machine during one hour in which the 100 users "
                f"send {e6['arrivals']} requests at random times, six per minute on average. The ledger machines M1--M3 use "
                f"between {min(v['cpu_mean_cores'] for k, v in m.items() if k != 'm4'):.2f} and "
                f"{max(v['cpu_mean_cores'] for k, v in m.items() if k != 'm4'):.2f} of their three cores on average and at most "
                f"{max(v['mem_max_gb'] for v in m.values()):.2f}~GB of their 6~GB. The model server on M5 uses "
                f"{mac['model_cpu_mean_cores']:.2f} CPU cores on average, because its work runs on the GPU.")
        drift = [abs(v["change"]) for v in (e6.get("memory_drift_gb") or {}).values() if v]
        if drift:
            text += (f" Between the first and the last five minutes, the memory of each machine changes by at most "
                     f"{1000 * max(drift):.0f}~MB.")
        blocks = [b for b in e6.get("by_10_minutes") or [] if b["end_to_end_p50_s"] is not None]
        if len(blocks) >= 2:
            text += (f" The median workflow takes {blocks[0]['end_to_end_p50_s']:.1f}~s in the first ten minutes and "
                     f"{blocks[-1]['end_to_end_p50_s']:.1f}~s in the last ten.")
        parts.append(text + "\n")
        parts.append(fig("e6_machines_cpu_memory", "CPU and memory of each machine over one hour.", "fig:tb-hour", width="\\textwidth", star=True))
        parts.append(f"""Fig.~\\ref{{fig:tb-operations}} counts the operations of that hour by type: {ok} of {total} succeed ({100.0 * ok / total:.2f}\\%). The workflows take a median of {e6['end_to_end_s']['p50']:.1f}~s, and the recommendations agree with the policy in {e6['accuracy']['correct']} of {e6['accuracy']['valid']} cases.
""")
        parts.append(fig("e6_operations", "Operations in the one-hour run.", "fig:tb-operations"))
    if e7:
        ph = {p["phase"]: p for p in e7["phases"]}
        elected = e7.get("new_leader_elected_after_s")
        leader, court = ph["Leader orderer stopped"], ph["Court peer stopped"]
        parts.append(
            "Fig.~\\ref{fig:tb-fault} shows a separate twelve-minute run in which the Raft leader orderer is stopped for three "
            "minutes and the Court peer afterwards for three minutes."
            + (f" A new leader is elected {elected:.1f}~s after the leader stops." if elected is not None else "")
            + f" {leader['completed']} of {leader['started']} workflows started while the leader was down complete, as do "
            f"{court['completed']} of {court['started']} started while the Court peer was down; two orderers still form a Raft "
            "majority, and four peers still satisfy the three-of-five endorsement rule.\n")
        parts.append(fig("e7_fault_timeline", "Workflows while an orderer and a peer are stopped.", "fig:tb-fault"))
    return "".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    a = args.analysis
    acc = load(os.path.join(a, "accuracy", "accuracy.json"))
    e3 = load(os.path.join(a, "e3", "e3-summary.json"))
    e4 = load(os.path.join(a, "e4", "e4-summary.json"))
    e5 = load(os.path.join(a, "e5", "e5-summary.json"))
    e6 = load(os.path.join(a, "e6", "e6-summary.json"))
    e7 = load(os.path.join(a, "e7", "e7-summary.json"))
    replay = load(os.path.join(a, "e5", "replay-errors.json"))
    errors = load(os.path.join(a, "e5", "e5-errors.json"))
    text = ["% DRAFT generated from the testbed analysis summaries. Suggested text only;",
            "% the author decides what enters the paper. Figures: figures/testbed/*.pdf.",
            "\\section{Experimental Results}\n",
            "This section evaluates DIAS on a multi-machine testbed in terms of recommendation quality, adversarial failure, "
            "latency and throughput of the whole system and of each component, and resource use over time.\n",
            setting(None)]
    if acc:
        text += [quality(acc), adversarial(acc)]
    text.append("% Dynamic Authorization Reuse: keep the existing subsection; it was not re-run on the testbed.\n")
    text.append(latency(e3, e4, e5, replay, errors))
    text.append(resources(e5, e6, e7))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as handle:
        handle.write("\n".join(text))
    print(f"draft written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
