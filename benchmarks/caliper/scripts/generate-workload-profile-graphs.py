#!/usr/bin/env python3
"""Generate publication-quality methodology figures from Caliper inputs only.

These figures visualize configured offered load and planned workload composition.
They deliberately do not read placeholder tables or invent performance results.
"""

from __future__ import annotations

import csv
import hashlib
import json
import platform
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch, Rectangle
import yaml


CALIPER_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = CALIPER_DIR.parents[1]
PLOT_DIR = PROJECT_DIR / "results" / "plots" / "caliper"
TABLE_DIR = PROJECT_DIR / "results" / "tables" / "caliper_profiles"
INTER_ROUND_WAIT_SECONDS = 5

PROFILES = [
    ("read", "Read Test", "configs/read-performance.yaml"),
    ("write", "Write Test", "configs/write-performance.yaml"),
    ("increasing_load", "Increasing-Load Test", "configs/increasing-load.yaml"),
    ("mixed", "Mixed-Workload Test", "configs/mixed-workload.yaml"),
    ("endurance", "Endurance Test", "configs/endurance.yaml"),
]

BLUE = "#0072B2"
ORANGE = "#D55E00"
GRAY = "#8A8A8A"
LIGHT_GRAY = "#E6E6E6"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def phase_for(label: str) -> str:
    return "warmup" if "warmup" in label.lower() else "measurement"


def load_profile(config: dict) -> tuple[list[dict], int, int | None, int | None]:
    workers = int(config["test"]["workers"]["number"])
    segments: list[dict] = []
    cursor = 0
    read_percent = None

    for index, round_config in enumerate(config["test"]["rounds"]):
        duration = int(round_config["txDuration"])
        target_tps = float(round_config["rateControl"]["opts"]["tps"])
        arguments = round_config["workload"].get("arguments", {})
        if "readPercent" in arguments:
            current_read_percent = int(arguments["readPercent"])
            if read_percent is not None and current_read_percent != read_percent:
                raise ValueError("readPercent must remain fixed across a profile")
            read_percent = current_read_percent

        segments.append({
            "label": round_config["label"],
            "phase": phase_for(round_config["label"]),
            "start_s": cursor,
            "end_s": cursor + duration,
            "duration_s": duration,
            "target_tps": target_tps,
            "workers": workers,
        })
        cursor += duration

        if index < len(config["test"]["rounds"]) - 1:
            segments.append({
                "label": "caliper-inter-round-wait",
                "phase": "wait",
                "start_s": cursor,
                "end_s": cursor + INTER_ROUND_WAIT_SECONDS,
                "duration_s": INTER_ROUND_WAIT_SECONDS,
                "target_tps": 0.0,
                "workers": workers,
            })
            cursor += INTER_ROUND_WAIT_SECONDS

    write_percent = None if read_percent is None else 100 - read_percent
    return segments, workers, read_percent, write_percent


def write_profile_csv(profile_id: str, segments: list[dict], read_percent: int | None,
                      write_percent: int | None) -> Path:
    output = TABLE_DIR / f"caliper_{profile_id}_configured_profile.csv"
    fields = [
        "label", "phase", "start_s", "end_s", "duration_s", "target_tps",
        "workers", "planned_read_percent", "planned_write_percent",
    ]
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for segment in segments:
            writer.writerow({
                **segment,
                "planned_read_percent": "" if read_percent is None else read_percent,
                "planned_write_percent": "" if write_percent is None else write_percent,
            })
    return output


def format_duration(seconds: int) -> str:
    if seconds >= 3600 and seconds % 3600 == 0:
        hours = seconds // 3600
        return f"{hours} h"
    if seconds >= 60 and seconds % 60 == 0:
        minutes = seconds // 60
        return f"{minutes} min"
    return f"{seconds} s"


def annotate_segment(axis, segment: dict, scale: float, maximum_tps: float) -> None:
    if segment["phase"] == "wait":
        return
    center = ((segment["start_s"] + segment["end_s"]) / 2) / scale
    target = segment["target_tps"]
    if segment["phase"] == "warmup":
        # Warm-up segments can be less than one percent of a long run. A
        # callout keeps their label legible without visually widening them.
        axis.annotate(
            f"Warm-up: {target:g} TPS for {format_duration(segment['duration_s'])}",
            xy=(center, target * 0.9),
            xycoords="data",
            xytext=(0.035, 0.72),
            textcoords="axes fraction",
            ha="left",
            va="center",
            fontsize=6.8,
            color="#222222",
            bbox={"boxstyle": "round,pad=0.25", "fc": "white", "ec": GRAY,
                  "alpha": 0.92, "lw": 0.55},
            arrowprops={"arrowstyle": "-", "color": GRAY, "lw": 0.65},
        )
        return
    if "increasing-load" in segment["label"]:
        text = f"{target:g} TPS"
        axis.text(
            center,
            target + max(0.25, maximum_tps * 0.035),
            text,
            ha="center",
            va="bottom",
            fontsize=7,
            color="#222222",
        )
        return

    text = f"Measured round\n{target:g} TPS for {format_duration(segment['duration_s'])}"
    axis.text(
        center,
        target * 0.5,
        text,
        ha="center",
        va="center",
        fontsize=7.2,
        fontweight="bold",
        color="white",
    )


def plot_profile(profile_id: str, title: str, segments: list[dict], workers: int,
                 read_percent: int | None, write_percent: int | None) -> list[Path]:
    total_seconds = segments[-1]["end_s"]
    use_hours = total_seconds >= 3600
    scale = 3600.0 if use_hours else 1.0
    x_label = "Elapsed time (hours)" if use_hours else "Elapsed time (seconds)"
    has_mix = read_percent is not None

    if has_mix:
        figure, (load_axis, mix_axis) = plt.subplots(
            2,
            1,
            figsize=(5.6, 4.25),
            gridspec_kw={"height_ratios": [2.35, 1.0]},
        )
    else:
        figure, load_axis = plt.subplots(figsize=(5.6, 3.2))
        mix_axis = None

    maximum_tps = max(segment["target_tps"] for segment in segments)
    for segment in segments:
        start = segment["start_s"] / scale
        width = segment["duration_s"] / scale
        if segment["phase"] == "wait":
            load_axis.axvspan(start, start + width, color=LIGHT_GRAY, alpha=0.8, zorder=0)
            continue
        color = GRAY if segment["phase"] == "warmup" else BLUE
        load_axis.add_patch(Rectangle(
            (start, 0), width, segment["target_tps"],
            facecolor=color, edgecolor="#222222", linewidth=0.55, alpha=0.78,
        ))
        annotate_segment(load_axis, segment, scale, maximum_tps)

    load_axis.set_xlim(0, total_seconds / scale)
    load_axis.set_ylim(0, maximum_tps * 1.28 + 0.5)
    load_axis.set_ylabel("Offered load (TPS)")
    load_axis.set_xlabel(x_label)
    load_axis.grid(axis="y", color="#D0D0D0", linewidth=0.5, alpha=0.8)
    load_axis.spines[["top", "right"]].set_visible(False)
    load_axis.text(
        0.99, 0.96, f"Workers: {workers}", transform=load_axis.transAxes,
        ha="right", va="top", fontsize=7, color="#333333",
    )

    legend_handles = []
    if any(segment["phase"] == "warmup" for segment in segments):
        legend_handles.append(
            Patch(facecolor=GRAY, edgecolor="#222222", alpha=0.78, label="Warm-up")
        )
    legend_handles.append(
        Patch(facecolor=BLUE, edgecolor="#222222", alpha=0.78, label="Measured round")
    )
    if any(segment["phase"] == "wait" for segment in segments):
        legend_handles.append(Patch(facecolor=LIGHT_GRAY, label="Inter-round wait"))
    figure.legend(
        handles=legend_handles,
        loc="upper center",
        bbox_to_anchor=(0.5, 0.915),
        frameon=False,
        fontsize=7,
        ncol=min(3, len(legend_handles)),
    )

    if mix_axis is not None:
        mix_axis.barh([0], [read_percent], color=BLUE, height=0.45, label="Read")
        mix_axis.barh(
            [0], [write_percent], left=[read_percent], color=ORANGE,
            height=0.45, label="Write",
        )
        mix_axis.text(read_percent / 2, 0, f"Read {read_percent}%", ha="center", va="center",
                      color="white", fontsize=7.5, fontweight="bold")
        mix_axis.text(read_percent + write_percent / 2, 0, f"Write {write_percent}%",
                      ha="center", va="center", color="white", fontsize=7.5,
                      fontweight="bold")
        mix_axis.set_xlim(0, 100)
        mix_axis.set_yticks([])
        mix_axis.set_xlabel("Configured operation composition (%)")
        mix_axis.spines[["top", "right", "left"]].set_visible(False)
        mix_axis.grid(axis="x", color="#D0D0D0", linewidth=0.5, alpha=0.8)

    figure.suptitle(
        f"{title}: Configured Input Profile", fontsize=10.5,
        fontweight="bold", y=0.985,
    )
    figure.text(
        0.5, 0.012, "Methodology figure — configured input, not measured performance",
        ha="center", va="bottom", fontsize=6.5, color="#555555",
    )
    figure.tight_layout(rect=(0, 0.055, 1, 0.83))

    stem = PLOT_DIR / f"caliper_{profile_id}_configured_profile"
    png_path = stem.with_suffix(".png")
    pdf_path = stem.with_suffix(".pdf")
    metadata = {
        "Title": f"{title}: Configured Input Profile",
        "Subject": "Configured Hyperledger Caliper workload input; not measured performance",
        "Author": "SEBA-XAI research artifact generator",
        # Fixed timestamps keep vector outputs byte-for-byte reproducible.
        "CreationDate": datetime(2000, 1, 1, tzinfo=timezone.utc),
        "ModDate": datetime(2000, 1, 1, tzinfo=timezone.utc),
    }
    png_metadata = {
        key: value for key, value in metadata.items()
        if key not in {"CreationDate", "ModDate"}
    }
    figure.savefig(png_path, dpi=300, bbox_inches="tight", metadata=png_metadata)
    figure.savefig(pdf_path, bbox_inches="tight", metadata=metadata)
    plt.close(figure)
    return [png_path, pdf_path]


def main() -> None:
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
        "font.size": 8,
        "axes.labelsize": 8,
        "xtick.labelsize": 7,
        "ytick.labelsize": 7,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })
    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    TABLE_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {
        "artifactType": "configured-workload-methodology-figures",
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "performanceResultsUsed": False,
        "interRoundWaitSeconds": INTER_ROUND_WAIT_SECONDS,
        "generator": str(Path(__file__).resolve().relative_to(PROJECT_DIR)),
        "generatorSha256": sha256(Path(__file__).resolve()),
        "environment": {
            "python": platform.python_version(),
            "matplotlib": matplotlib.__version__,
            "pyyaml": yaml.__version__,
        },
        "figures": [],
    }

    for profile_id, title, relative_config in PROFILES:
        config_path = CALIPER_DIR / relative_config
        with config_path.open("r", encoding="utf-8") as handle:
            config = yaml.safe_load(handle)
        segments, workers, read_percent, write_percent = load_profile(config)
        csv_path = write_profile_csv(
            profile_id, segments, read_percent, write_percent
        )
        outputs = plot_profile(
            profile_id, title, segments, workers, read_percent, write_percent
        )
        manifest["figures"].append({
            "test": profile_id,
            "sourceConfig": relative_config,
            "sourceConfigSha256": sha256(config_path),
            "sourceTable": str(csv_path.relative_to(PROJECT_DIR)),
            "sourceTableSha256": sha256(csv_path),
            "outputs": [
                {
                    "path": str(path.relative_to(PROJECT_DIR)),
                    "sha256": sha256(path),
                }
                for path in outputs
            ],
            "classification": "configured input; not a benchmark result",
        })

    manifest_path = PLOT_DIR / "figure_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Created {len(manifest['figures'])} configured-input figure sets")
    print(f"Figure manifest: {manifest_path}")


if __name__ == "__main__":
    main()
