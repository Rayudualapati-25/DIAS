#!/usr/bin/env python3
"""Run MLX-LM training while retaining command, environment, and complete logs."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        default="experiments/llm_policy_engine/train_config.yaml",
    )
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--iters", type=int)
    parser.add_argument("--adapter-path")
    return parser.parse_args()


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def huggingface_revision(model: str) -> str | None:
    cache_name = f"models--{model.replace('/', '--')}"
    reference = Path.home() / ".cache" / "huggingface" / "hub" / cache_name / "refs" / "main"
    return reference.read_text().strip() if reference.is_file() else None


def main() -> int:
    args = parse_args()
    config = (ROOT / args.config).resolve()
    run_dir = (ROOT / args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    config_values = yaml.safe_load(config.read_text())
    data_dir = (ROOT / config_values["data"]).resolve()
    dataset_paths = {
        path.stem: path
        for path in data_dir.glob("*.jsonl")
        if path.is_file()
    }

    command = [
        sys.executable,
        "-m",
        "mlx_lm",
        "lora",
        "--config",
        str(config),
    ]
    if args.iters is not None:
        command.extend(["--iters", str(args.iters)])
    if args.adapter_path:
        adapter_path = (ROOT / args.adapter_path).resolve()
        command.extend(["--adapter-path", str(adapter_path)])

    started = datetime.now(timezone.utc)
    metadata = {
        "status": "running",
        "startedAtUtc": started.isoformat(),
        "command": command,
        "workingDirectory": str(ROOT),
        "config": relative(config),
        "configSha256": sha256(config),
        "baseModel": config_values["model"],
        "baseModelRevision": huggingface_revision(config_values["model"]),
        "datasetDirectory": relative(data_dir),
        "datasetHashes": {
            split: sha256(path)
            for split, path in sorted(dataset_paths.items())
        },
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": sys.version,
            "packages": {
                name: importlib.metadata.version(name)
                for name in ("mlx", "mlx-lm", "transformers")
            },
        },
    }
    metadata_path = run_dir / "run.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")

    started_monotonic = time.monotonic()
    with (run_dir / "training.log").open("w", buffering=1) as log:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            log.write(line)
        exit_code = process.wait()

    metadata.update(
        {
            "status": "completed" if exit_code == 0 else "failed",
            "exitCode": exit_code,
            "finishedAtUtc": datetime.now(timezone.utc).isoformat(),
            "durationSeconds": round(time.monotonic() - started_monotonic, 3),
        }
    )
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
