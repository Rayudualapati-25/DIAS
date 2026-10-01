"""Per-container CPU (cores) and memory (MB) from the docker-stats sampler CSV.

cAdvisor could not read containers on the testbed VMs (Docker's containerd
image store), so per-container figures come from Docker's own statistics API,
sampled every 5 s by testbed/monitor/docker_stats_sampler.py. Whole-VM figures
still come from node-exporter through Prometheus.
"""

import csv
from collections import defaultdict

_CACHE = {}


def load(path):
    if path not in _CACHE:
        rows = []
        with open(path) as handle:
            for row in csv.DictReader(handle):
                if not row["cpu_cores"]:
                    continue
                rows.append((float(row["epoch_s"]), row["machine"], row["container"], float(row["cpu_cores"]),
                             float(row["mem_bytes"]) if row["mem_bytes"] else None))
        _CACHE[path] = rows
    return _CACHE[path]


def first_sample_time(path):
    rows = load(path)
    return min(r[0] for r in rows) if rows else None


def window(path, start_s, end_s):
    """{(machine, container): {cpu_mean_cores, cpu_max_cores, mem_max_mb, samples}} for samples in [start, end]."""
    groups = defaultdict(list)
    for t, machine, container, cpu, mem in load(path):
        if start_s <= t <= end_s:
            groups[(machine, container)].append((cpu, mem))
    out = {}
    for key, values in groups.items():
        cpus = [c for c, _ in values]
        mems = [m for _, m in values if m is not None]
        out[key] = {"cpu_mean_cores": sum(cpus) / len(cpus), "cpu_max_cores": max(cpus),
                    "mem_max_mb": (max(mems) / 1e6) if mems else None, "samples": len(values)}
    return out


def series(path, start_s, end_s, machine=None):
    """{(machine, container): [(t, cpu, mem)]} for plotting."""
    groups = defaultdict(list)
    for t, m, container, cpu, mem in load(path):
        if start_s <= t <= end_s and (machine is None or m == machine):
            groups[(m, container)].append((t, cpu, mem))
    return groups
