#!/usr/bin/env python3
"""Check that nothing depends on a path before it is moved to archive/.

For each candidate (a file or a directory), every tracked text file outside the
candidate is searched for the candidate's path and, for files, for its file
name. Each hit is classified:

  dependency  code, configuration, Makefile, tests or a current document
              (README.md, docs/, AGENTS.md, CONTRIBUTING.md) refers to it;
  mention     a dated record (experiments/runs/, reports/, results/,
              papers/, the candidate's own siblings) mentions it.

A candidate may be archived only when it has no dependency. Mentions are listed
in archive/README.md with the old and new paths.

    python3 scripts/release/archive-dependency-check.py --out <report.json> <path> [<path> ...]
"""

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RECORDS = ("experiments/runs/", "reports/", "results/", "papers/", "LLMxAI/reports/", "LLMxAI/experiments/runs/")


def tracked():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p]


def inside(path, candidate):
    return path == candidate or path.startswith(candidate.rstrip("/") + "/")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("candidates", nargs="+")
    args = parser.parse_args()
    files = tracked()
    texts = {}
    for path in files:
        full = os.path.join(ROOT, path)
        try:
            with open(full, "rb") as handle:
                data = handle.read(64 * 1024 * 1024)
        except OSError:
            continue
        if b"\0" in data[:8192]:
            continue
        texts[path] = data
    report = {}
    for candidate in args.candidates:
        members = [p for p in files if inside(p, candidate)]
        needles = {candidate.rstrip("/").encode()}
        if len(members) == 1 and members[0] == candidate:
            needles.add(os.path.basename(candidate).encode())
        hits = []
        for path, data in texts.items():
            if inside(path, candidate) or path == args.out:
                continue
            found = [n.decode() for n in needles if n in data]
            if found:
                kind = "mention" if path.startswith(RECORDS) else "dependency"
                hits.append({"file": path, "kind": kind, "matched": sorted(found)})
        report[candidate] = {
            "files": len(members),
            "dependencies": [h for h in hits if h["kind"] == "dependency"],
            "mentions": [h for h in hits if h["kind"] == "mention"],
        }
        state = "BLOCKED" if report[candidate]["dependencies"] else "free"
        print(f"{state:8} {candidate}: {len(members)} files, "
              f"{len(report[candidate]['dependencies'])} dependencies, {len(report[candidate]['mentions'])} mentions")
        for hit in report[candidate]["dependencies"]:
            print(f"           dependency: {hit['file']} ({', '.join(hit['matched'])})")
    with open(os.path.join(ROOT, args.out), "w") as handle:
        json.dump(report, handle, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
