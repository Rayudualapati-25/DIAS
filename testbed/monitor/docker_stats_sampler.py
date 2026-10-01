#!/usr/bin/env python3
"""Per-container CPU and memory on every testbed VM, every 5 s, via `docker stats`.

cAdvisor cannot read containers on these VMs: Docker 29 here uses the
containerd image store, and cAdvisor (0.49.1 and 0.53.0 tried) fails with
"failed to identify the read-write layer ID", so it only reports the whole-VM
cgroup. Docker's own statistics API does not have that problem. CPU is written
in cores (docker's percentage / 100, so 1.0 = one full core) and memory in
bytes as docker reports it (usage without page cache).

Usage: python3 docker_stats_sampler.py --out <file.csv> [--interval 5]
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import threading
import time

MACHINES = ["m1", "m2", "m3", "m4"]
UNITS = {"B": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3, "TiB": 1024 ** 4, "kB": 1000, "MB": 1000 ** 2, "GB": 1000 ** 3}


def to_bytes(text):
    match = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", text or "")
    if not match:
        return None
    return float(match.group(1)) * UNITS.get(match.group(2), 1)


def sample(machine, out, lock):
    started = time.time()
    try:
        result = subprocess.run(["docker", "--context", f"lima-dias-{machine}", "stats", "--no-stream", "--format", "{{json .}}"],
                                capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return
    rows = []
    for line in result.stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        cpu = item.get("CPUPerc", "").rstrip("%")
        mem = (item.get("MemUsage") or "").split("/")[0]
        rows.append([f"{started:.3f}", machine, item.get("Name"), f"{float(cpu) / 100:.4f}" if cpu else "", to_bytes(mem)])
    with lock:
        out.writerows(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--interval", type=float, default=5.0)
    args = parser.parse_args()
    new = not os.path.exists(args.out)
    lock = threading.Lock()
    with open(args.out, "a", newline="") as handle:
        writer = csv.writer(handle)
        if new:
            writer.writerow(["epoch_s", "machine", "container", "cpu_cores", "mem_bytes"])
        while True:
            tick = time.time()
            threads = [threading.Thread(target=sample, args=(m, writer, lock)) for m in MACHINES]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            handle.flush()
            time.sleep(max(0.0, args.interval - (time.time() - tick)))


if __name__ == "__main__":
    sys.exit(main())
