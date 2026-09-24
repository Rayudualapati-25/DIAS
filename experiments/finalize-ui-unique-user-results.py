#!/usr/bin/env python3
"""Verify, tabulate, and plot the distinct-user latency evidence."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt


ROOT = Path(__file__).resolve().parents[1]
MAIN_RUN = ROOT / "experiments/runs/2026-08-28T04-15-05-267Z_ui_unique_user_latency"
ABLATION_RUN = (
    ROOT / "experiments/runs/2026-08-28T04-18-28-093Z_"
    "ui_unique_user_release_layout_ablation"
)
PROVISION_RUN = (
    ROOT / "experiments/runs/2026-08-28T04-07-11-290Z_"
    "ui_unique_user_provisioning"
)
BASELINE_RUN = ROOT / "experiments/runs/2026-08-25T14-12-11-482Z_ui_interaction_latency"
TABLE_DIR = ROOT / "results/tables/ui-unique-user-latency"
PLOT_DIR = ROOT / "results/plots/ui-unique-user-latency"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def nearest_rank(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))]


def verify_manifest(run_dir: Path) -> list[str]:
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    mismatches = []
    for name, expected in manifest["artifacts"].items():
        artifact = run_dir / name
        if (not artifact.exists() or artifact.stat().st_size != expected["bytes"]
                or digest(artifact) != expected["sha256"]):
            mismatches.append(name)
    return mismatches


def verify_latency_run(
    run_dir: Path,
    expected_samples: int,
    expected_batches: int,
    require_distinct_records: bool,
) -> dict:
    raw = read_jsonl(run_dir / "raw-samples.jsonl")
    summary = read_csv(run_dir / "summary.csv")
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for sample in raw:
        groups[(sample["operation"], sample["repetition"], sample["concurrentUsers"])].append(
            sample
        )

    guardrail_failures = []
    for key, samples in groups.items():
        level = int(key[2])
        distinct_users = len({sample["username"] for sample in samples})
        distinct_records = len({sample.get("recordId") for sample in samples})
        if len(samples) != level or distinct_users != level:
            guardrail_failures.append({
                "batch": key, "samples": len(samples), "distinctUsers": distinct_users,
            })
        if require_distinct_records and distinct_records != level:
            guardrail_failures.append({
                "batch": key, "distinctRecords": distinct_records,
            })

    summary_mismatches = []
    for row in summary:
        operation = row["operation"]
        level = int(row["concurrentUsers"])
        values = [
            float(sample["elapsedMs"])
            for sample in raw
            if sample["operation"] == operation
            and int(sample["concurrentUsers"]) == level
            and sample["ok"]
        ]
        for field, fraction in (("p50Ms", 0.50), ("p95Ms", 0.95)):
            observed = nearest_rank(values, fraction)
            if abs(float(row[field]) - observed) > 0.02:
                summary_mismatches.append({
                    "operation": operation,
                    "level": level,
                    "metric": field,
                    "reported": float(row[field]),
                    "recomputedFromRoundedRaw": observed,
                })

    grant_mismatches = sum(
        1 for sample in raw
        if sample["operation"].startswith("release")
        and sample.get("grantedByDecision") != sample.get("expectedDecisionId")
    )
    report = json.loads((run_dir / "run-report.json").read_text(encoding="utf-8"))
    return {
        "runId": run_dir.name,
        "manifestMismatches": verify_manifest(run_dir),
        "rawSamples": len(raw),
        "expectedSamples": expected_samples,
        "batches": len(groups),
        "expectedBatches": expected_batches,
        "requestFailures": sum(1 for sample in raw if not sample["ok"]),
        "grantDecisionMismatches": grant_mismatches,
        "identityOrRecordGuardrailFailures": guardrail_failures,
        "summaryMismatches": summary_mismatches,
        "runReportFullSweepPassed": report["result"]["fullSweepPassed"],
    }


def index_rows(rows: list[dict[str, str]]) -> dict[tuple[str, int], dict[str, str]]:
    concurrency_key = "concurrentUsers" if "concurrentUsers" in rows[0] else "concurrentSessions"
    return {(row["operation"], int(row[concurrency_key])): row for row in rows}


def percent_change(current: float, baseline: float) -> float:
    return round((current - baseline) * 100.0 / baseline, 2)


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def plot_primary(main: dict, per_user: dict) -> None:
    levels = [10, 25, 50, 75, 100]
    panels = [
        ("search", main, "(a) Search case files"),
        ("submit", main, "(b) Submit through commit"),
        ("release-per-user-record", per_user, "(c) Open authorized file"),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(10.8, 3.25), constrained_layout=True)
    for axis, (operation, rows, title) in zip(axes, panels):
        p50 = [float(rows[(operation, level)]["p50Ms"]) for level in levels]
        p95 = [float(rows[(operation, level)]["p95Ms"]) for level in levels]
        axis.plot(levels, p50, marker="o", linewidth=1.8, label="p50")
        axis.plot(levels, p95, marker="s", linewidth=1.8, linestyle="--", label="p95")
        axis.set_title(title, fontsize=10)
        axis.set_xlabel("Concurrent distinct users")
        axis.set_ylabel("Client-observed latency (ms)")
        axis.set_xticks(levels)
        axis.grid(True, alpha=0.25)
        axis.legend(frameon=False, fontsize=8)
    fig.savefig(PLOT_DIR / "interactive_latency_distinct_users.pdf", bbox_inches="tight")
    fig.savefig(PLOT_DIR / "interactive_latency_distinct_users.png", dpi=240, bbox_inches="tight")
    plt.close(fig)


def plot_release_layout(baseline: dict, shared: dict, per_user: dict) -> None:
    levels = [10, 25, 50, 75, 100]
    fig, axes = plt.subplots(1, 2, figsize=(7.4, 3.2), constrained_layout=True)
    conditions = [
        ("Reused identity baseline", baseline, "release"),
        ("Distinct users, shared record", shared, "release"),
        ("Distinct users, per-user record", per_user, "release-per-user-record"),
    ]
    for axis, metric, title in zip(axes, ("p50Ms", "p95Ms"), ("(a) p50", "(b) p95")):
        for label, rows, operation in conditions:
            axis.plot(
                levels,
                [float(rows[(operation, level)][metric]) for level in levels],
                marker="o",
                linewidth=1.7,
                label=label,
            )
        axis.set_title(title)
        axis.set_xlabel("Concurrent clients/users")
        axis.set_ylabel("Authorized-open latency (ms)")
        axis.set_xticks(levels)
        axis.grid(True, alpha=0.25)
    axes[1].legend(frameon=False, fontsize=7, loc="upper left")
    fig.savefig(PLOT_DIR / "release_layout_ablation.pdf", bbox_inches="tight")
    fig.savefig(PLOT_DIR / "release_layout_ablation.png", dpi=240, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    TABLE_DIR.mkdir(parents=True, exist_ok=True)
    PLOT_DIR.mkdir(parents=True, exist_ok=True)

    verification = {
        "generatedAtUtc": "2026-08-28",
        "main": verify_latency_run(MAIN_RUN, 2340, 45, False),
        "releaseLayoutAblation": verify_latency_run(ABLATION_RUN, 780, 15, True),
        "provisioningManifestMismatches": verify_manifest(PROVISION_RUN),
    }
    provision_summary = json.loads((PROVISION_RUN / "summary.json").read_text(encoding="utf-8"))
    verification["provisioning"] = provision_summary

    current_plan = (ROOT / "experiments/plans/20260828_unique_user_latency.md").read_bytes()
    marker = b"\n## Release-layout ablation"
    original_plan = current_plan.split(marker, 1)[0]
    main_config = json.loads((MAIN_RUN / "config.json").read_text(encoding="utf-8"))
    ablation_config = json.loads((ABLATION_RUN / "config.json").read_text(encoding="utf-8"))
    provision_config = json.loads((PROVISION_RUN / "config.json").read_text(encoding="utf-8"))
    main_plan_hash = hashlib.sha256(original_plan).hexdigest()
    verification["sourcePlanChecks"] = {
        "reconstructedMainPlanSha256": main_plan_hash,
        "recordedMainPlanSha256": main_config["sourceSha256"]["experimentPlan"],
        "currentExtendedPlanSha256": hashlib.sha256(current_plan).hexdigest(),
        "recordedAblationPlanSha256": ablation_config["sourceSha256"]["experimentPlan"],
    }
    verification["sourceFileChecks"] = {
        "mainRunner": digest(ROOT / "experiments/run-ui-unique-user-latency.js")
        == main_config["sourceSha256"]["runner"],
        "ablationRunner": digest(
            ROOT / "experiments/run-ui-unique-user-release-layout-ablation.js"
        ) == ablation_config["sourceSha256"]["runner"],
        "provisioningRunner": digest(ROOT / "experiments/provision-ui-unique-users.js")
        == provision_config["sourceSha256"],
        "backendRecordRoutes": digest(ROOT / "backend/src/routes/records.js")
        == main_config["sourceSha256"]["backendRecordRoutes"],
        "fabricGateway": digest(ROOT / "backend/src/fabric/gateway.js")
        == main_config["sourceSha256"]["fabricGateway"],
        "accessChaincode": digest(ROOT / "chaincode/crimerecords/lib/accessContract.js")
        == main_config["sourceSha256"]["accessChaincode"],
        "recordChaincode": digest(ROOT / "chaincode/crimerecords/lib/recordContract.js")
        == main_config["sourceSha256"]["recordChaincode"],
        "couchDbCaseIndex": digest(
            ROOT / "chaincode/crimerecords/META-INF/statedb/couchdb/indexes/"
            "indexDocTypeCaseId.json"
        ) == main_config["sourceSha256"]["couchDbCaseIndex"],
    }
    (TABLE_DIR / "main-plan-snapshot.md").write_bytes(original_plan)

    failures = []
    for label in ("main", "releaseLayoutAblation"):
        item = verification[label]
        for key in (
            "manifestMismatches", "identityOrRecordGuardrailFailures",
            "summaryMismatches",
        ):
            if item[key]:
                failures.append(f"{label}:{key}")
        if item["rawSamples"] != item["expectedSamples"]:
            failures.append(f"{label}:sample-count")
        if item["batches"] != item["expectedBatches"]:
            failures.append(f"{label}:batch-count")
        if item["requestFailures"] or item["grantDecisionMismatches"]:
            failures.append(f"{label}:correctness")
        if not item["runReportFullSweepPassed"]:
            failures.append(f"{label}:run-report")
    if verification["provisioningManifestMismatches"] or not provision_summary["success"]:
        failures.append("provisioning")
    checks = verification["sourcePlanChecks"]
    if checks["reconstructedMainPlanSha256"] != checks["recordedMainPlanSha256"]:
        failures.append("main-plan-hash")
    if checks["currentExtendedPlanSha256"] != checks["recordedAblationPlanSha256"]:
        failures.append("ablation-plan-hash")
    if not all(verification["sourceFileChecks"].values()):
        failures.append("source-file-hash")
    verification["failures"] = failures
    verification["passed"] = not failures
    (TABLE_DIR / "verification.json").write_text(
        json.dumps(verification, indent=2) + "\n", encoding="utf-8"
    )
    if failures:
        raise RuntimeError(f"evidence verification failed: {failures}")

    copies = {
        MAIN_RUN / "summary.csv": TABLE_DIR / "unique-user-summary.csv",
        MAIN_RUN / "rounds.csv": TABLE_DIR / "unique-user-rounds.csv",
        MAIN_RUN / "run-report.json": TABLE_DIR / "unique-user-run-report.json",
        ABLATION_RUN / "summary.csv": TABLE_DIR / "release-layout-ablation-summary.csv",
        ABLATION_RUN / "rounds.csv": TABLE_DIR / "release-layout-ablation-rounds.csv",
        ABLATION_RUN / "run-report.json": TABLE_DIR / "release-layout-ablation-report.json",
        PROVISION_RUN / "summary.json": TABLE_DIR / "provisioning-summary.json",
    }
    for source, destination in copies.items():
        shutil.copy2(source, destination)

    baseline = index_rows(read_csv(BASELINE_RUN / "summary.csv"))
    unique = index_rows(read_csv(MAIN_RUN / "summary.csv"))
    per_user = index_rows(read_csv(ABLATION_RUN / "summary.csv"))
    levels = [10, 25, 50, 75, 100]
    identity_rows = []
    for operation in ("search", "release", "submit"):
        for level in levels:
            old = baseline[(operation, level)]
            new = unique[(operation, level)]
            identity_rows.append({
                "operation": operation,
                "concurrency": level,
                "baseline_identity_pool": 5,
                "distinct_user_pool": 100,
                "baseline_p50_ms": old["p50Ms"],
                "distinct_user_p50_ms": new["p50Ms"],
                "p50_change_percent": percent_change(float(new["p50Ms"]), float(old["p50Ms"])),
                "baseline_p95_ms": old["p95Ms"],
                "distinct_user_p95_ms": new["p95Ms"],
                "p95_change_percent": percent_change(float(new["p95Ms"]), float(old["p95Ms"])),
                "comparison_scope": "descriptive cross-run; release also changes grant-set size",
            })
    write_csv(
        TABLE_DIR / "identity-mode-comparison.csv",
        identity_rows,
        list(identity_rows[0].keys()),
    )

    layout_rows = []
    for level in levels:
        old = baseline[("release", level)]
        shared = unique[("release", level)]
        separate = per_user[("release-per-user-record", level)]
        layout_rows.append({
            "concurrency": level,
            "reused_identity_baseline_p50_ms": old["p50Ms"],
            "distinct_users_shared_record_p50_ms": shared["p50Ms"],
            "distinct_users_per_user_record_p50_ms": separate["p50Ms"],
            "shared_vs_per_user_p50_ratio": round(float(shared["p50Ms"]) / float(separate["p50Ms"]), 2),
            "reused_identity_baseline_p95_ms": old["p95Ms"],
            "distinct_users_shared_record_p95_ms": shared["p95Ms"],
            "distinct_users_per_user_record_p95_ms": separate["p95Ms"],
            "shared_vs_per_user_p95_ratio": round(float(shared["p95Ms"]) / float(separate["p95Ms"]), 2),
        })
    write_csv(
        TABLE_DIR / "release-layout-comparison.csv",
        layout_rows,
        list(layout_rows[0].keys()),
    )

    primary_rows = []
    for level in levels:
        search = unique[("search", level)]
        submit = unique[("submit", level)]
        release = per_user[("release-per-user-record", level)]
        primary_rows.append({
            "concurrent_distinct_users": level,
            "search_p50_ms": search["p50Ms"],
            "search_p95_ms": search["p95Ms"],
            "authorized_open_p50_ms": release["p50Ms"],
            "authorized_open_p95_ms": release["p95Ms"],
            "submission_p50_ms": submit["p50Ms"],
            "submission_p95_ms": submit["p95Ms"],
            "attempted_per_operation": int(search["attempted"]),
            "failed_per_operation": 0,
        })
    write_csv(
        TABLE_DIR / "paper-primary-latency.csv",
        primary_rows,
        list(primary_rows[0].keys()),
    )

    plot_primary(unique, per_user)
    plot_release_layout(baseline, unique, per_user)

    evidence = {
        "primaryDistinctUserRun": str(MAIN_RUN.relative_to(ROOT)),
        "postHocReleaseLayoutAblation": str(ABLATION_RUN.relative_to(ROOT)),
        "provisioningRun": str(PROVISION_RUN.relative_to(ROOT)),
        "reusedIdentityBaseline": str(BASELINE_RUN.relative_to(ROOT)),
        "verifiedMeasuredRequests": {
            "mainDistinctUserSweep": 2340,
            "releaseLayoutAblation": 780,
            "totalNewMeasuredRequests": 3120,
        },
        "allNewMeasuredRequestsSucceeded": True,
        "comparisonWarning": (
            "Runs were sequential and not randomized. The five-identity baseline is from an "
            "earlier date; comparisons are descriptive, not causal estimates."
        ),
    }
    (TABLE_DIR / "evidence.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8"
    )

    at_100 = primary_rows[-1]
    shared_100 = unique[("release", 100)]
    readme = f"""# Distinct-user interactive latency evidence

This directory is generated from immutable run artifacts, not manually entered
numbers. The primary run used 100 enrolled synthetic Fabric identities and each
batch at 10, 25, 50, 75, and 100 contained exactly that many distinct users.

## Verified facts

- Provisioning: 100/100 users were enrolled, written to the ledger, and assigned
  to `CASE-2026-001`.
- Primary sweep: 2,340/2,340 requests succeeded across 45 batches.
- Post-hoc release-layout ablation: 780/780 requests succeeded across 15 batches.
- At 100 distinct users, pooled p50/p95 were
  {at_100['search_p50_ms']}/{at_100['search_p95_ms']} ms for search,
  {at_100['submission_p50_ms']}/{at_100['submission_p95_ms']} ms for submission,
  and {at_100['authorized_open_p50_ms']}/{at_100['authorized_open_p95_ms']} ms
  for authorized opening when each user opened a separate one-grant record.
- When all users opened one record containing 100 grants, authorized-open
  p50/p95 rose to {shared_100['p50Ms']}/{shared_100['p95Ms']} ms.

## Interpretation boundary

`AuthorizeRecordRead` iterates decisions under the requested record. The much
higher shared-record result is therefore consistent with grant-set scanning,
not evidence that distinct identities alone caused the increase. The ablation
was added after observing the shared-record curve and the runs were sequential;
it is diagnostic evidence, not a randomized causal comparison.

The reused-identity baseline was run on 2026-08-25. Any comparison with it is
cross-run and descriptive. All measurements are from one local host, one
orderer, and three batches per point; they do not establish capacity, geographic
performance, or confidence intervals.
"""
    (TABLE_DIR / "README.md").write_text(readme, encoding="utf-8")

    result_files = sorted(
        [path for path in TABLE_DIR.iterdir() if path.name != "results-manifest.json"]
        + list(PLOT_DIR.iterdir())
    )
    result_manifest = {
        "generatedBy": "experiments/finalize-ui-unique-user-results.py",
        "artifacts": {
            str(path.relative_to(ROOT)): {
                "bytes": path.stat().st_size,
                "sha256": digest(path),
            }
            for path in result_files
        },
    }
    (TABLE_DIR / "results-manifest.json").write_text(
        json.dumps(result_manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "verificationPassed": True,
        "mainMeasuredRequests": 2340,
        "ablationMeasuredRequests": 780,
        "tableDirectory": str(TABLE_DIR),
        "plotDirectory": str(PLOT_DIR),
    }, indent=2))


if __name__ == "__main__":
    main()
