#!/usr/bin/env python3
"""Select and copy the lowest-validation-loss checkpoint from an MLX-LM run."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VAL_PATTERN = re.compile(r"Iter (\d+): Val loss ([0-9]+(?:\.[0-9]+)?)")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve(value: str) -> Path:
    candidate = Path(value)
    return candidate.resolve() if candidate.is_absolute() else (ROOT / candidate).resolve()


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--source-adapter-dir", required=True)
    parser.add_argument("--output-adapter-dir", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_dir = resolve(args.run_dir)
    source_dir = resolve(args.source_adapter_dir)
    output_dir = resolve(args.output_adapter_dir)
    training_log = run_dir / "training.log"
    if not training_log.is_file():
        raise FileNotFoundError(f"training log not found: {training_log}")

    candidates = []
    for iteration_text, loss_text in VAL_PATTERN.findall(training_log.read_text()):
        iteration = int(iteration_text)
        checkpoint = source_dir / f"{iteration:07d}_adapters.safetensors"
        if checkpoint.is_file():
            candidates.append(
                {
                    "iteration": iteration,
                    "validationLoss": float(loss_text),
                    "checkpoint": checkpoint,
                }
            )
    if not candidates:
        raise RuntimeError("no validation checkpoint pairs were found")

    selected = min(candidates, key=lambda item: (item["validationLoss"], item["iteration"]))
    config = source_dir / "adapter_config.json"
    if not config.is_file():
        raise FileNotFoundError(f"adapter config not found: {config}")

    output_dir.mkdir(parents=True, exist_ok=True)
    selected_adapter = output_dir / "adapters.safetensors"
    selected_config = output_dir / "adapter_config.json"
    shutil.copy2(selected["checkpoint"], selected_adapter)
    shutil.copy2(config, selected_config)

    report = {
        "selectedAtUtc": datetime.now(timezone.utc).isoformat(),
        "selectionCriterion": "minimum recorded validation loss; test data not consulted",
        "trainingRun": relative(run_dir),
        "sourceAdapterDirectory": relative(source_dir),
        "selectedIteration": selected["iteration"],
        "selectedValidationLoss": selected["validationLoss"],
        "selectedCheckpoint": relative(selected["checkpoint"]),
        "deploymentAdapter": relative(selected_adapter),
        "deploymentAdapterSha256": sha256(selected_adapter),
        "adapterConfig": relative(selected_config),
        "adapterConfigSha256": sha256(selected_config),
        "validationCheckpoints": [
            {
                "iteration": item["iteration"],
                "validationLoss": item["validationLoss"],
                "checkpoint": relative(item["checkpoint"]),
                "sha256": sha256(item["checkpoint"]),
            }
            for item in sorted(candidates, key=lambda item: item["iteration"])
        ],
    }
    report_path = output_dir / "selection.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
