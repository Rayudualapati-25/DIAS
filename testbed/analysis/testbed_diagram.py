#!/usr/bin/env python3
"""Testbed layout figure: four VMs joined by a Docker Swarm overlay network, and
the Mac that hosts them and serves the LLM.

Usage: python3 testbed_diagram.py --out <dir>
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch  # noqa: E402

MACHINES = [
    ("M1", "VM, 3 vCPU, 6 GB", ["orderer1 (Raft)", "Police peer", "CouchDB", "Police CA", "Orderer CA",
                                 "chaincode", "node-exporter"]),
    ("M2", "VM, 3 vCPU, 6 GB", ["orderer2 (Raft)", "Forensics peer", "Prosecution peer", "2 x CouchDB", "2 x CA",
                                 "2 x chaincode", "node-exporter"]),
    ("M3", "VM, 3 vCPU, 6 GB", ["orderer3 (Raft)", "Court peer", "Audit peer", "2 x CouchDB", "2 x CA",
                                 "2 x chaincode", "node-exporter"]),
    ("M4", "VM, 3 vCPU, 6 GB", ["DIAS backend (API)", "review store (off-chain)", "load generator",
                                 "Prometheus", "node-exporter"]),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    fig, ax = figstyle.figure(width=figstyle.DOUBLE_WIDTH_IN, height=2.55)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 44)
    ax.axis("off")
    # Host (the Mac) around everything.
    ax.add_patch(FancyBboxPatch((0.5, 0.8), 99, 42.2, boxstyle="round,pad=0.2,rounding_size=1.2",
                                facecolor="#f4f3ef", edgecolor=figstyle.INK_2, linewidth=0.8))
    ax.text(1.8, 41.2, "Apple M3 Max host (16 cores, 64 GB)", fontsize=7, color=figstyle.INK, va="top", weight="bold")
    width, gap, x0, top = 16.4, 1.5, 2.0, 37.6
    for i, (name, spec, services) in enumerate(MACHINES):
        x = x0 + i * (width + gap)
        ax.add_patch(FancyBboxPatch((x, 10.0), width, top - 10.0, boxstyle="round,pad=0.15,rounding_size=0.8",
                                    facecolor="white", edgecolor=figstyle.SERIES[i], linewidth=1.3))
        ax.text(x + 0.9, top - 0.9, name, fontsize=7.5, weight="bold", color=figstyle.INK, va="top")
        ax.text(x + 0.9, top - 3.6, spec, fontsize=5.8, color=figstyle.INK_2, va="top")
        for j, service in enumerate(services):
            ax.text(x + 1.4, top - 7.2 - j * 2.75, f"- {service}", fontsize=5.9, color=figstyle.INK, va="top")
    # Overlay network band.
    ax.add_patch(FancyBboxPatch((x0, 3.2), 4 * width + 3 * gap, 4.2, boxstyle="round,pad=0.1,rounding_size=0.6",
                                facecolor="#e7f0fb", edgecolor=figstyle.SERIES[0], linewidth=0.8))
    ax.text(x0 + (4 * width + 3 * gap) / 2, 5.3, "Docker Swarm overlay network 'diasnet' (Lima user-v2 links, TLS)",
            fontsize=6.2, ha="center", va="center", color=figstyle.INK)
    for i in range(4):
        x = x0 + i * (width + gap) + width / 2
        ax.add_patch(FancyArrowPatch((x, 10.0), (x, 7.4), arrowstyle="-", linewidth=0.9, color=figstyle.SERIES[0]))
    # The Mac-side model server.
    mx = x0 + 4 * width + 3 * gap + 7.0
    ax.add_patch(FancyBboxPatch((mx, 10.0), 100 - mx - 2.0, top - 10.0, boxstyle="round,pad=0.15,rounding_size=0.8",
                                facecolor="white", edgecolor=figstyle.SERIES[4], linewidth=1.3))
    ax.text(mx + 0.9, top - 0.9, "M5", fontsize=7.5, weight="bold", color=figstyle.INK, va="top")
    ax.text(mx + 0.9, top - 3.6, "the Mac itself (GPU)", fontsize=5.8, color=figstyle.INK_2, va="top")
    for j, service in enumerate(["MLX model server", "Qwen3-14B 4-bit", "+ V7 LoRA adapter", "one request", "at a time"]):
        ax.text(mx + 1.4, top - 7.2 - j * 2.75, f"{'- ' if j < 3 else '  '}{service}", fontsize=5.9, color=figstyle.INK, va="top")
    # Backend -> LLM call.
    bx = x0 + 3 * (width + gap) + width
    ax.add_patch(FancyArrowPatch((bx, 16.0), (mx, 16.0), arrowstyle="-|>", mutation_scale=7, linewidth=0.9,
                                 color=figstyle.SERIES[4]))
    ax.text((bx + mx) / 2, 17.0, "LLM call", fontsize=5.4, ha="center", va="bottom", color=figstyle.INK_2)
    ax.text((bx + mx) / 2, 15.0, "(HTTP)", fontsize=5.4, ha="center", va="top", color=figstyle.INK_2)
    figstyle.save(fig, os.path.join(args.out, "testbed_layout"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
