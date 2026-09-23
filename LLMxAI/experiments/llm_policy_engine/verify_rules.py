#!/usr/bin/env python3
"""Per-rule verification for the SEBA-XAI LLM policy engine.
Answers: does every one of the 8 rules / 12 reason codes actually work?"""
import json, sys, collections

# reason code -> (rule label, ordinal position in the ladder)
RULE = {
 "CRED_NOT_ACTIVE":("1  credential",1), "INVALID_PURPOSE":("2  purpose",2),
 "RBAC_NO_PERMISSION":("3  RBAC",3),    "AUDIT_METADATA_ONLY":("3b audit",4),
 "SEALED_RECORD":("4  sealed",5),       "JUVENILE_PROTECTED":("5  juvenile",6),
 "VICTIM_DATA_NOT_NECESSARY":("5b victim",7),
 "EMERGENCY_CROSS_JURISDICTION":("6a emergency",8), "CROSS_JURISDICTION":("6b jurisdiction",8),
 "NOT_ASSIGNED":("7  assignment",9),    "INSUFFICIENT_CLEARANCE":("8  clearance",10),
 "POLICY_SATISFIED":("-- default",11),
}
DEC = ["allow","deny","escalate"]

def load(p): return json.load(open(p))

def analyze(path, label):
    d = load(path); rows = d["rows"]; m = d["metrics"]
    print(f"\n{'='*78}\n{label}   (n={len(rows)})\n{'='*78}")

    # ---- output-contract compliance ----
    probs = collections.Counter()
    for r in rows:
        for p in r["schemaProblems"]: probs[p] += 1
    ok = sum(1 for r in rows if not r["schemaProblems"])
    print(f"\nOUTPUT CONTRACT   valid {ok}/{len(rows)} ({ok/len(rows):.1%})")
    for p, c in probs.most_common():
        print(f"   {c:4d}  {p}")

    # ---- 3x3 decision confusion ----
    print(f"\nDECISION CONFUSION  (rows=truth, cols=predicted)")
    print(f"   {'truth':<10}" + "".join(f"{c:>10}" for c in DEC) + f"{'none':>8}{'recall':>9}")
    for t in DEC:
        sub = [r for r in rows if r["expected"]["decision"] == t]
        cells = []
        for c in DEC:
            cells.append(sum(1 for r in sub if (r.get("classification") or {}).get("decision") == c))
        none = sum(1 for r in sub if not (r.get("classification") or {}).get("decision") in DEC)
        rec = cells[DEC.index(t)]/len(sub) if sub else 0
        print(f"   {t:<10}" + "".join(f"{v:>10}" for v in cells) + f"{none:>8}{rec:>9.2%}")

    # ---- per rule ----
    print(f"\nPER-RULE VERIFICATION")
    print(f"   {'rule':<16}{'code':<30}{'n':>4}{'dec':>7}{'reason':>8}{'joint':>8}")
    order = sorted(RULE.items(), key=lambda kv: (kv[1][1], kv[0]))
    broken = []
    for code,(lab,_) in order:
        sub=[r for r in rows if r["expected"]["reasonCode"]==code]
        if not sub: continue
        dc=sum(r["decisionCorrect"] for r in sub)/len(sub)
        rc=sum(r["reasonCorrect"] for r in sub)/len(sub)
        jc=sum(r["jointCorrect"] for r in sub)/len(sub)
        flag=" <-- BROKEN" if jc==0 else ("  <-- weak" if jc<0.6 else "")
        if jc<0.6: broken.append((lab,code,jc))
        print(f"   {lab:<16}{code:<30}{len(sub):>4}{dc:>7.0%}{rc:>8.0%}{jc:>8.0%}{flag}")

    # ---- rule-order violations ----
    over=under=0
    for r in rows:
        e=RULE.get(r["expected"]["reasonCode"],(None,99))[1]
        pc=(r.get("classification") or {}).get("reasonCode")
        p=RULE.get(pc,(None,None))[1]
        if p is None: continue
        if p<e: over+=1
        elif p>e: under+=1
    print(f"\nRULE-ORDER ERRORS   fired-too-early {over}   missed-first-firing {under}")

    # ---- adversarial split ----
    for name,sel in (("clean",False),("adversarial",True)):
        sub=[r for r in rows if bool(r["adversarial"])==sel]
        if sub:
            print(f"{name:<12} n={len(sub):<4} decision={sum(r['decisionCorrect'] for r in sub)/len(sub):.1%}"
                  f"  joint={sum(r['jointCorrect'] for r in sub)/len(sub):.1%}")

    # ---- safety ----
    na=[r for r in rows if r["expected"]["decision"]!="allow"]
    fa=[r for r in na if (r.get("classification") or {}).get("decision")=="allow"]
    print(f"\nSAFETY   false allows {len(fa)}/{len(na)} ({len(fa)/len(na):.1%})")
    for r in fa[:6]:
        print(f"   {r['id']}  truth={r['expected']['reasonCode']} -> pred={(r.get('classification') or {}).get('reasonCode')}")
    return broken

if __name__ == "__main__":
    for path,label in [tuple(a.split("=",1)) for a in sys.argv[1:]]:
        analyze(label, path) if False else analyze(path, label)
