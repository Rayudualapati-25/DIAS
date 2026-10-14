#!/usr/bin/env python3
"""Figures of the three-setup experiment, from the analysed runs."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "testbed" / "analysis"))
import figstyle  # noqa: E402

MODELS = [("untuned", "Untuned Qwen3-14B"), ("v7", "Fine-tuned V7")]
CELLS = [("MM", "Mac only"), ("PP", "Phone only"), ("MP", "Officer Mac,\nauditor phone"), ("PM", "Officer phone,\nauditor Mac")]
SETUPS = [("mac-only", "Mac only"), ("phone-only", "Phone only"), ("combined", "Combined")]
STAGES = [
    ("submitMedianMs", "Request committed"),
    ("recommendationMedianMs", "LLM advice committed"),
    ("auditorReadMs", "Auditor reads queue and review"),
    ("decisionMedianMs", "Decision committed and confirmed"),
]


def load(runs: Path) -> dict:
    found = {}
    for model, _ in MODELS:
        file = runs / model / "analysis.json"
        if file.exists():
            found[model] = json.loads(file.read_text())["tables"]
    return found


def line(table: list, key: str, value: str) -> dict:
    return next((entry for entry in table if entry.get(key) == value), {})


def seconds(ms):
    return None if ms is None else ms / 1000


def stages_figure(tables: dict, out: Path) -> None:
    """Median of each stage of the end-to-end time, per cell and model."""
    models = [model for model, _ in MODELS if model in tables and tables[model].get("steps_by_cell")]
    if not models:
        return
    fig, axes = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=2.4, ncols=len(models), sharey=True, squeeze=False)
    for panel, model in enumerate(models):
        ax = axes[0][panel]
        bottom = [0.0] * len(CELLS)
        for index, (key, label) in enumerate(STAGES):
            values = []
            for cell, _ in CELLS:
                entry = line(tables[model]["steps_by_cell"], "group", cell)
                ms = (entry.get("queueMedianMs") or 0) + (entry.get("reviewMedianMs") or 0) if key == "auditorReadMs" else entry.get(key)
                values.append(seconds(ms) or 0.0)
            bars = ax.bar(range(len(CELLS)), values, bottom=bottom, width=0.58, color=figstyle.SERIES[index],
                          hatch=figstyle.HATCHES[index], edgecolor="white", linewidth=0.6,
                          label=label if panel == 0 else None)
            for bar, value in zip(bars, values):
                if value >= 0.8:
                    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_y() + value / 2, f"{value:.2f}",
                            ha="center", va="center", fontsize=5.8, color=figstyle.INK,
                            bbox={"boxstyle": "round,pad=0.1", "facecolor": "white", "edgecolor": "none", "alpha": 0.85})
            bottom = [b + v for b, v in zip(bottom, values)]
        for x, cell in enumerate(CELLS):
            total = seconds(line(tables[model]["steps_by_cell"], "group", cell[0]).get("endToEndMedianMs"))
            if total is not None:
                ax.annotate(f"{total:.2f} s", (x, bottom[x]), xytext=(0, 2), textcoords="offset points",
                            ha="center", va="bottom", fontsize=6.2, color=figstyle.INK)
        ax.set_xticks(range(len(CELLS)), [label for _, label in CELLS])
        ax.set_xlabel(dict(MODELS)[model])
        if panel == 0:
            ax.set_ylabel("Time (s)")
        ax.set_ylim(0, max(bottom) * 1.15)
    axes[0][0].legend(loc="upper center", bbox_to_anchor=(0.5 * len(models) + 0.05, 1.2), ncol=4)
    fig.tight_layout()
    figstyle.save(fig, out / "fig_setups_stages")


def seats_figure(tables: dict, out: Path) -> None:
    """Phone minus Mac, with 95% intervals, for each step a person makes."""
    models = [model for model, _ in MODELS if model in tables and tables[model].get("steps_by_seat")]
    if not models:
        return
    steps = [("officer", "submit", "Officer: request"), ("officer", "outcome", "Officer: read outcome"),
             ("auditor", "queue", "Auditor: queue"), ("auditor", "review", "Auditor: open review"),
             ("auditor", "decision", "Auditor: decide and confirm"), ("auditor", "log", "Auditor: access log"),
             ("auditor", "all", "Auditor: all steps")]
    fig, ax = figstyle.figure(height=2.5)
    for index, model in enumerate(models):
        offset = (index - (len(models) - 1) / 2) * 0.22
        for y, (person, step, _) in enumerate(steps):
            entry = next((e for e in tables[model]["steps_by_seat"] if e["person"] == person and e["step"] == step), None)
            if not entry or entry.get("differenceMs") is None:
                continue
            ax.errorbar(entry["differenceMs"], y + offset,
                        xerr=[[entry["differenceMs"] - entry["differenceLowMs"]], [entry["differenceHighMs"] - entry["differenceMs"]]],
                        fmt="os"[index], color=figstyle.SERIES[index], markersize=3.6, capsize=1.8, linewidth=0.9,
                        markeredgecolor="white", markeredgewidth=0.5, label=dict(MODELS)[model] if y == 0 else None)
    ax.axvline(0, color=figstyle.INK_2, linewidth=0.6)
    ax.set_yticks(range(len(steps)), [label for _, _, label in steps])
    ax.invert_yaxis()
    ax.grid(axis="x")
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("Phone minus Mac (ms): median, 95% CI")
    ax.legend(loc="lower center", bbox_to_anchor=(0.4, 1.0), ncol=len(models))
    fig.tight_layout()
    figstyle.save(fig, out / "fig_setups_phone_minus_mac")


def reuse_figure(tables: dict, out: Path) -> None:
    """A reviewed first request against a request its authorization granted."""
    models = [model for model, _ in MODELS if model in tables and tables[model].get("reuse")]
    if not models:
        return
    fig, ax = figstyle.figure(height=2.2)
    groups = [("officer on mac", "Officer on Mac"), ("officer on phone", "Officer on phone")]
    width = 0.8 / (2 * len(models))
    for m, model in enumerate(models):
        for k, (key, label) in enumerate([("firstRequestMedianMs", "reviewed first request"), ("reusedRequestMedianMs", "reused request")]):
            values = [seconds(line(tables[model]["reuse"], "group", group).get(key)) or 0 for group, _ in groups]
            x = [i - 0.4 + width * (2 * m + k + 0.5) for i in range(len(groups))]
            bars = ax.bar(x, values, width=width * 0.92, color=figstyle.SERIES[2 * m + k], hatch=figstyle.HATCHES[2 * m + k],
                          edgecolor="white", linewidth=0.6, label=f"{dict(MODELS)[model]}, {label}")
            figstyle.label_bars(ax, bars, fmt="{:.2f}")
    ax.set_xticks(range(len(groups)), [label for _, label in groups])
    ax.set_ylabel("Median time (s)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.32), ncol=2)
    fig.tight_layout()
    figstyle.save(fig, out / "fig_setups_reuse")


def load_figure(tables: dict, out: Path) -> None:
    """Time until every request of a burst was decided, against the burst size."""
    models = [model for model, _ in MODELS if model in tables and tables[model].get("load")]
    if not models:
        return
    fig, ax = figstyle.figure(height=2.3)
    series = 0
    for model in models:
        for setup, label in SETUPS:
            entries = sorted((e for e in tables[model]["load"] if e["setup"] == setup), key=lambda e: e["level"])
            if not entries:
                continue
            ax.plot([e["level"] for e in entries], [seconds(e["makespanMeanMs"]) for e in entries],
                    color=figstyle.SERIES[series], marker="os^D"[series % 4], markersize=3.8, linewidth=1.2,
                    linestyle="-" if model == "untuned" else "--", markeredgecolor="white", markeredgewidth=0.5,
                    label=f"{dict(MODELS)[model]}, {label}")
            series += 1
    ax.set_xticks([5, 10, 25])
    ax.set_xlabel("Requests sent at the same moment")
    ax.set_ylabel("Until all decided (s), mean of 2")
    ax.legend(loc="upper left", ncol=1)
    fig.tight_layout()
    figstyle.save(fig, out / "fig_setups_load")


def quality_figure(runs: Path, out: Path) -> None:
    """The 600 balanced test cases: what each model answered."""
    found = []
    for model, label in MODELS:
        file = runs / model / "quality" / "metrics.json"
        if file.exists():
            found.append((label, json.loads(file.read_text())["sets"]["test-decision-balanced"]))
    if not found:
        return
    kinds = ["Correct ALLOW", "Correct DENY", "False ALLOW", "False DENY", "No valid answer"]
    fig, ax = figstyle.figure(height=2.2)
    width = 0.8 / len(found)
    for m, (label, result) in enumerate(found):
        matrix = result["confusionMatrix"]
        values = [matrix["ALLOW"]["ALLOW"], matrix["DENY"]["DENY"], matrix["DENY"]["ALLOW"], matrix["ALLOW"]["DENY"],
                  result["examples"] - result["schemaValid"]]
        bars = ax.bar([i - 0.4 + width * (m + 0.5) for i in range(len(kinds))], values, width=width * 0.92,
                      color=figstyle.SERIES[m], hatch=figstyle.HATCHES[m], edgecolor="white", linewidth=0.6, label=label)
        figstyle.label_bars(ax, bars, fmt="{:.0f}")
    ax.set_xticks(range(len(kinds)), kinds)
    ax.set_ylabel("Test cases (of 600)")
    ax.legend(loc="upper right")
    fig.tight_layout()
    figstyle.save(fig, out / "fig_setups_quality")


RESOURCE_PARTS = ["model server", "backend", "peers", "CouchDB", "orderer", "chaincode", "phone emulators"]


def part_of(sample: dict) -> str:
    """The same grouping as setup-analyze.js partOf."""
    if sample["kind"] == "host":
        return "Mac (whole machine)"
    if sample["kind"] == "process":
        return "phone emulators" if sample["name"].startswith("emulator") else sample["name"].replace("-", " ")
    name = sample["name"]
    for prefix, part in (("dev-peer", "chaincode"), ("peer", "peers"), ("couchdb", "CouchDB"), ("orderer", "orderer"),
                         ("ca_", "certificate authorities")):
        if name.startswith(prefix):
            return part
    return "other containers"


def read_jsonl(file: Path) -> list:
    return [json.loads(line) for line in file.read_text().splitlines() if line.strip()] if file.exists() else []


def rolling_mean(values: list, window: int) -> list:
    out, total = [], 0.0
    for index, value in enumerate(values):
        total += value
        if index >= window:
            total -= values[index - window]
        out.append(total / min(index + 1, window))
    return out


def hour_resources_figure(runs: Path, out: Path) -> None:
    """CPU and memory of the system's parts over the hour, one figure per model (the phones are clients and not drawn)."""
    parts = [part for part in RESOURCE_PARTS if part != "phone emulators"]
    for model, label in MODELS:
        samples = read_jsonl(runs / model / "hour" / "resources.jsonl")
        if not samples:
            continue
        start = min(sample["t"] for sample in samples)
        totals: dict = {}
        for sample in samples:
            part = part_of(sample)
            if part not in parts:
                continue
            moment = totals.setdefault(part, {}).setdefault(sample["t"], [0.0, 0.0])
            moment[0] += sample.get("cpuPercent") or 0
            moment[1] += sample.get("memoryMiB") or 0
        fig, (cpu_ax, memory_ax) = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=2.5, ncols=2)
        for index, part in enumerate(parts):
            if part not in totals:
                continue
            times = sorted(totals[part])
            minutes = [(t - start) / 60000 for t in times]
            cpu_ax.plot(minutes, rolling_mean([totals[part][t][0] for t in times], 12), color=figstyle.SERIES[index],
                        linewidth=1.0, label=part)
            memory_ax.plot(minutes, [totals[part][t][1] / 1024 for t in times], color=figstyle.SERIES[index], linewidth=1.0)
        cpu_ax.set_ylabel("CPU, 1-min mean (% of one core)")
        memory_ax.set_ylabel("Memory (GiB, log scale)")
        memory_ax.set_yscale("log")
        for ax in (cpu_ax, memory_ax):
            ax.set_xlabel(f"Minutes into the run ({label})")
        handles, labels = cpu_ax.get_legend_handles_labels()
        fig.legend(handles, labels, loc="upper center", bbox_to_anchor=(0.5, 1.0), ncol=len(labels), frameon=False)
        fig.tight_layout(rect=[0, 0, 1, 0.86])
        figstyle.save(fig, out / f"fig_hour_resources_{model}")


def hour_latency_figure(runs: Path, out: Path) -> None:
    """Each request of the hour: when it was sent, and how long until its decision was committed."""
    found = [(model, label, read_jsonl(runs / model / "hour" / "rows.jsonl")) for model, label in MODELS]
    found = [(model, label, rows) for model, label, rows in found if rows]
    if not found:
        return
    fig, ax = figstyle.figure(height=2.3)
    for index, (model, label, rows) in enumerate(found):
        done = [row for row in rows if row.get("status") == "completed"]
        ax.scatter([row["sentAfterMs"] / 60000 for row in done], [(row["decidedAfterMs"] - row["sentAfterMs"]) / 1000 for row in done],
                   s=6, color=figstyle.SERIES[index], marker="os"[index], linewidths=0, alpha=0.8, label=label)
    ax.set_xlabel("Minute the request was sent")
    ax.set_ylabel("Until decision committed (s)")
    ax.legend(loc="upper left")
    fig.tight_layout()
    figstyle.save(fig, out / "fig_hour_latency")


def main() -> None:
    runs, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    tables = load(runs)
    stages_figure(tables, out)
    seats_figure(tables, out)
    reuse_figure(tables, out)
    load_figure(tables, out)
    quality_figure(runs, out)
    hour_resources_figure(runs, out)
    hour_latency_figure(runs, out)
    print("written:", ", ".join(sorted(p.name for p in out.glob("*.pdf"))))


if __name__ == "__main__":
    main()
