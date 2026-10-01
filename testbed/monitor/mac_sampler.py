#!/usr/bin/env python3
"""Resource sampler for M5, the Mac that runs the MLX model server.

Every --interval seconds it appends one CSV row: the model server's CPU (in
cores, where 1.0 is one fully used core) and resident memory, the whole Mac's
CPU and memory, and the GPU's utilisation and in-use memory as reported by the
IOAccelerator statistics (no administrator rights needed). The four testbed VMs
are measured from inside by cAdvisor/node-exporter; this file covers the fifth
machine.

Usage: python3 mac_sampler.py --pid-file <model-server.pid> --out <file.csv>
"""

import argparse
import csv
import os
import re
import subprocess
import sys
import time

import psutil

GPU_FIELDS = {
    "gpu_utilization_pct": re.compile(r'"Device Utilization %"=(\d+)'),
    "gpu_in_use_memory_bytes": re.compile(r'"In use system memory"=(\d+)'),
}


def gpu_stats():
    try:
        text = subprocess.run(
            ["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {key: "" for key in GPU_FIELDS}
    out = {}
    for key, pattern in GPU_FIELDS.items():
        match = pattern.search(text)
        out[key] = match.group(1) if match else ""
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--interval", type=float, default=5.0)
    args = parser.parse_args()

    with open(args.pid_file) as handle:
        pid = int(handle.read().strip())
    model = psutil.Process(pid)
    model.cpu_percent(None)
    psutil.cpu_percent(None)
    fields = [
        "epoch_s", "model_cpu_cores", "model_rss_bytes", "mac_cpu_pct_of_all_cores",
        "mac_cpu_cores_used", "mac_memory_used_bytes", "mac_memory_total_bytes",
        "gpu_utilization_pct", "gpu_in_use_memory_bytes",
    ]
    new_file = not os.path.exists(args.out)
    cores = psutil.cpu_count(logical=True)
    with open(args.out, "a", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        if new_file:
            writer.writeheader()
        while True:
            time.sleep(args.interval)
            try:
                model_cpu = model.cpu_percent(None) / 100.0
                model_rss = model.memory_info().rss
            except psutil.NoSuchProcess:
                print("model server exited; sampler stops", file=sys.stderr)
                return 0
            mac_pct = psutil.cpu_percent(None)
            memory = psutil.virtual_memory()
            row = {
                "epoch_s": f"{time.time():.3f}",
                "model_cpu_cores": f"{model_cpu:.3f}",
                "model_rss_bytes": model_rss,
                "mac_cpu_pct_of_all_cores": f"{mac_pct:.2f}",
                "mac_cpu_cores_used": f"{mac_pct * cores / 100.0:.3f}",
                "mac_memory_used_bytes": memory.total - memory.available,
                "mac_memory_total_bytes": memory.total,
            }
            row.update(gpu_stats())
            writer.writerow(row)
            handle.flush()


if __name__ == "__main__":
    sys.exit(main())
