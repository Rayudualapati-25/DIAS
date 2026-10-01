"""Read resource and Fabric metrics from the testbed's Prometheus (on M4).

Everything is queried with the HTTP range API at a 5 s step, the scrape
interval. CPU is reported in cores (1.0 = one fully used core) and memory in
MB, never as a percentage of an arbitrary total.
"""

import json
import urllib.parse
import urllib.request

PROMETHEUS = "http://127.0.0.1:19090"
STEP_S = 5

# Container CPU and memory from cAdvisor (one series per container per VM).
CONTAINER_CPU = 'sum by (machine, name) (rate(container_cpu_usage_seconds_total{name!=""}[30s]))'
CONTAINER_MEM = 'sum by (machine, name) (container_memory_working_set_bytes{name!=""})'
# Whole-VM CPU and memory from node-exporter.
# Busy time only: idle, I/O wait and hypervisor steal are not work the VM did.
MACHINE_CPU = 'sum by (machine) (rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[30s]))'
MACHINE_CORES = 'count by (machine) (node_cpu_seconds_total{mode="idle"})'
MACHINE_MEM_USED = 'max by (machine) (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)'
MACHINE_MEM_TOTAL = 'max by (machine) (node_memory_MemTotal_bytes)'


def _get(path, params):
    url = f"{PROMETHEUS}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=60) as response:
        body = json.loads(response.read())
    if body.get("status") != "success":
        raise RuntimeError(f"prometheus query failed: {body}")
    return body["data"]["result"]


def range_query(expr, start_s, end_s, step_s=STEP_S):
    """[(labels, [(t, value), ...]), ...]"""
    result = _get("/api/v1/query_range", {"query": expr, "start": f"{start_s:.3f}", "end": f"{end_s:.3f}", "step": step_s})
    return [(series["metric"], [(float(t), float(v)) for t, v in series["values"]]) for series in result]


def instant(expr, at_s):
    result = _get("/api/v1/query", {"query": expr, "time": f"{at_s:.3f}"})
    return [(series["metric"], float(series["value"][1])) for series in result]


def window_stats(expr, start_s, end_s, key):
    """Mean and max of each series over a window, keyed by `key(labels)`."""
    out = {}
    for labels, values in range_query(expr, start_s, end_s):
        numbers = [v for _, v in values]
        if not numbers:
            continue
        out[key(labels)] = {"mean": sum(numbers) / len(numbers), "max": max(numbers), "n": len(numbers)}
    return out


def histogram_mean(metric, start_s, end_s, by):
    """Mean of a Prometheus histogram over [start, end], grouped by label(s)."""
    span = max(1, int(round(end_s - start_s)))
    expr = (f"sum by ({by}) (increase({metric}_sum[{span}s])) / "
            f"sum by ({by}) (increase({metric}_count[{span}s]))")
    return {tuple(labels.get(k, "") for k in by.split(",")): value
            for labels, value in instant(expr, end_s) if value == value}


def counter_increase(metric, start_s, end_s, by):
    span = max(1, int(round(end_s - start_s)))
    expr = f"sum by ({by}) (increase({metric}[{span}s]))"
    return {tuple(labels.get(k, "") for k in by.split(",")): value for labels, value in instant(expr, end_s)}
