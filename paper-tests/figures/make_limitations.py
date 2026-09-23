"""Generate LIMITATIONS.md and the listener-recovery table.

The listener availability finding gets explicit treatment rather than a footnote,
and both sides of it are stated: the system failed safely, and it did not stay
available. Neither half is allowed to stand without the other.
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from style import RESULTS, load, write_table

PAPER = RESULTS / "paper"
FAILURES = RESULTS / "failures"


def load_failure(name):
    path = FAILURES / name
    return json.loads(path.read_text()) if path.exists() else None


def recovery_table(halt, poison):
    """Unsupervised against supervised, side by side."""
    rows = [
        ["Trigger", "a single model inference exceeding the 60 s timeout",
         "a single model inference exceeding the 60 s timeout"],
        ["Listener behaviour", "exits by design without advancing its checkpoint",
         "exits by design without advancing its checkpoint"],
        ["Checkpoint", "not advanced past the unanswered request",
         "not advanced past the unanswered request"],
        ["Committed request", "preserved and retryable", "preserved and retried"],
        ["Restart", "none; manual intervention required",
         "automatic, after a bounded backoff"],
        ["Decisioning after the event", "halted until an operator restarts the service",
         "resumes once the listener is back"],
        ["Unauthorized Allow", "0", "0"],
        ["Protected record released", "0", "0"],
        ["Committed requests lost", "0", "0"],
        ["Observed in", "Experiment 03 stability runs 8 and 9",
         "supervised restart verification, and Experiment 03 final run"],
    ]
    if halt:
        s = halt["stabilityDegradation"]
        rows.insert(6, [
            "Effect on the run",
            f"runs 8 and 9 degraded to {s['run8']['passing']}/{s['run8']['failing']} and "
            f"{s['run9']['passing']}/{s['run9']['failing']} passing/failing, every failure "
            f"being HTTP 202 'the policy model has not answered yet'",
            "the run continues; each restart is recorded and the run is reported as "
            "recovered rather than clean",
        ])
    write_table("table09_listener_recovery",
                ["Property", "Unsupervised prototype deployment", "Supervised deployment"], rows)


def document(halt, poison, exp01, exp02, exp03, exp04):
    L = []
    w = L.append
    w("# Limitations")
    w("")
    w("Generated alongside the results, so the limitations travel with the numbers they")
    w("qualify rather than being written from memory afterwards.")
    w("")

    w("## 1. Listener availability under a model timeout")
    w("")
    w("This is the most consequential limitation found in the evaluation, and it has two")
    w("halves that must be reported together.")
    w("")
    w("**The system failed safely.** A model inference exceeded the 60 s timeout. The")
    w("decision service refused to advance its checkpoint past the committed but")
    w("unanswered request, so the request was preserved and remained retryable. No")
    w("unauthorized Allow was produced, no protected record was released, and no committed")
    w("request was lost. The direction of failure was closed, not open.")
    w("")
    w("**The system did not stay available.** In the unsupervised prototype deployment the")
    w("timeout terminated the AI decision listener, and nothing restarted it. Authorization")
    w("decisioning stopped until the service was restarted by hand. Every subsequent")
    w("request received HTTP 202, indicating that the request was recorded on the ledger")
    w("but had not been answered.")
    if halt:
        s = halt["stabilityDegradation"]
        w("")
        w(f"The degradation is visible in the stability series: {s['cleanRunsBeforeHalt']} runs")
        w(f"were clean at {s['assertionsPerCleanRun']} assertions each, then run 8 fell to")
        w(f"{s['run8']['passing']} passing / {s['run8']['failing']} failing and run 9 to")
        w(f"{s['run9']['passing']} passing / {s['run9']['failing']} failing. Endorsement payload")
        w("mismatches were zero throughout, so the ledger itself was healthy; nothing was")
        w("answering.")
    w("")
    w("**The supervisor is deployment configuration, not part of the frozen")
    w("implementation.** The measured system, `paper-freeze-v1`, contains no supervisor. The")
    w("supervised behaviour reported alongside this finding was obtained by adding an")
    w("external restart wrapper that runs the same unmodified listener command and changes")
    w("no application behaviour. Results obtained under supervision must not be read as")
    w("properties of the frozen implementation on its own.")
    w("")

    if poison:
        w("## 2. An undecidable request blocks the queue behind it")
        w("")
        w("A second, distinct availability limitation appeared while restoring the")
        w("environment. A request raised by the integration suite was left unanswered when a")
        w("run was aborted, and the suite's teardown then changed the record it targeted. The")
        w("chaincode correctly refused to accept a decision for a request whose trusted")
        w("access context had changed since the request was committed; that refusal is a")
        w("security control working exactly as intended. The listener correctly refused to")
        w("advance past an unanswered request. The supervisor correctly restarted the")
        w(f"listener each time it exited. Every component behaved as designed, and together")
        w(f"they formed a loop that could not clear itself: {poison['observedRestarts']} restarts")
        w("occurred without progress.")
        w("")
        w("The checkpoint discipline has no escape for a request that can never be decided. A")
        w("supervisor restores the listener but cannot clear such a request, so decisioning")
        w("stays blocked until an operator intervenes. The trigger here was integration-test")
        w("teardown, which would not arise in production, but the underlying gap is general.")
        w("The evaluation resolved it by advancing the checkpoint past the affected blocks,")
        w("which is recorded rather than performed silently.")
        w("")
        w("Stated for the paper: although retaining the checkpoint prevents an unanswered")
        w("request from being silently skipped, an authorization request whose trusted context")
        w("has irreversibly changed can block subsequent listener progress. The evaluated")
        w("prototype therefore requires operator intervention for such poison-pill requests.")
        w("Automated dead-letter handling, or a governed terminal-resolution transaction that")
        w("closes an undecidable request on the ledger without granting anything, is left for")
        w("future work.")
        w("")

    n = 3 if poison else 2
    w(f"## {n}. What the accuracy figures do and do not establish")
    w("")
    if exp01:
        v6 = next(a for a in exp01["summary"]["arms"] if a["label"] == "V6 grounded")
        m6 = next(r["metrics"] for r in exp01["runs"] if r["label"] == "V6 grounded")
        allow = m6["perClass"]["allow"]
        w(f"The absence of false Allows is an observation on {v6['nonAllowGroundTruth']} non-Allow")
        w("cases in one retained held-out split, at one model version and one policy version.")
        w("It is not a guarantee about unseen requests, and it is not free: on the same split")
        w(f"the model proposed Allow for only {allow['tp']} of {allow['support']} cases whose")
        w(f"ground truth was Allow, an Allow recall of {allow['recall']:.2f}. The model is")
        w("markedly conservative, and the two facts belong in the same sentence.")
        w("")
    w("The subject-context ablation is an ablation of the **authenticated subject context**")
    w("only. Resource and request context are present in both arms. On that evaluated set")
    w("neither arm ever proposes Allow, so the ablation supports no claim about Allow")
    w("recall in either direction, and its Deny-dominated composition makes decision")
    w("accuracy a weak discriminator. The effect it does establish is on the reason code.")
    w("")
    w("No non-fine-tuned baseline exists on the held-out split, and no short-prompt run of")
    w("the deployed adapter was retained, so prompt grounding is measured only at the")
    w("earlier adapter version and the comparison there is not statistically significant.")
    w("")

    n += 1
    w(f"## {n}. What the attestation establishes")
    w("")
    w("The Ed25519 attestation establishes provenance, integrity and attribution for the")
    w("information it covers. It is not a proof of neural inference: nothing in the system")
    w("verifies that the model computed what it claims to have computed, and Fabric peers")
    w("do not re-execute the model. The attestation does not cover the requester identity;")
    w("requester binding is enforced separately by the chaincode. Evidence is therefore")
    w("tamper-evident, not tamper-proof.")
    w("")

    n += 1
    w(f"## {n}. Scope of the performance figures")
    w("")
    w("The ledger, the API, the decision service and the model server all run on a single")
    w("machine. Concurrency figures therefore measure queueing at one local inference")
    w("server together with the ledger path, and are not Hyperledger Fabric scalability")
    w("figures. The gateway does not expose endorsement separately from ordering and")
    w("commit, so no endorsement latency is reported; that stage is reported as Fabric")
    w("submission and commit together.")
    w("")
    w("The workflow commits two Fabric transactions per authorization, one for the request")
    w("and one for the decision. On the evaluated deployment those two commits together")
    w("exceed the model inference they surround, so the dominant latency contributor is the")
    w("ledger rather than the model. That balance is a property of this configuration — a")
    w("single host, a local inference server, and this ordering service's block-cutting")
    w("interval — and would shift with any of them.")
    if exp04:
        w("")
        w("A single inference exceeding 60 s was observed during the evaluation, against a")
        w("median of a few seconds. Mean inference latency alone would misrepresent this")
        w("distribution, so the tail is reported explicitly.")
    w("")

    n += 1
    w(f"## {n}. Evaluation scale")
    w("")
    w("The safety and explanation checks in Experiment 02 are constructed cases, small in")
    w("number and chosen to exercise specific validator paths. They establish that the")
    w("validator behaved correctly on those constructed cases. They do not estimate a rate")
    w("of validator failure on natural traffic, and no such estimate is claimed.")
    w("")

    PAPER.mkdir(parents=True, exist_ok=True)
    (PAPER / "LIMITATIONS.md").write_text("\n".join(L) + "\n")
    print("  wrote paper/LIMITATIONS.md")


def main():
    halt = load_failure("exp03-failure-summary.json")
    poison = load_failure("exp03-poison-pill-request.json")
    document(halt, poison, load("01-model-context.json"), load("02-safety-xai.json"),
             load("03-security-e2e-reliability.json"), load("04-performance.json"))
    recovery_table(halt, poison)


if __name__ == "__main__":
    main()
