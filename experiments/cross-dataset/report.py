#!/usr/bin/env python3
"""Render the cross-dataset comparison as a markdown report."""
import json, os
RUN = "experiments/runs/20260924_cross_dataset"
d = json.load(open(f"{RUN}/comparison.json"))
NAME = {"v7": "DIAS V7 (fine-tuned)", "base": "Qwen3-14B-4bit (untuned)"}
L = []
w = L.append

w("# DIAS cross-dataset comparison")
w("")
w(f"Generated {d['generatedAtUtc']} · run directory `{RUN}`")
w("")
w("## What was run")
w("")
w("Two models, identical prompt contract and decoding, on two access-control")
w("datasets from outside the DIAS crime-records domain.")
w("")
w("| | |")
w("|---|---|")
w("| Models | `qwen3-14b-dias-v7` (LoRA adapter) vs the same base model untuned |")
w("| Base model | `mlx-community/Qwen3-14B-4bit` |")
w("| Decoding | temperature 0, top_p 1, max_tokens 512, thinking disabled |")
w("| Prompt | production system prompt, lifted verbatim from `backend/src/dias/recommendationPrompt.js` |")
w("| Output contract | the same six-key JSON the paper evaluates |")
w("")

def block(sid, title, note):
    e = d["sets"].get(sid)
    if not e or "note" in e:
        w(f"## {title}"); w(""); w(f"_{(e or {}).get('note','not run')}_"); w(""); return
    w(f"## {title}")
    w("")
    w(note)
    w("")
    w(f"Compared on **{e['comparedOn']} examples** finished by both models.")
    w("")
    extra = "reasonCodeAccuracy" in e["v7"]
    hdr = "| Model | Decision acc. (95% CI) | Balanced acc. | Macro F1 | Schema valid | Unsafe ALLOW |"
    sep = "|---|---|---|---|---|---|"
    if extra:
        hdr += " Reason code | Policy refs |"; sep += "---|---|"
    w(hdr); w(sep)
    for m in ("v7", "base"):
        x = e[m]; ci = x["decisionAccuracyCI"]
        row = (f"| {NAME[m]} | {x['decisionAccuracy']:.3f} "
               f"[{ci['low']:.3f}, {ci['high']:.3f}] | {x['balancedAccuracy']:.3f} | "
               f"{x['macroF1']:.3f} | {x['schemaValidRate']:.3f} | {x['unsafeAllow']} |")
        if extra:
            row += f" {x['reasonCodeAccuracy']:.3f} | {x['policyRefExactAccuracy']:.3f} |"
        w(row)
    w("")
    w("Confusion counts (rows = ground truth, columns = model output):")
    w("")
    w("| Model | ALLOW→ALLOW | ALLOW→DENY | DENY→DENY | DENY→ALLOW | invalid |")
    w("|---|---|---|---|---|---|")
    for m in ("v7", "base"):
        c = e[m]["confusion"]
        inv = c["ALLOW"]["INVALID"] + c["DENY"]["INVALID"]
        w(f"| {NAME[m]} | {c['ALLOW']['ALLOW']} | {c['ALLOW']['DENY']} | "
          f"{c['DENY']['DENY']} | {c['DENY']['ALLOW']} | {inv} |")
    w("")
    if extra:
        w("### Benign vs adversarial justifications")
        w("")
        w("| Model | Benign acc. | Adversarial acc. | Unsafe ALLOW (benign) | Unsafe ALLOW (adversarial) |")
        w("|---|---|---|---|---|")
        for m in ("v7", "base"):
            x = e[m]
            b, a = x.get("benign"), x.get("adversarial")
            if b and a:
                w(f"| {NAME[m]} | {b['decisionAccuracy']:.3f} | {a['decisionAccuracy']:.3f} | "
                  f"{b['unsafeAllow']} | {a['unsafeAllow']} |")
        w("")
        w("### Per policy (decision accuracy)")
        w("")
        pols = sorted(e["v7"]["byPolicy"])
        w("| Policy | " + " | ".join(NAME[m] for m in ("v7", "base")) + " | n |")
        w("|---" * 4 + "|")
        for p in pols:
            v = e["v7"]["byPolicy"][p]; b = e["base"]["byPolicy"].get(p, {})
            w(f"| {p} | {v['decisionAccuracy']:.3f} | "
              f"{b.get('decisionAccuracy', float('nan')):.3f} | {v['n']} |")
        w("")

block("llmac", "1. LLMAC policy domain (reconstruction)",
      "LLMAC's own dataset is **not published** — the paper carries no data availability\n"
      "statement, repository or archive link. This set therefore re-implements the seven\n"
      "policies LLMAC prints in full in its Table II (a class management system, policies\n"
      "originally from Park, Nguyen & Sandhu 2012) as a deterministic oracle, and generates\n"
      "requests against it. **It is a reconstruction of the LLMAC policy domain, not LLMAC's\n"
      "data**, and no number here may be set against a number printed in the LLMAC paper.\n"
      "Reason codes are our addition: LLMAC records a binary decision plus free text, while\n"
      "the DIAS schema requires a code, so one code was defined per distinct Table II condition.")

block("org-easy-binary", "2. OrgAccess (public benchmark, easy split)",
      "`respai-lab/orgaccess` (MIT licence; Sanyal et al., arXiv:2505.19165), downloaded\n"
      "from HuggingFace. Ground truth is three-way (`full` / `partial` / `rejected`); this\n"
      "table uses the binary subset only, mapping `full`→ALLOW and `rejected`→DENY.")

e = d["sets"].get("org-easy-partial")
w("## 3. OrgAccess `partial` rows — the mapping question")
w("")
if not e or "note" in e:
    w(f"_{(e or {}).get('note','not run')}_")
else:
    w(f"`partial` means granted-but-restricted. DIAS emits a binary ALLOW/DENY, so how")
    w(f"`partial` is treated is a judgement call that moves the headline number. The same")
    w(f"{e['comparedOn']} predictions are rescored below under both readings.")
    w("")
    w("| Treatment | Model | Accuracy on partial rows |")
    w("|---|---|---|")
    for mapping, lab in (("partial_as_ALLOW", "counted as ALLOW"), ("partial_as_DENY", "counted as DENY")):
        for m in ("v7", "base"):
            w(f"| partial {lab} | {NAME[m]} | {e[mapping][m]['decisionAccuracy']:.3f} |")
w("")
open(f"{RUN}/COMPARISON.md", "w").write("\n".join(L) + "\n")
print(f"wrote {RUN}/COMPARISON.md ({len(L)} lines)")
