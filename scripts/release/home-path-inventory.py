#!/usr/bin/env python3
"""List every tracked file that still contains an absolute home-directory path.

Scripts and configurations must not contain such paths
(scripts/check-repository.py enforces this). Recorded evidence keeps the paths
it was produced with and is never edited; this inventory documents it instead.

    python3 scripts/release/home-path-inventory.py --out docs/release/home-paths.csv

Only the user part of each path is counted, never printed: the CSV holds the
file, its evidence group, the number of occurrences and the distinct path roots
reduced to their first two components (for example /Users/<user>).
"""

from __future__ import annotations

import argparse
import csv
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOME_PATH = re.compile(rb"/(Users|home)/([A-Za-z][A-Za-z0-9._-]*)/")
GROUPS = (
    ("experiments/runs/", "run record or raw log"),
    ("LLMxAI/experiments/runs/", "training run record"),
    ("LLMxAI/experiments/llm_policy_engine/adapters/", "training output (adapter_config.json)"),
    ("results/", "derived result file from an earlier run"),
    ("reports/", "dated report"),
    ("paper-tests/results/", "historical evaluation output"),
    ("archive/", "archived legacy material (archive/README.md)"),
    ("SNAPSHOT.md", "provenance record of the repository copy"),
    ("experiments/llm_policy_engine/README.md", "provenance statement"),
)


def group_of(path: str) -> str:
    for prefix, label in GROUPS:
        if path.startswith(prefix):
            return label
    return "NOT ALLOWED: script, configuration or current document"


def tracked_files() -> list[str]:
    result = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True)
    return sorted(path for path in result.stdout.decode().split("\0") if path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = []
    for relative in tracked_files():
        path = ROOT / relative
        if not path.is_file() or relative == args.out:
            continue
        with path.open("rb") as handle:
            head = handle.read(8192)
            if b"\0" in head:
                continue
            data = head + handle.read()
        matches = HOME_PATH.findall(data)
        if not matches:
            continue
        roots = sorted({f"/{kind.decode()}/<user>" for kind, _user in matches})
        users = len({user for _kind, user in matches})
        rows.append([relative, group_of(relative), len(matches), users, " ".join(roots), path.stat().st_size])
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["file", "group", "occurrences", "distinct_users", "roots", "file_bytes"])
        writer.writerows(rows)
    bad = [row for row in rows if row[1].startswith("NOT ALLOWED")]
    print(f"{len(rows)} files with home-directory paths; {len(bad)} outside recorded evidence")
    for row in bad:
        print(f"  NOT ALLOWED: {row[0]}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
