#!/usr/bin/env python3
"""V7 validation loss during training, read from the MLX-LM training log.

The log has a "Iter N: Val loss X" line at iteration 1 (before the first
update), every 250 iterations, and at the last iteration. The plot shows the
scheduled values from iteration 250 on and ends with the final value; the
iteration-1 value (1.423) is left out so the later values stay readable, and
the paper text reports it.

Usage: python3 v7_validation_loss.py --log <training.log> --out <path without extension>
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figstyle  # noqa: E402

VAL_LINE = re.compile(r"Iter (\d+): Val loss ([0-9.]+)")
EVAL_EVERY = 250  # steps_per_eval in train-v7.yaml
Y_MAX = 0.03


def read_losses(path: str) -> list[tuple[int, float]]:
    with open(path, errors="replace") as handle:
        points = [(int(m[1]), float(m[2])) for m in VAL_LINE.finditer(handle.read())]
    if not points:
        raise SystemExit(f"no validation loss lines in {path}")
    return points


def plotted_points(points: list[tuple[int, float]]) -> list[tuple[int, float]]:
    """Scheduled validations from iteration 250 on, then the final one.

    The scheduled value just before the end (iteration 5,250) is dropped because
    the final value (iteration 5,254) sits on top of it.
    """
    final = points[-1]
    scheduled = [p for p in points if p[0] % EVAL_EVERY == 0 and final[0] - p[0] >= EVAL_EVERY]
    return scheduled + [final]


def plot(points: list[tuple[int, float]], out: str) -> None:
    shown = plotted_points(points)
    if max(loss for _, loss in shown) > Y_MAX:
        raise SystemExit(f"a plotted loss exceeds the {Y_MAX} axis limit; widen Y_MAX")
    iterations = [it for it, _ in shown]
    losses = [loss for _, loss in shown]
    fig, ax = figstyle.figure(height=1.5)
    ax.plot(iterations, losses, color=figstyle.SERIES[0], linewidth=1.1, marker="o", markersize=2.6)
    ax.annotate(f"Final {losses[-1]:.3f}", (iterations[-1], losses[-1]), xytext=(4, 0),
                textcoords="offset points", va="center", fontsize=6.5, color=figstyle.INK)
    ax.set_xlim(0, iterations[-1] * 1.12)
    ax.set_ylim(0, Y_MAX)
    ax.set_yticks([0, 0.01, 0.02, 0.03])
    ax.set_yticklabels(["0.00", "0.01", "0.02", "0.03"])
    ax.set_xticks(range(0, iterations[-1] + 1, 1000))
    ax.set_xticklabels([f"{x:,}" for x in range(0, iterations[-1] + 1, 1000)])
    ax.set_xlabel("Training iteration (one example each)")
    ax.set_ylabel("Validation loss")
    figstyle.save(fig, out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    points = read_losses(args.log)
    plot(points, args.out)
    for it, loss in points:
        print(f"iteration {it:>5}: {loss:.3f}")


if __name__ == "__main__":
    main()
