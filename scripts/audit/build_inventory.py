#!/usr/bin/env python3
"""Build the repository inventory used by the publication-readiness audit.

The script is read-only with respect to the repository: it walks the working
tree, reads Git state, hashes files, finds textual references between files and
applies the ordered classification rules in ``inventory_rules.py``. It writes

* ``reports/repository_audit/repository_inventory.csv``  (one row per item)
* ``reports/repository_audit/repository_inventory_summary.json``

Dependency trees, virtual environments and Python caches are collapsed into a
single row each, because their individual files carry no research meaning.

Usage::

    python3 scripts/audit/build_inventory.py [--out-dir reports/repository_audit]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inventory_rules import RULES, COLLAPSE_DIR_NAMES, COLLAPSE_PREFIXES  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TEXT_SUFFIXES = {
    ".md", ".tex", ".bib", ".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".json",
    ".yaml", ".yml", ".txt", ".csv", ".html", ".css", ".cff", ".toml", ".cfg",
    ".ini", ".drawio", ".svg", ".jsonl", ".log", ".env", ".example", "",
}
MAX_TEXT_BYTES = 3 * 1024 * 1024
COMMON_BASENAMES = {
    "readme.md", "index.js", "metrics.json", "run.json", "config.json",
    "package.json", "package-lock.json", "main.tex", "server.log", "results.json",
    "summary.json", "manifest.json", "evaluation.log", "training.log", "chain.log",
    "run-report.json", "report.json", "notes.md", "license", "makefile",
    ".gitignore", ".ds_store", "requests.jsonl", "acceptance.json", "raw.json",
    "summary.csv", "report.html", "monitor.json", "caliper.log", "benchmark.yaml",
    "network.yaml", "run-manifest.json", "manifest.csv", "abstract.tex",
    "results.tex", "conclusion.tex", "introduction.tex", "methodology.tex",
    "implementation.tex", "common.js", "api.js", "vocab.js", "access.js",
}
PATH_TOKEN = re.compile(r"[A-Za-z0-9_@+~:.\-/]+")


def git_lines(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True)
    return [p for p in out.stdout.decode("utf-8", "surrogateescape").split("\0") if p]


def git_state() -> tuple[set[str], dict[str, str], set[str]]:
    tracked = set(git_lines("ls-files", "-z"))
    status: dict[str, str] = {}
    raw = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout.decode("utf-8", "surrogateescape").split("\0")
    ignored: set[str] = set()
    for entry in raw:
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        if code == "!!":
            ignored.add(path.rstrip("/"))
        else:
            status[path] = code
    return tracked, status, ignored


def is_ignored(rel: str, ignored: set[str]) -> bool:
    parts = rel.split("/")
    return any("/".join(parts[:i]) in ignored for i in range(1, len(parts) + 1))


def classify(rel: str) -> dict[str, str]:
    for rule in RULES:
        if re.search(rule["pattern"], rel):
            return rule
    return {
        "role": "unknown", "classification": "unclassified",
        "action": "review", "confidence": "low", "notes": "no rule matched",
    }


def collapse_root(rel: str) -> str | None:
    for prefix in COLLAPSE_PREFIXES:
        if rel == prefix or rel.startswith(prefix + "/"):
            return prefix
    parts = rel.split("/")
    for i, part in enumerate(parts[:-1]):
        if part in COLLAPSE_DIR_NAMES:
            return "/".join(parts[: i + 1])
    return None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def walk() -> tuple[dict[str, dict], dict[str, dict]]:
    files: dict[str, dict] = {}
    collapsed: dict[str, dict] = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel_dir = os.path.relpath(dirpath, ROOT)
        rel_dir = "" if rel_dir == "." else rel_dir
        if rel_dir == ".git" or rel_dir.startswith(".git/"):
            dirnames[:] = []
            continue
        if rel_dir == "":
            dirnames[:] = [d for d in dirnames if d != ".git"]
        for name in filenames:
            rel = f"{rel_dir}/{name}" if rel_dir else name
            full = ROOT / rel
            try:
                st = full.lstat()
            except FileNotFoundError:
                continue
            root = collapse_root(rel)
            if root is not None:
                agg = collapsed.setdefault(root, {"size": 0, "count": 0})
                agg["size"] += st.st_size
                agg["count"] += 1
                continue
            kind = "symlink" if full.is_symlink() else "file"
            files[rel] = {"size": st.st_size, "type": kind}
    return files, collapsed


def build_reference_index(files: dict[str, dict]) -> tuple[dict[str, set[str]], dict[str, str]]:
    """Map path-like tokens to the text files that contain them."""
    token_index: dict[str, set[str]] = defaultdict(set)
    corpus: dict[str, str] = {}
    for rel, meta in files.items():
        suffix = Path(rel).suffix.lower()
        if meta["type"] != "file" or meta["size"] > MAX_TEXT_BYTES:
            continue
        if suffix not in TEXT_SUFFIXES:
            continue
        try:
            text = (ROOT / rel).read_text("utf-8", errors="ignore")
        except OSError:
            continue
        corpus[rel] = text
        for token in set(PATH_TOKEN.findall(text)):
            token = token.strip("./:")
            if token:
                token_index[token].add(rel)
                token_index[token.rsplit("/", 1)[-1]].add(rel)
    return token_index, corpus


def references_for(rel: str, token_index, corpus, basename_counts) -> set[str]:
    refs: set[str] = set()
    base = rel.rsplit("/", 1)[-1]
    candidates = {rel}
    parts = rel.split("/")
    # the path as written relative to any ancestor directory
    for i in range(1, len(parts)):
        candidates.add("/".join(parts[i:]))
    distinctive = (
        base.lower() not in COMMON_BASENAMES and basename_counts[base] == 1 and len(base) >= 8
    )
    if " " in rel or "(" in rel:
        for other, text in corpus.items():
            if rel in text or (distinctive and base in text):
                refs.add(other)
    else:
        for cand in candidates:
            if "/" in cand or distinctive:
                refs |= token_index.get(cand, set())
        if distinctive:
            refs |= token_index.get(base, set())
    refs.discard(rel)
    return refs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", default="reports/repository_audit")
    args = parser.parse_args()
    out_dir = ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    tracked, status, ignored = git_state()
    files, collapsed = walk()
    token_index, corpus = build_reference_index(files)
    basename_counts = Counter(rel.rsplit("/", 1)[-1] for rel in files)

    hashes: dict[str, str] = {}
    for rel, meta in files.items():
        if meta["type"] == "file":
            hashes[rel] = sha256(ROOT / rel)
    by_hash: dict[str, list[str]] = defaultdict(list)
    for rel, digest in hashes.items():
        if files[rel]["size"] > 0:
            by_hash[digest].append(rel)

    rows = []

    def git_label(rel: str) -> str:
        code = status.get(rel)
        if code is not None:
            return {"??": "untracked", " M": "modified", "M ": "staged-modified",
                    "MM": "modified", "D ": "staged-deleted", " D": "deleted",
                    "A ": "staged-added", "R ": "staged-renamed"}.get(code, code.strip())
        if rel in tracked:
            return "tracked-clean"
        if is_ignored(rel, ignored):
            return "ignored"
        return "untracked"

    for rel in sorted(files):
        meta = files[rel]
        rule = classify(rel)
        refs = references_for(rel, token_index, corpus, basename_counts)
        dupes = [p for p in by_hash.get(hashes.get(rel, ""), []) if p != rel]
        notes = rule["notes"]
        if dupes:
            notes = (notes + "; " if notes else "") + f"identical content: {'; '.join(sorted(dupes)[:4])}" + (
                f" (+{len(dupes) - 4} more)" if len(dupes) > 4 else "")
        rows.append({
            "path": rel,
            "type": meta["type"],
            "size_bytes": meta["size"],
            "git_status": git_label(rel),
            "sha256": hashes.get(rel, ""),
            "referenced_by_count": len(refs),
            "referenced_by": "; ".join(sorted(refs)[:6]) + (f" (+{len(refs) - 6} more)" if len(refs) > 6 else ""),
            "likely_role": rule["role"],
            "classification": rule["classification"],
            "proposed_action": rule["action"],
            "confidence": rule["confidence"],
            "notes": notes,
        })

    for root, agg in sorted(collapsed.items()):
        rule = classify(root + "/")
        rows.append({
            "path": root + "/",
            "type": f"directory (collapsed, {agg['count']} files)",
            "size_bytes": agg["size"],
            "git_status": "ignored" if is_ignored(root, ignored) else ("tracked" if any(t.startswith(root + "/") for t in tracked) else "untracked"),
            "sha256": "",
            "referenced_by_count": "",
            "referenced_by": "",
            "likely_role": rule["role"],
            "classification": rule["classification"],
            "proposed_action": rule["action"],
            "confidence": rule["confidence"],
            "notes": rule["notes"],
        })

    for rel, code in sorted(status.items()):
        if code.strip() == "D" and rel not in files:
            rule = classify(rel)
            rows.append({
                "path": rel, "type": "deleted from working tree", "size_bytes": 0,
                "git_status": "staged-deleted" if code == "D " else "deleted",
                "sha256": "", "referenced_by_count": "", "referenced_by": "",
                "likely_role": "retired AI-organization component",
                "classification": "intentional-deletion",
                "proposed_action": "none (recoverable from HEAD; deletion matches the 2026-09-15 backend-LLM redesign)",
                "confidence": "high",
                "notes": "Staged deletion in the index; see reports/iteration/iter_046_dias_backend_llm.md",
            })

    fieldnames = list(rows[0].keys())
    with (out_dir / "repository_inventory.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    dup_groups = [sorted(v) for v in by_hash.values() if len(v) > 1]
    summary = {
        "root": str(ROOT),
        "rows": len(rows),
        "files_listed": len(files),
        "collapsed_directories": {k + "/": v for k, v in sorted(collapsed.items())},
        "by_git_status": Counter(r["git_status"] for r in rows),
        "by_classification": Counter(r["classification"] for r in rows),
        "by_action": Counter(r["proposed_action"].split(" ")[0] for r in rows),
        "large_files_over_10MiB": sorted(
            [(r["path"], r["size_bytes"]) for r in rows if isinstance(r["size_bytes"], int) and r["size_bytes"] > 10 * 1024 * 1024],
            key=lambda x: -x[1]),
        "duplicate_groups": len(dup_groups),
        "duplicate_files": sum(len(g) for g in dup_groups),
        "duplicate_groups_detail": sorted(dup_groups, key=lambda g: -len(g))[:400],
        "symlinks": [r["path"] for r in rows if r["type"] == "symlink"],
    }
    (out_dir / "repository_inventory_summary.json").write_text(json.dumps(summary, indent=2, default=list) + "\n")
    print(f"wrote {len(rows)} rows to {out_dir / 'repository_inventory.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
