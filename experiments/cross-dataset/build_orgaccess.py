#!/usr/bin/env python3
"""
Build a DIAS-comparable evaluation sample from the public OrgAccess benchmark
(respai-lab/orgaccess, MIT licence; Sanyal et al., arXiv:2505.19165).

Findings that drive the design, measured on the downloaded splits:
  easy   40282 rows: full 13304 / partial 13473 / rejected 13253  (usable)
  medium 10073 rows: full 3    -> ALLOW class absent
  hard   20148 rows: full 30   -> ALLOW class absent
Only `easy` supports a balanced ALLOW/DENY score, so it is the headline split.
A small `hard` slice is also emitted for a difficulty check, scored on the
subset that has a usable label only.

`partial` means granted-but-restricted. DIAS emits a binary ALLOW/DENY, so the
mapping is a judgement call: the primary sample therefore excludes `partial`
(full -> ALLOW, rejected -> DENY) and a separate partial-only sample lets the
same predictions be rescored under partial->ALLOW and partial->DENY.
"""
import json, random, collections, os

SEED = 20260924
CLEAN = {"full": "ALLOW", "rejected": "DENY"}

def load(split):
    p = f"experiments/cross-dataset/orgaccess/{split}.jsonl"
    return [json.loads(l) for l in open(p) if l.strip()]

def emit(rows, out, tag):
    with open(out, "w") as f:
        for i, r in enumerate(rows, 1):
            raw = r["expected_response"]
            f.write(json.dumps({
                "exampleId": f"ORG-{tag}-{i:05d}",
                "scenario": r["user_role"],
                "justificationKind": "benign",
                "user_role": r["user_role"],
                "permissions": r["permissions"],
                "query": r["query"],
                "_expected": CLEAN.get(raw),          # None for partial
                "_expectedRaw": raw,
                "referenceRationale": r.get("rationale"),
            }) + "\n")
    print(f"wrote {len(rows):4d} -> {out}")

def main():
    rng = random.Random(SEED)
    os.makedirs("experiments/cross-dataset/orgaccess", exist_ok=True)
    easy = load("easy")
    by = collections.defaultdict(list)
    for r in easy: by[r["expected_response"]].append(r)
    for k in ("full", "rejected", "partial"): rng.shuffle(by[k])

    N = 100
    primary = by["full"][:N] + by["rejected"][:N]
    rng.shuffle(primary)
    emit(primary, "experiments/cross-dataset/orgaccess/easy-binary.cases.jsonl", "EB")

    part = by["partial"][:60]
    emit(part, "experiments/cross-dataset/orgaccess/easy-partial.cases.jsonl", "EP")

    hard = load("hard")
    hby = collections.defaultdict(list)
    for r in hard: hby[r["expected_response"]].append(r)
    for k in hby: rng.shuffle(hby[k])
    hs = hby["full"][:30] + hby["rejected"][:30]
    rng.shuffle(hs)
    emit(hs, "experiments/cross-dataset/orgaccess/hard-binary.cases.jsonl", "HB")
    print("hard slice labels:", collections.Counter(r["expected_response"] for r in hs))

if __name__ == "__main__":
    main()
