"""Generate EXPERIMENTAL_SETUP.md and FIGURE_TABLE_MAP.md from the result files.

The setup document is generated rather than written by hand so that it always
describes the configuration that actually produced the numbers. If a run is
repeated under a different configuration, this file changes with it.
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from style import RESULTS, FIGURES, TABLES, load

PAPER = RESULTS / "paper"

# What each artefact is evidence for. The wording here is the claim the artefact
# can support, deliberately no stronger.
ARTEFACTS = [
    ("fig01_model_effectiveness", "01-model-context.json",
     "Joint, decision and reason-code accuracy for the three retained arms on the "
     "held-out split, with both error directions shown side by side."),
    ("fig02_subject_context_ablation", "01-model-context.json",
     "Accuracy with and without the authenticated subject context on the same 100 "
     "validation cases, and the per-criterion difference."),
    ("fig03_v6_confusion_matrix", "01-model-context.json",
     "Where the model's proposals land against ground truth, with and without the "
     "authenticated subject context."),
    ("fig04_validator_safety", "02-safety-xai.json",
     "Outcome of the constructed disagreement, malformed-output and explanation "
     "checks against the deployed validator."),
    ("fig05_e2e_workflow", "03-security-e2e-reliability.json",
     "The Allow, Deny and Escalate paths executed end to end across the six "
     "organizations, with what was released in each."),
    ("fig06_security_tamper", "03-security-e2e-reliability.json",
     "Outcome of each constructed tampering and unauthorized-access attempt."),
    ("fig07_reliability", "03-security-e2e-reliability.json",
     "Repeat behaviour across consecutive live integration suites and the "
     "escalation stress repetitions."),
    ("fig08_latency_decomposition", "04-performance.json",
     "Observed inference time, end-to-end round trip and the single remaining "
     "figure that upper-bounds everything SEAL adds."),
    ("fig09_concurrency", "04-performance.json",
     "End-to-end latency and completed requests per second as concurrency rises."),
    ("fig10_latency_distribution", "04-performance.json",
     "Distribution of end-to-end latency per authorization path."),
]

TABLE_ARTEFACTS = [
    ("table01_model_metrics", "01-model-context.json",
     "Full per-arm metrics, including the exact accuracies quoted in the text."),
    ("table02_context_ablation", "06-ablation-analysis.json",
     "Subject-context ablation per criterion, with Allow recall and the always-Deny "
     "baseline stated so the joint-accuracy drop cannot be misread."),
    ("table03_safety_xai", "02-safety-xai.json",
     "Validator safety and explanation-correctness checks, with the constructed "
     "case counts each observation rests on."),
    ("table04_v6_per_class", "01-model-context.json",
     "Per-class precision, recall and F1 for the deployed model, so the zero "
     "false-Allow observation is read next to the Allow recall that accompanies it."),
    ("table05_paired_tests", "05-statistics.json",
     "Paired McNemar tests and Wilson intervals for every arm comparison."),
    ("table06a_security_attacks", "03-security-e2e-reliability.json",
     "Every constructed tampering attempt and control, with whether it behaved as "
     "intended and whether anything was released."),
    ("table06b_end_to_end", "03-security-e2e-reliability.json",
     "Per-workflow end-to-end outcomes: committed facts, model proposal, both "
     "agreement checks, reviewer, ledger commit, release and attestation."),
    ("table06c_stability_runs", "03-security-e2e-reliability.json",
     "Per-run detail for the consecutive integration suites, including listener "
     "restarts and model timeouts, so a recovered run is distinguishable from a clean one."),
    ("table06d_escalation_stress", "03-security-e2e-reliability.json",
     "Escalation stress per routing: attempted, escalated, resolved and failed."),
    ("table06e_fail_safe", "03-security-e2e-reliability.json",
     "Behaviour under each injected component failure, with the authorization "
     "state and the recovery mechanism."),
    ("table07_performance", "04-performance.json",
     "Latency per measured decision stage and per authorization path, with "
     "n, mean, standard deviation, p50, p95, min and max."),
    ("table08_ablation_reason_codes", "06-ablation-analysis.json",
     "Reason codes emitted by each ablation arm — the mechanism behind the "
     "joint-accuracy drop."),
    ("table09_listener_recovery", "failures/exp03-failure-summary.json",
     "Unsupervised against supervised listener behaviour under a model timeout, "
     "side by side."),
    ("table10_concurrency", "04-performance.json",
     "Per concurrency level: attempted, completed, failures, throughput, latency "
     "quantiles, timeouts and listener restarts."),
]


def md_table(header, rows):
    out = ["| " + " | ".join(header) + " |",
           "|" + "|".join(["---"] * len(header)) + "|"]
    for row in rows:
        out.append("| " + " | ".join("" if c is None else str(c) for c in row) + " |")
    return "\n".join(out)


def setup_document():
    sources = [(name, load(name)) for name in
               ("01-model-context.json", "02-safety-xai.json",
                "03-security-e2e-reliability.json", "04-performance.json")]
    present = [(n, d) for n, d in sources if d]
    if not present:
        raise SystemExit("no result files found")
    meta = present[0][1]["metadata"]
    hw = meta["hardware"]

    lines = [
        "# Experimental setup",
        "",
        "Generated from the result files, so it describes the configuration that",
        "produced the reported numbers rather than an intended configuration.",
        "",
        "## Frozen system under measurement",
        "",
        md_table(["Item", "Value"], [
            ["Implementation baseline", f"`{meta.get('frozenBaseline', meta.get('frozenCommit'))}`"
                                        f" (tag `{meta.get('frozenBaselineTag', meta.get('tag'))}`)"],
            ["Measurement harness commit", f"`{meta.get('harnessCommit', meta.get('frozenCommit'))}`"],
            ["Organizations", meta["organizations"]],
            ["Chaincode", f"`{meta['chaincode']}` v{meta['chaincodeVersion']}"],
            ["Chaincode package hash", f"`{meta['chaincodePackageHash']}`"],
            ["Endorsement policy", meta["endorsement"]],
            ["Authorization model", f"`{meta['model']}`"],
            ["LoRA adapter SHA-256", f"`{meta['adapterHash']}`"],
            ["Policy version", f"`{meta['policyVersion']}`"],
        ]),
        "",
        "## Hardware and runtime",
        "",
        md_table(["Item", "Value"], [
            ["CPU", hw["cpu"]], ["Cores", hw["cores"]], ["Memory", f"{hw['ramGB']} GB unified"],
            ["GPU", hw["gpu"]], ["Operating system", f"{hw['platform']} (macOS {hw['osVersion']})"],
            ["Node.js", hw["node"]], ["Model runtime", hw["modelRuntime"]],
        ]),
        "",
        "All services, the ledger and the model server run on this single machine.",
        "Latency and concurrency figures therefore describe a single-host deployment",
        "with one local inference server, not a distributed deployment.",
        "",
        "## Decoding parameters",
        "",
        "Temperature 0, top-p 1, at most 192 new tokens. There is no constrained",
        "decoding and no retry: a malformed or non-conforming model output is handled",
        "by the validator rather than regenerated.",
        "",
        "## Datasets",
        "",
    ]

    exp01 = load("01-model-context.json")
    if exp01:
        rows = []
        for run in exp01["runs"]:
            cfg = run["config"]
            rows.append([run["label"], run["split"], cfg["dataset"],
                         f"`{cfg['datasetSha256'][:16]}…`", run["metrics"]["n"]])
        lines += [md_table(["Arm", "Split", "Dataset file", "Dataset SHA-256", "Cases"], rows), ""]
        lines += [
            "The joint criterion is a schema-valid output whose action, purpose,",
            "decision and reason code all match the expected case. Reported gaps in the",
            "retained runs:", ""]
        lines += [f"- {gap}" for gap in exp01["summary"]["gaps"]] + [""]

    # Experiments were run at different harness commits as the harness was fixed.
    # The implementation under measurement is the same in every row; only the
    # measurement code differs, so both are recorded per experiment.
    prov_rows = []
    for name, doc in present:
        m = doc["metadata"]
        prov_rows.append([
            f"`{name}`", m.get("timestamp", "--"),
            f"`{(m.get('frozenBaseline') or m.get('frozenCommit'))[:12]}`",
            f"`{(m.get('harnessCommit') or m.get('frozenCommit'))[:12]}`",
            "yes" if m.get("dirty") else "no",
        ])
    lines += ["## Provenance per experiment", "",
              md_table(["Result file", "Run at (UTC)", "Implementation baseline",
                        "Harness commit", "Uncommitted paths present"], prov_rows),
              "",
              "The implementation baseline is identical across every row. The harness",
              "commit differs where the measurement code was corrected between runs; those",
              "corrections touch only `paper-tests/`, never the measured system.",
              ""]

    lines += ["## Experiments", "",
              md_table(["Experiment", "Question", "Result file"], [
                  ["01", "Model effectiveness and the contribution of authenticated "
                         "subject context", "`01-model-context.json`"],
                  ["02", "Validator safety and explanation correctness", "`02-safety-xai.json`"],
                  ["03", "Security, end-to-end workflows and reliability",
                   "`03-security-e2e-reliability.json`"],
                  ["04", "Latency decomposition and concurrency", "`04-performance.json`"],
                  ["--", "Paired statistical tests over the Experiment 01 arms",
                   "`05-statistics.json`"],
              ]), ""]

    lines += ["## Scope limits carried with the numbers", "",
              "- Experiment 01 reports nothing about the deterministic validator. The",
              "  retained runs replay a guard derived from the model's own action and",
              "  purpose, so every validator claim comes from Experiment 02 instead.",
              "- The ablation compares *with* and *without the authenticated subject",
              "  context*. Resource and request context are present in both arms, so it is",
              "  not an ablation of all trusted context.",
              "- False-Allow counts are observations on a retained held-out split at this",
              "  model version, not guarantees about unseen requests.",
              "- The attestation establishes provenance, integrity and attribution for the",
              "  information it covers. It does not prove the model executed, nor that its",
              "  output is correct, and it does not cover the requester identity; requester",
              "  binding is enforced separately in chaincode.",
              "- Concurrency figures measure queueing at one local inference server plus",
              "  the ledger path. They are not Hyperledger Fabric scalability figures.",
              ""]

    PAPER.mkdir(parents=True, exist_ok=True)
    (PAPER / "EXPERIMENTAL_SETUP.md").write_text("\n".join(lines))
    print("  wrote paper/EXPERIMENTAL_SETUP.md")


def map_document():
    lines = ["# Figure and table map", "",
             "Every artefact below is generated from a result file. No value is typed",
             "by hand, so regenerating after a re-run updates the paper's evidence",
             "without any manual transcription.", "",
             "Regenerate everything with:", "", "```bash",
             "paper-tests/figures/make_all.sh", "```", "",
             "That script chooses an interpreter that actually has numpy, matplotlib and",
             "scipy, because `python3` on the measurement machine can resolve to a build",
             "without them and silently break regeneration.", "",
             "## Figures", ""]

    rows = []
    for stem, source, claim in ARTEFACTS:
        exists = (FIGURES / f"{stem}.pdf").exists()
        rows.append([f"`{stem}`", f"`{source}`",
                     "generated" if exists else "pending source experiment", claim])
    lines += [md_table(["Figure", "Source", "Status", "What it supports"], rows), "",
              "## Tables", ""]

    rows = []
    for stem, source, claim in TABLE_ARTEFACTS:
        exists = (TABLES / f"{stem}.csv").exists()
        rows.append([f"`{stem}`", f"`{source}`",
                     "generated" if exists else "pending source experiment", claim])
    lines += [md_table(["Table", "Source", "Status", "What it supports"], rows), "",
              "Each table is written twice: a `.csv` for inspection and a `.tex`",
              "booktabs body for `\\input` into the paper.", ""]

    PAPER.mkdir(parents=True, exist_ok=True)
    (PAPER / "FIGURE_TABLE_MAP.md").write_text("\n".join(lines))
    print("  wrote paper/FIGURE_TABLE_MAP.md")


if __name__ == "__main__":
    setup_document()
    map_document()
