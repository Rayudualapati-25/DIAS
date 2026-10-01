#!/usr/bin/env python3
"""Record exactly what the testbed ran: hardware, VMs, images, contract, model,
code snapshots and git state. Written next to the results so every number can
be traced to the software that produced it.

Usage: python3 capture_manifest.py --out <manifest.json>
"""

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TB = os.path.expanduser("~/dias-testbed")
ADAPTER = os.path.join(REPO, "LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7/adapters.safetensors")


def run(*cmd, cwd=None):
    result = subprocess.run(list(cmd), capture_output=True, text=True, cwd=cwd)
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
    args = parser.parse_args()
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
                "name": "diasrecords", "version": "2.3", "sequence": 1,
                "package_sha256": open(os.path.join(TB, "channel-artifacts/diasrecords_2.3.sha256")).read().split()[0],
                "source_tree_sha256": open(os.path.join(TB, "chaincode-staging/SOURCE_SHA256")).read().split()[-1],
                "on_chain": "request facts and hashes; auditor decision with the LLM recommendation value "
                            "(ALLOW/DENY/UNAVAILABLE) and the agreement the contract derives from both",
                "off_chain": "justification text, the LLM's reason text, reason code, clause references, provenance",
            },
        },
        "backend": {
            "image": "dias-backend:testbed",
            "image_source_sha256_now": open(os.path.join(TB, "build/BACKEND_SOURCE_SHA256")).read().strip(),
            "trace": "DIAS_TRACE_FILE on (timing of every ledger call, queue and model call)",
        },
        "model": {
            "server": "mlx_lm.server 0.31.3 on the Mac GPU, 127.0.0.1:8081, HF_HUB_OFFLINE=1",
            "base_model": "mlx-community/Qwen3-14B-4bit",
            "base_revision": run("cat", os.path.expanduser("~/.cache/huggingface/hub/models--mlx-community--Qwen3-14B-4bit/refs/main")),
            "adapter": "qwen3-14b-dias-lora-v7",
            "adapter_sha256": sha256_file(ADAPTER),
            "decoding": {"temperature": 0, "top_p": 1, "max_tokens": 512, "thinking": "disabled"},
            "prompt_cache": "server default (10 entries); every request in a run has distinct facts",
            "workers": "1 (the backend answers recommendations one at a time)",
        },
        "plans": {
            "burst_and_steady_sha256": json.load(open(os.path.join(REPO, "testbed/load/generated/plan-meta.json")))["planSha256"],
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
