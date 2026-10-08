#!/usr/bin/env python3
"""Record exactly what the testbed ran: hardware, VMs, images, contract, model,
code snapshots and git state. Written next to the results so every number can
be traced to the software that produced it.

Usage: python3 capture_manifest.py --out <manifest.json>
       --chaincode-definition <querycommitted.json> --model-evidence <smoke.json>
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TB = os.path.expanduser(os.environ.get("TB", "~/dias-testbed"))
ADAPTER = os.path.join(REPO, "LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7/adapters.safetensors")


def run(*cmd, cwd=None):
    result = subprocess.run(list(cmd), capture_output=True, text=True, cwd=cwd, check=True)
    return result.stdout.strip()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def vm(machine):
    ctx = f"lima-dias-{machine}"
    info = json.loads(run("docker", "--context", ctx, "info", "--format", "{{json .}}") or "{}")
    containers = []
    for line in run("docker", "--context", ctx, "ps", "--format", "{{.Names}}|{{.Image}}").splitlines():
        name, image = line.split("|", 1)
        digest = run("docker", "--context", ctx, "image", "inspect", image, "--format", "{{json .RepoDigests}}")
        image_id = run("docker", "--context", ctx, "image", "inspect", image, "--format", "{{.Id}}")
        containers.append({"container": name, "image": image, "image_id": image_id,
                           "repo_digests": json.loads(digest or "[]")})
    return {
        "machine": machine,
        "vcpus": info.get("NCPU"),
        "memory_bytes": info.get("MemTotal"),
        "kernel": info.get("KernelVersion"),
        "os": info.get("OperatingSystem"),
        "docker": info.get("ServerVersion"),
        "swarm_node_id": (info.get("Swarm") or {}).get("NodeID"),
        "containers": sorted(containers, key=lambda c: c["container"]),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--chaincode-definition", required=True,
                        help="fresh querycommitted JSON from the target testbed channel")
    parser.add_argument("--model-evidence", required=True,
                        help="passing testbed smoke JSON that verifies the served adapter")
    args = parser.parse_args()
    if os.path.exists(args.out):
        raise ValueError("output already exists; retain the earlier manifest")
    with open(args.chaincode_definition) as handle:
        definition = json.load(handle)
    if not definition.get("version") or not definition.get("sequence"):
        raise ValueError("chaincode definition must include its observed version and sequence")
    with open(args.model_evidence) as handle:
        model_report = json.load(handle)
    model = model_report.get("modelProvenance")
    if not model or not model.get("modelId"):
        raise ValueError("model evidence must contain actual recommendation provenance")
    summary = model_report.get("summary", {})
    if summary.get("fail", summary.get("failed", 1)) != 0:
        raise ValueError("model evidence must be a passing smoke run")
    expected_adapter = model_report.get("expectedAdapterHash") or ""
    if not re.fullmatch(r"[a-f0-9]{64}", expected_adapter) or expected_adapter != model.get("adapterHash"):
        raise ValueError("testbed smoke must verify the adapter actually served")

    manifest = {
        "captured_utc": run("date", "-u", "+%Y-%m-%dT%H:%M:%SZ"),
        "host": {
            "machine": "M5 (the Mac: runs the four VMs and the MLX model server)",
            "cpu": run("sysctl", "-n", "machdep.cpu.brand_string"),
            "cores": int(run("sysctl", "-n", "hw.ncpu")),
            "performance_cores": int(run("sysctl", "-n", "hw.perflevel0.physicalcpu")),
            "efficiency_cores": int(run("sysctl", "-n", "hw.perflevel1.physicalcpu")),
            "memory_bytes": int(run("sysctl", "-n", "hw.memsize")),
            "macos": platform.mac_ver()[0],
            "lima": run("limactl", "--version"),
            "docker_cli": run("docker", "version", "--format", "{{.Client.Version}}"),
        },
        "vms": [vm(m) for m in ["m1", "m2", "m3", "m4"]],
        "vm_network": "Lima user-v2 network (VM-to-VM), Docker Swarm overlay 'diasnet' (MTU 1400)",
        "fabric": {
            "channel": "diaschannel",
            "orderers": "3 x etcdraft (orderer1 on M1, orderer2 on M2, orderer3 on M3)",
            "peers": "5 (police on M1; forensics, prosecution on M2; court, audit on M3), CouchDB state database each",
            "batch": {"BatchTimeout": "2s", "MaxMessageCount": 10, "PreferredMaxBytes": "512 KB"},
            "endorsement_policy": "MAJORITY Endorsement (3 of 5)",
            "configtx_sha256": sha256_file(os.path.join(REPO, "testbed/config/configtx.yaml")),
            "chaincode": {
                "name": "diasrecords", "version": definition["version"], "sequence": definition["sequence"],
                "definition_sha256": sha256_file(args.chaincode_definition),
                "package_sha256": Path(TB, f"channel-artifacts/diasrecords_{definition['version']}.sha256").read_text().split()[0],
                "staged_source_tree_sha256": Path(TB, "chaincode-staging/SOURCE_SHA256").read_text().split()[-1],
                "on_chain": "verified context and claims digests; signed recommendation value and status; "
                            "auditor decision and note digest; agreement derived by the contract",
                "off_chain": "justification text, the LLM's reason text, reason code, clause references, provenance",
            },
        },
        "backend": {
            "image": "dias-backend:testbed",
            "image_source_sha256_now": Path(TB, "build/BACKEND_SOURCE_SHA256").read_text().strip(),
            "trace": "DIAS_TRACE_FILE on (timing of every ledger call, queue and model call)",
        },
        "model": {
            "observed_recommendation_provenance": model,
            "evidence_sha256": sha256_file(args.model_evidence),
            "v7_adapter_file_sha256": sha256_file(ADAPTER) if os.path.exists(ADAPTER) else None,
            "limitation": "Provenance is reported by the backend; the smoke checks its adapterHash against the supplied served-file digest.",
        },
        "plans": {
            "burst_and_steady_sha256": json.loads(Path(REPO, "testbed/load/generated/plan-meta.json").read_text())["planSha256"],
            "fault_plan_sha256": sha256_file(os.path.join(REPO, "testbed/load/generated/fault-plan.json")),
        },
        "git": {
            "head": run("git", "rev-parse", "HEAD", cwd=REPO),
            "tracked_diff_sha256": hashlib.sha256(run("git", "diff", "HEAD", cwd=REPO).encode()).hexdigest(),
            "changed_files": run("git", "status", "--short", cwd=REPO).splitlines(),
        },
    }
    with open(args.out, "w") as handle:
        json.dump(manifest, handle, indent=2)
    print(f"manifest written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
