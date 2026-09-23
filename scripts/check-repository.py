#!/usr/bin/env python3
"""Fail when the Git publication surface contains secrets or local state.

The check inspects tracked files plus untracked, non-ignored files. That makes it
useful both in CI and before this repository's first commit.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
MAX_GITHUB_FILE_BYTES = 50 * 1024 * 1024
MAX_CONTENT_SCAN_BYTES = 2 * 1024 * 1024

FORBIDDEN_PATHS = (
    re.compile(r"(^|/)node_modules/"),
    re.compile(r"(^|/)coverage/"),
    re.compile(r"(^|/)\.nyc_output/"),
    re.compile(r"^network/organizations/"),
    re.compile(r"^network/channel-artifacts/"),
    re.compile(r"^backend/(data|wallets)/"),
    re.compile(r"^benchmarks/caliper/generated/"),
    re.compile(r"(^|/)(tmp|verify-build[^/]*)/"),
    re.compile(r"(^|/)\.DS_Store$"),
    re.compile(r"\.(?:sqlite(?:-.+)?|db|pem|key|p12|pfx)$", re.IGNORECASE),
    re.compile(r"(^|/)[^/]*_sk$"),
)

SECRET_CONTENT = (
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("AWS access key", re.compile(rb"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("Slack token", re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("OpenAI-style key", re.compile(rb"\bsk-[A-Za-z0-9]{32,}\b")),
)


def publication_files() -> list[str]:
    command = [
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ]
    result = subprocess.run(command, cwd=ROOT, check=True, capture_output=True)
    return sorted(path for path in result.stdout.decode().split("\0") if path)


def forbidden_path(path: str) -> bool:
    # Versioned configuration templates are publication inputs, including a
    # component-local template. Only real or suffixed environment files are
    # local state.
    if path == ".env.example" or path.endswith("/.env.example"):
        return False
    if path == ".env" or path.startswith(".env.") or "/.env" in path:
        return True
    return any(pattern.search(path) for pattern in FORBIDDEN_PATHS)


def main() -> int:
    try:
        paths = publication_files()
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"repository check failed to list Git files: {exc}", file=sys.stderr)
        return 2

    violations: list[str] = []
    total_bytes = 0

    for relative in paths:
        # Git paths always use POSIX separators. Reject traversal defensively.
        if ".." in PurePosixPath(relative).parts:
            violations.append(f"unsafe path: {relative}")
            continue
        if forbidden_path(relative):
            violations.append(f"local/generated path: {relative}")
            continue

        candidate = ROOT / relative
        if not candidate.is_file():
            continue
        size = candidate.stat().st_size
        total_bytes += size
        if size > MAX_GITHUB_FILE_BYTES:
            violations.append(
                f"oversized file ({size / 1024 / 1024:.1f} MiB): {relative}"
            )
            continue
        if size > MAX_CONTENT_SCAN_BYTES:
            continue

        data = candidate.read_bytes()
        if b"\0" in data[:8192]:
            continue
        for label, pattern in SECRET_CONTENT:
            if pattern.search(data):
                violations.append(f"possible {label}: {relative}")

    if violations:
        print("Repository publication check failed:", file=sys.stderr)
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1

    print(
        "Repository publication check passed: "
        f"{len(paths)} files, {total_bytes / 1024 / 1024:.1f} MiB."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
