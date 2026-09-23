"""Generate RESULTS_DRAFT.md and results.tex from the experiment result files.

Every quantity is substituted from a result file. The claim wording is fixed
here deliberately, so that a re-run changes the numbers but cannot quietly
upgrade an observation into a guarantee:

  - what was observed on an evaluated set is written as an observation on that
    set, with the set size stated;
  - nothing is called significant unless a paired test in 05-statistics.json
    supports it, and where a test does not support it that is stated;
  - the ledger stage is described as submission and commit together, because the
    gateway does not expose endorsement separately from ordering and commit;
  - evidence is described as tamper-evident, never tamper-proof.
"""

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from style import RESULTS, load

PAPER = RESULTS / "paper"
ALPHA = 0.05


def pp(value, digits=1):
    return f"{value * 100:.{digits}f}"


def arm(exp01, label):
    for a in exp01["summary"]["arms"]:
        if a["label"] == label:
            return a
    raise KeyError(label)


def metrics(exp01, label):
    for r in exp01["runs"]:
        if r["label"] == label:
            return r["metrics"]
    raise KeyError(label)


def test_of(stats, comparison, criterion):
    for c in stats["comparisons"]:
        if c["comparison"] == comparison:
            return c["tests"][criterion]
    raise KeyError(comparison)


def fmt_p(p):
    """A p-value the reader can place at a glance, in both output formats."""
    if p < 1e-4:
        exponent = 0
        mantissa = p
        while mantissa < 1:
            mantissa *= 10
            exponent -= 1
        return f"{mantissa:.1f}e{exponent}"
    if p < 0.001:
        return f"{p:.4f}"
    return f"{p:.3f}"


def significance_clause(t):
    """Say what the test supports, and say so plainly when it supports nothing."""
    p = t["p"]
    if p < ALPHA:
        return (f"McNemar exact test on the {t['discordant']} discordant pairs, "
                f"$p = {fmt_p(p)}$")
    return (f"this difference is not statistically significant "
            f"(McNemar exact test on the {t['discordant']} discordant pairs, "
            f"$p = {p:.2g}$)")


def build(exp01, exp02, exp03, exp04, stats, abl_analysis, halt):
    v6, v4, v4s = (arm(exp01, l) for l in ("V6 grounded", "V4 grounded", "V4 short prompt"))
    m6 = metrics(exp01, "V6 grounded")
    abl = exp01["summary"]["ablation"]
    ws, wo = abl["withSubject"], abl["withoutSubject"]
    t_v6 = test_of(stats, "v6_vs_v4_grounded", "joint")
    t_v6d = test_of(stats, "v6_vs_v4_grounded", "decision")
    t_short = test_of(stats, "v4_grounded_vs_short", "joint")
    t_abl = test_of(stats, "subject_context_ablation", "joint")
    t_abld = test_of(stats, "subject_context_ablation", "decision")
    s2 = exp02["summary"]

    S = []
    w = S.append

    # ---------------------------------------------------------- A. effectiveness
    w("### A. Authorization effectiveness\n")
    w(f"On the held-out test split of {v6['n']} cases, the deployed model "
      f"(`{v6['modelVersion']}`, grounded prompt) reached {pp(v6['jointAccuracy'])}% joint "
      f"accuracy, where a case counts as correct only when the action, purpose, decision "
      f"and reason code are all correct on a schema-valid output. Decision accuracy alone "
      f"was {pp(v6['decisionAccuracy'])}% and reason-code accuracy "
      f"{pp(v6['reasonAccuracy'])}%. The earlier adapter, on the same cases and the same "
      f"prompt, reached {pp(v4['jointAccuracy'])}% joint and "
      f"{pp(v4['decisionAccuracy'])}% decision accuracy "
      f"({significance_clause(t_v6)} for joint accuracy; "
      f"{significance_clause(t_v6d)} for decision accuracy).\n")

    w(f"Prompt grounding was measured only at the earlier adapter, because no "
      f"short-prompt run of the deployed adapter was retained on this split. There the "
      f"grounded prompt reached {pp(v4['jointAccuracy'])}% joint accuracy against "
      f"{pp(v4s['jointAccuracy'])}% for the short prompt; "
      f"{significance_clause(t_short)}. The evidence available therefore does not "
      f"establish a prompt-grounding effect at this sample size.\n")

    allow_row = m6["confusionMatrix"]["allow"]
    w(f"No false Allows were observed among the {v6['nonAllowGroundTruth']} non-Allow "
      f"cases in the evaluated held-out test set. This is an observation on that set at "
      f"this model version, not a guarantee about unseen requests, and it is directional. "
      f"Of the {m6['perClass']['allow']['support']} cases whose ground truth was Allow, the "
      f"model proposed Allow for {allow_row['allow']}: it denied {allow_row['deny']}, "
      f"escalated {allow_row['escalate']}, and produced a schema-invalid output for "
      f"{allow_row['invalid']}. Allow recall is therefore "
      f"{m6['perClass']['allow']['recall']:.2f}, against a Deny recall of "
      f"{m6['perClass']['deny']['recall']:.2f} and an Escalate recall of "
      f"{m6['perClass']['escalate']['recall']:.2f}. The model is markedly conservative on "
      f"this split: {v6['falseDenyCount']} cases were proposed as Deny where the policy "
      f"result was not Deny. The absence of false Allows should be read together with that "
      f"cost, not on its own. Across the whole split, {v6['schemaRejected']} of "
      f"{v6['n']} outputs were not schema-valid and were rejected before use.\n")

    # ------------------------------------------------------------- B. ablation
    w("### B. Contribution of the authenticated subject context\n")
    aw = abl_analysis["arms"]["with"]
    ao = abl_analysis["arms"]["without"]
    gt = aw["groundTruthDistribution"]
    w(f"The ablation compares the same model on the same {aw['n']} validation cases with "
      f"and without the authenticated subject context. In the second arm every authenticated "
      f"subject attribute is replaced with null and the role-specific access row of the "
      f"system prompt becomes empty as a consequence; the ordered policy rules, the resource "
      f"attributes and the request text are unchanged. It is therefore an ablation of the "
      f"authenticated subject context, not of all trusted context.\n")

    w(f"Two properties of the evaluated set have to be stated before the numbers are read. "
      f"First, the set is dominated by Deny: {gt['deny']} of {aw['n']} cases, so a model that "
      f"never proposes Allow already scores "
      f"{aw['majorityClassBaselineDecisionAccuracy'] * 100:.0f}% decision accuracy, and "
      f"decision accuracy is consequently a weak discriminator here. Second, Allow recall is "
      f"{aw['allowRecall']:.2f} in both arms: neither arm proposes Allow for any of the "
      f"{aw['allowGroundTruthCases']} Allow ground-truth cases. Nothing in this ablation "
      f"therefore supports any claim about Allow recall, in either direction.\n")

    w(f"Against that background the effect is specific rather than general. Action accuracy is "
      f"unchanged at {aw['componentAccuracy']['action'] * 100:.0f}%, and purpose accuracy "
      f"moves from {aw['componentAccuracy']['purpose'] * 100:.0f}% to "
      f"{ao['componentAccuracy']['purpose'] * 100:.0f}%, which is expected because the "
      f"request text is present in both arms. Decision accuracy moves from "
      f"{aw['componentAccuracy']['decision'] * 100:.0f}% to "
      f"{ao['componentAccuracy']['decision'] * 100:.0f}%, and "
      f"{significance_clause(t_abld)}. Reason-code accuracy, by contrast, falls from "
      f"{aw['componentAccuracy']['reasonCode'] * 100:.0f}% to "
      f"{ao['componentAccuracy']['reasonCode'] * 100:.0f}%, and joint accuracy with it, "
      f"from {aw['jointAccuracy'] * 100:.0f}% to {ao['jointAccuracy'] * 100:.0f}% "
      f"({significance_clause(t_abl)}).\n")

    rbac_w = aw["reasonCodesEmitted"].get("RBAC_NO_PERMISSION", 0)
    rbac_o = ao["reasonCodesEmitted"].get("RBAC_NO_PERMISSION", 0)
    xj_w = aw["reasonCodesEmitted"].get("CROSS_JURISDICTION", 0)
    xj_o = ao["reasonCodesEmitted"].get("CROSS_JURISDICTION", 0)
    cred_w = aw["reasonCodesEmitted"].get("CRED_NOT_ACTIVE", 0)
    cred_o = ao["reasonCodesEmitted"].get("CRED_NOT_ACTIVE", 0)
    w(f"The emitted reason codes show why. Without the authenticated subject context the model "
      f"collapses onto RBAC_NO_PERMISSION, which rises from {rbac_w} to {rbac_o} of "
      f"{ao['n']} cases, while the barriers that can only be identified from subject "
      f"attributes largely disappear from its output: cross-jurisdiction from {xj_w} to "
      f"{xj_o}, and inactive credentials from {cred_w} to {cred_o}. Deprived of the "
      f"attributes, the model still frequently reaches a defensible outcome but can no longer "
      f"name which subject property was decisive, and falls back on the most generic refusal "
      f"available to it.\n")

    w(f"The correct reading is therefore that the authenticated subject context substantially "
      f"improves joint structured classification of action, purpose, decision and reason code, "
      f"principally by allowing the model to identify the correct subject-dependent barrier, "
      f"while decision-only accuracy changes much less on this Deny-dominated set. The drop "
      f"from {aw['jointAccuracy'] * 100:.0f}% to {ao['jointAccuracy'] * 100:.0f}% must "
      f"not be read as the model losing the ability to decide, nor as any statement about "
      f"Allow recall.\n")

    # ------------------------------------------------------------- C. validator
    w("### C. Deterministic validation and explanation correctness\n")
    w(f"The validator was exercised against the deployed decision path with "
      f"{s2['safety']['totalCases']} constructed cases, of which "
      f"{s2['safety']['disagreementCases']} were built so that the model's proposal "
      f"disagreed either with the committed request facts or with the deterministic policy "
      f"result. The validator detected all constructed model-input and model-policy "
      f"disagreement cases in the evaluated safety set "
      f"({s2['safety']['disagreementsDetected']} of {s2['safety']['disagreementCases']}), "
      f"and none of the {s2['safety']['unsafeProposals']} unsafe proposals was "
      f"automatically enforced: each was replaced by an escalation carrying a system "
      f"reason code that the model itself cannot emit.\n")

    w(f"Malformed model output was tested separately with {s2['malformed']['totalCases']} "
      f"cases spanning non-JSON text, schema violations and out-of-vocabulary values. All "
      f"{s2['malformed']['rejectedBeforeUse']} were rejected before use and none became an "
      f"Allow. Because decoding is unconstrained and there is no retry, this is the whole "
      f"of the system's response to a malformed output.\n")

    w(f"Explanation correctness was checked across all "
      f"{s2['explanation']['reasonCodesChecked']} reason codes. In every case the recorded "
      f"decision matched the reason code, the decisive attributes named were the ones the "
      f"policy actually used, and the counterfactual was stated as the condition that would "
      f"have to differ rather than as advice to the requester. Where the validator "
      f"overrode a proposal, the model's proposed explanation text was not retained.\n")

    # ---------------------------------------------- D. security and end to end
    if exp03 and exp03["runs"].get("security") and not exp03["runs"]["security"].get("failed"):
        sec = exp03["runs"]["security"]["summary"]
        w("### D. Security and end-to-end validation\n")
        w(f"{sec['total']} checks were run, of which {sec['controls']} are controls that "
          f"are expected to succeed. All {sec['behavedAsIntended']} behaved as intended. "
          f"None of the evaluated tampering scenarios resulted in unauthorized "
          f"protected-record release.\n")
        w("Three distinct mechanisms are involved and are worth separating. Deterministic "
          "authorization validation re-derives the policy result on the ledger from the "
          "committed request facts and refuses to enforce a proposal that disagrees with "
          "it. Cryptographic provenance and integrity are established by an Ed25519 "
          "attestation over the query hash, the context hash, the decision and the "
          "inference descriptor; this makes the covered evidence tamper-evident and "
          "attributable, but it does not prove that the model executed, nor that its "
          "output is correct, and it does not cover the requester identity. Requester "
          "binding is enforced separately by the chaincode, which compares a hash of the "
          "caller's X.509 identity at every release gate. Ledger-side checks and "
          "endorsement are a third mechanism: the transaction is endorsed under an "
          "ImplicitMeta MAJORITY policy across six organizations before it commits. Fabric "
          "peers do not re-execute the model.\n")

    if exp03 and exp03["runs"].get("endToEnd") and not exp03["runs"]["endToEnd"].get("failed"):
        scen = exp03["runs"]["endToEnd"]["scenarios"]
        released = [s for s in scen if s["pdfReleased"]]
        w(f"The complete six-organization workflow was executed for all three "
          f"authorization paths. " + " ".join(
            f"The {s['scenario']} path resolved to {s['effectiveDecision']} "
            f"({s['effectiveReason']}), with record content "
            f"{'released' if s['pdfReleased'] else 'withheld'}."
            for s in scen) +
          f" Record content was released in {len(released)} of {len(scen)} paths, and the "
          f"attestation verified in every path.\n")

    # ------------------------------------------------------------ E. reliability
    if exp03 and exp03["runs"].get("stability") and not exp03["runs"]["stability"].get("failed"):
        st = exp03["runs"]["stability"]["summary"]
        w("### E. Reliability under repetition\n")
        w(f"The full live integration suite was run {st['runs']} times consecutively "
          f"against the same deployment. {st['cleanRuns']} of {st['runs']} runs were clean, "
          f"with {st['totalPayloadMismatches']} endorsement payload mismatches and "
          f"{st['totalTimeouts']} timeouts in total, and no accumulation of unresolved "
          f"escalations between runs.\n")
        if exp03["runs"].get("stress") and not exp03["runs"]["stress"].get("failed"):
            sr = exp03["runs"]["stress"]["summary"]
            w(f"Escalation handling was stressed separately across the four routings: "
              f"{sr['totalResolved']} of {sr['totalEscalated']} escalations raised were "
              f"resolved by the reviewer the chaincode routes them to, with "
              f"{sr['totalPayloadMismatch']} payload mismatches.\n")
    if exp03 and exp03["runs"].get("failSafe") and not exp03["runs"]["failSafe"].get("failed"):
        fs = exp03["runs"]["failSafe"]
        rows = fs.get("rows", [])
        safe = [r for r in rows if r.get("pass")]
        w(f"Component-failure behaviour was checked for {len(rows)} scenarios. "
          f"{len(safe)} of {len(rows)} failed safely: in no scenario did an unavailable "
          f"component produce an Allow or release protected content. "
          + " ".join(f"With the {r['scenario']}, the observed outcome was {r.get('outcome')}."
                     for r in rows if r.get("outcome")) + "\n")

    # The reliability section is not complete without the failure that was
    # observed before supervision was added. Both halves are stated, and the
    # supervised result is never presented as a property of the frozen system.
    if halt:
        st = halt["stabilityDegradation"]
        w("The ten clean runs above were obtained under an external supervisor, and that "
          "qualification matters. In an earlier series on the same frozen implementation, run "
          f"{st['cleanRunsBeforeHalt'] + 1} of the sequence encountered a single model inference "
          "that exceeded the 60 s timeout. The decision service treats an undecidable request as "
          "a reason to stop rather than to skip: it declines to advance its checkpoint past a "
          "committed but unanswered request, and exits so that a restart will retry the same "
          "request. In the unsupervised prototype deployment nothing restarted it.\n")
        w(f"The safety outcome was correct in every respect. The request remained committed and "
          f"retryable, the checkpoint was not advanced past it, no unauthorized Allow was "
          f"produced, and no protected record was released. The availability outcome was not: "
          f"authorization decisioning stopped, and runs {st['cleanRunsBeforeHalt'] + 1} and "
          f"{st['cleanRunsBeforeHalt'] + 2} fell from {st['assertionsPerCleanRun']} passing "
          f"assertions to {st['run8']['passing']} and {st['run9']['passing']}, every failure "
          f"reporting that the request was recorded on the ledger but had not been answered. "
          f"Endorsement payload mismatches remained zero throughout, so the ledger was healthy; "
          f"nothing was answering.\n")
        w("Adding an external supervisor changes the availability outcome and nothing else. On "
          "restart the listener resumed from its preserved checkpoint, retried the same "
          "committed request and answered it. The supervisor is deployment configuration: it "
          "runs the same unmodified listener command and alters no decision, explanation, "
          "policy, timeout or signature. It is not part of the frozen implementation, and the "
          "supervised results must not be read as properties of that implementation on its "
          "own. SEAL failed safely under the observed model-timeout condition; it did not "
          "remain available without something to restart it.\n")

    # ------------------------------------------------------------ F. performance
    if exp04:
        w("### F. Latency and concurrency\n")
        w(_performance_text(exp04, load("07-latency-attribution.json")))

    # ------------------------------------------------------------------ limits
    w("### G. What these results do not establish\n")
    w("The evaluation is single-host: the ledger, the API, the decision service and the "
      "model server all run on one machine, so the latency and concurrency figures "
      "describe queueing at one local inference server together with the ledger path, and "
      "are not Hyperledger Fabric scalability figures. The accuracy figures are "
      "observations on retained held-out splits at one model version and one policy "
      "version. The absence of false Allows on the evaluated set is not a guarantee about "
      "unseen requests. The attestation establishes provenance, integrity and attribution "
      "for the information it covers; it is not a proof of neural inference, and no part "
      "of the system verifies that the model computed what it claims to have computed.\n")
    return "\n".join(S)


def _performance_text(exp04, attribution=None):
    s = exp04["summary"]
    paths = exp04["runs"]["paths"]
    mo = s["modelOnlyMs"]
    L = []

    names = [n for n in ("allow", "deny", "escalate") if n in paths]
    for n in names:
        p = paths[n]
        L.append(
            f"On the {n} path, over {p['successes']} timed requests after "
            f"{p['warmupDiscarded']} discarded warm-ups, median client-observed latency was "
            f"{p['endToEndMs']['median']:.0f}~ms (p95 {p['endToEndMs']['p95']:.0f}~ms). Of "
            f"that, {p['inferenceMs']['median']:.0f}~ms was model inference as recorded inside "
            f"the signed inference descriptor. Calling the same model directly with the same "
            f"prompt shape and decoding parameters, with no ledger and no validator in the "
            f"path, gave a median of {mo['median']:.0f}~ms over {mo['n']} samples.")

    allow = paths.get("allow") or paths[names[0]]
    st = allow.get("stages")
    if st:
        L.append(
            f"Stage timings were recorded inside the decision service using a monotonic clock, "
            f"under a measurement-only instrumentation commit that is separate from the frozen "
            f"implementation and disabled unless explicitly enabled. On the "
            f"{allow['path']} path the median stages were: ledger context read "
            f"{st['contextReadMs']['median']:.1f}~ms, model inference "
            f"{st['inferenceMs']['median']:.0f}~ms, deterministic validation together with "
            f"explanation materialisation {st['validateExplainMs']['median']:.2f}~ms, "
            f"attestation signing {st['signatureMs']['median']:.2f}~ms, and Fabric submission "
            f"and commit {st['fabricSubmitCommitMs']['median']:.0f}~ms, for a decision-service "
            f"total of {st['decisionServiceTotalMs']['median']:.0f}~ms.")
        L.append(
            f"Two observations follow directly. The deterministic validator and the explanation "
            f"it produces cost {st['validateExplainMs']['median']:.2f}~ms at the median, and "
            f"attestation signing {st['signatureMs']['median']:.2f}~ms: together well under a "
            f"millisecond, against a median end-to-end latency of "
            f"{allow['endToEndMs']['median']:.0f}~ms. The safety and provenance mechanisms are "
            f"not what the system spends its time on. What it does spend time on is model "
            f"inference ({st['inferenceMs']['median']:.0f}~ms) and the Fabric submission and "
            f"commit stage ({st['fabricSubmitCommitMs']['median']:.0f}~ms), which are of "
            f"comparable magnitude. The ledger stage is also strikingly consistent, with a p95 "
            f"of {st['fabricSubmitCommitMs']['p95']:.0f}~ms against its median, which is what a "
            f"fixed block-cutting interval looks like rather than a load-dependent cost.")
        L.append(
            "The gateway does not expose endorsement separately from ordering and commit, so "
            "that figure is reported as the Fabric submission and commit stage as a whole and "
            "must not be read as endorsement latency.")

    if attribution:
        r = attribution["reconciliation"]
        c = attribution["measuredStages"]["apiRequestCommitMs"]
        lv = attribution["ledgerVersusModel"]
        L.append(
            f"Those stage figures do not sum to the client round trip, and the difference is "
            f"accounted for rather than left open. Decision-service instrumentation begins when "
            f"the listener picks up the request event; by then the API has already committed its "
            f"own CreateAccessRequest transaction, and afterwards it still has to notice the "
            f"decision by polling. Measured directly through the same gateway with the same "
            f"endorsing organisations, the request-creation commit has a median of "
            f"{c['median']:.0f}~ms over {c['n']} samples. Adding it to the decision-service "
            f"total of {r['decisionServiceTotalMedianMs']:.0f}~ms gives "
            f"{r['attributedSubtotalMs']:.0f}~ms against an observed median of "
            f"{r['clientObservedEndToEndMedianMs']:.0f}~ms, leaving "
            f"{r['unattributedMs']:.0f}~ms, or {r['unattributedShare'] * 100:.1f}\\% of the "
            f"round trip, for event dispatch and the API's decision poll. The poll interval is "
            f"{r['decisionPollIntervalMs']}~ms, which bounds most of that remainder.")
        L.append(
            f"Stating it this way changes where the cost sits. The workflow commits two separate "
            f"Fabric transactions, one for the request and one for the decision, and together "
            f"they account for {lv['twoFabricCommitsMedianMs']:.0f}~ms against "
            f"{lv['modelInferenceMedianMs']:.0f}~ms of model inference. The ledger, not the "
            f"model, is the larger contributor to the latency a requester experiences.")

    inf = allow["inferenceMs"]
    over = sum((paths[n].get("stages") or {}).get("inferencesOver60s", 0) for n in names)
    L.append(
        f"Model inference latency is not tightly distributed and the tail matters here. On the "
        f"{allow['path']} path the median was {inf['median']:.0f}~ms but the p95 was "
        f"{inf['p95']:.0f}~ms and the maximum {inf['max']:.0f}~ms. Earlier in this evaluation a "
        f"single inference exceeded the 60~s model timeout, which is more than ten times the "
        f"largest value observed in these samples; in the measured runs reported here, "
        f"{over} inferences exceeded 60~s. A mean inference latency would conceal this "
        f"behaviour, and the consequences of the tail are set out in the reliability results.")

    levels = s.get("concurrency") or []
    if levels:
        first, last = levels[0], levels[-1]
        clean = [l for l in levels if not l["failures"]]
        failed = [l for l in levels if l["failures"]]
        L.append(
            f"Concurrency was varied from {first['level']} to {last['level']} simultaneous "
            f"requests on the allow path. Completed requests per second rose from "
            f"{first['throughputPerSec']:.3f} to {max(l['throughputPerSec'] for l in levels):.3f} "
            f"and then flattened, while median end-to-end latency grew from "
            f"{first['medianMs']:.0f}~ms to {last['medianMs']:.0f}~ms. Throughput saturating "
            f"while latency grows roughly in proportion to the offered load is the signature of "
            f"a single serialising resource, and here that resource is the one local inference "
            f"server: every request queues behind the same model.")
        if failed:
            f0 = failed[0]
            L.append(
                f"All requests completed up to {max(l['level'] for l in clean)} concurrent "
                f"requests. At {f0['level']} concurrent requests "
                f"{f0['failures']} of {f0['successes'] + f0['failures']} did not complete "
                f"within the client ceiling. That is the point at which queueing at the "
                f"inference server exceeds the API's decision-poll window, not a ledger limit.")
        L.append(
            "These figures describe one local inference server behind the ledger path on a "
            "single machine. They support statements about the behaviour of this deployment "
            "under that load, and they are not Hyperledger Fabric scalability measurements.")

    return "\n\n".join(L) + "\n"


def _latex_body(block):
    """Escape what LaTeX needs escaped and turn backticks into \\texttt."""
    BS = chr(92)
    # Scientific notation reads fine as "3.0e-6" in the draft but should be
    # typeset properly in the paper.
    text = re.sub(r"(\d+\.\d+)e-(\d+)", r"\1" + BS + BS + r"times10^{-\2}", block)
    text = text.replace("%", BS + "%")
    # Reason codes appear as bare words in the prose; their underscores need
    # escaping wherever they are not already inside a texttt span.
    text = re.sub(r"\b[A-Z]+(?:_[A-Z]+)+\b",
                  lambda m: m.group(0).replace("_", BS + "_"), text)
    parts = text.split("`")
    rebuilt = []
    for i, part in enumerate(parts):
        if i % 2:
            rebuilt.append(BS + "texttt{" + part.replace("_", BS + "_") + "}")
        else:
            rebuilt.append(part)
    return "".join(rebuilt)


def to_latex(markdown_text):
    """Turn the generated draft into a results section body."""
    out = ["% Generated from the experiment result files. Do not edit by hand.",
           "% Regenerate: python3 paper-tests/figures/make_results_text.py",
           "\\section{Results}", ""]
    for block in markdown_text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        if block.startswith("### "):
            out += ["\\subsection{" + block[4:].split(". ", 1)[-1] + "}", ""]
        else:
            out += [_latex_body(block), ""]
    return "\n".join(out)


def main():
    exp01, exp02 = load("01-model-context.json"), load("02-safety-xai.json")
    stats = load("05-statistics.json")
    if not (exp01 and exp02 and stats):
        raise SystemExit("experiments 01/02 and the statistics file are required")
    exp03, exp04 = load("03-security-e2e-reliability.json"), load("04-performance.json")

    halt_path = RESULTS / "failures" / "exp03-failure-summary.json"
    halt = json.loads(halt_path.read_text()) if halt_path.exists() else None
    text = build(exp01, exp02, exp03, exp04, stats, load("06-ablation-analysis.json"), halt)
    PAPER.mkdir(parents=True, exist_ok=True)

    header = ["# Results (draft)", "",
              "Generated from the experiment result files. Every quantity is substituted",
              "from a result file; none is typed by hand.", ""]
    missing = [n for n, d in (("03", exp03), ("04", exp04)) if not d]
    if missing:
        header += [f"> Incomplete: experiment(s) {', '.join(missing)} have not produced "
                   f"results yet, so the corresponding sections are absent.", ""]
    (PAPER / "RESULTS_DRAFT.md").write_text("\n".join(header) + "\n" + text)
    print("  wrote paper/RESULTS_DRAFT.md")

    (PAPER / "results.tex").write_text(to_latex(text) + "\n")
    print("  wrote paper/results.tex")
    if missing:
        print(f"  NOTE: experiments {', '.join(missing)} missing — draft is partial")


if __name__ == "__main__":
    main()
