#!/usr/bin/env python3
"""Compare a rebuilt analysis directory with the archived one.

Tables (.json, .csv) and logs are compared byte for byte, then after
normalising line endings, then as parsed JSON (numbers to 1e-9 relative
tolerance; keys present only in the rebuilt file are listed, since later
versions of the scripts add provenance fields). Figures (.pdf, .png) must exist;
their bytes are not compared, because the files embed creation metadata.

    python3 testbed/analysis/compare_archived.py --archived <dir> --rebuilt <dir>
"""

import argparse
import json
import math
import os
import sys

TABLES = (".json", ".csv", ".log")
FIGURES = (".pdf", ".png")


def files(root):
    for base, _dirs, names in os.walk(root):
        for name in names:
            yield os.path.relpath(os.path.join(base, name), root)


def added_keys(archived, rebuilt, path=""):
    """Keys the rebuilt JSON has and the archived one lacks, if that is the only difference."""
    if isinstance(archived, dict) and isinstance(rebuilt, dict):
        if not set(archived) <= set(rebuilt):
            return None
        extra = [f"{path}/{key}" for key in sorted(set(rebuilt) - set(archived))]
        for key in archived:
            inner = added_keys(archived[key], rebuilt[key], f"{path}/{key}")
            if inner is None:
                return None
            extra += inner
        return extra
    return [] if same_json(archived, rebuilt) else None


def same_json(left, right):
    if isinstance(left, float) or isinstance(right, float):
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            return math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-12)
        return False
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same_json(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archived", required=True)
    parser.add_argument("--rebuilt", required=True)
    args = parser.parse_args()
    result = {"identical": [], "same_after_line_endings": [], "numerically_equal": [],
              "equal_except_added_fields": [], "different": [], "missing": [], "figures_present": [], "figures_missing": []}
    for relative in sorted(files(args.archived)):
        archived = os.path.join(args.archived, relative)
        rebuilt = os.path.join(args.rebuilt, relative)
        if relative.endswith(FIGURES):
            result["figures_present" if os.path.exists(rebuilt) else "figures_missing"].append(relative)
            continue
        if not relative.endswith(TABLES):
            continue
        if not os.path.exists(rebuilt):
            result["missing"].append(relative)
            continue
        with open(archived, "rb") as a, open(rebuilt, "rb") as b:
            left, right = a.read(), b.read()
        if left == right:
            result["identical"].append(relative)
            continue
        if left.replace(b"\r\n", b"\n") == right.replace(b"\r\n", b"\n"):
            result["same_after_line_endings"].append(relative)
            continue
        if relative.endswith(".json"):
            try:
                archived_json, rebuilt_json = json.loads(left), json.loads(right)
            except ValueError:
                archived_json = rebuilt_json = None
            if archived_json is not None:
                if same_json(archived_json, rebuilt_json):
                    result["numerically_equal"].append(relative)
                    continue
                extra = added_keys(archived_json, rebuilt_json)
                if extra:
                    result["equal_except_added_fields"].append(f"{relative} (added: {', '.join(extra)})")
                    continue
        result["different"].append(relative)
    for key, items in result.items():
        print(f"{key}: {len(items)}")
        if key in ("different", "missing", "figures_missing", "equal_except_added_fields"):
            for item in items:
                print(f"  {item}")
    with open(os.path.join(args.rebuilt, "comparison.json"), "w") as handle:
        json.dump(result, handle, indent=2)
    return 1 if result["different"] or result["missing"] or result["figures_missing"] else 0


if __name__ == "__main__":
    sys.exit(main())
