# Explanation quality: template vs local LLM

Generated 2026-08-06T17:08:21.620Z · model `llama3.2:3b` · 6 decisions covering 6 distinct policy rules.

## Scores

| Metric | Template only (no AI) | LLM arm (LLM + fallback) |
|---|---|---|
| Decisive-attribute coverage (mean) | 1 | 0.9167 |
| Full coverage rate | 1 | 0.8333 |
| Decision-label fidelity | 1 | 1 |
| Counterfactual mentioned | 1 | 0.6667 |
| Fell back to template (validator rejected) | n/a | 0.5 |
| Render latency p50 (ms) | 0 | 0 |

**Paper baseline for reference:** full coverage 0.781, mean coverage 0.931 (paper Section IV-E / results/tables/explanation_audit_quality_summary.csv).

## How to read this

The scoring rule is ported from `src/seba/xai_quality.py:117`, so the coverage
numbers are computed the same way as the paper's. Two honest caveats:

0. **The LLM arm measures what the user actually sees, not raw model quality.**
   When the validator rejects a generation the arm falls back to template
   wording, and that fallback text is what gets scored. At a fallback rate of
   0.5, a meaningful share of the LLM arm's score is template text.
   Read the per-scenario table's "LLM source" column to see which is which.
1. **The metric favours templates.** It rewards literally naming the decisive
   attributes, and a template can be written to name all of them every time.
   The Python source itself calls it "a weak textual proxy, not a human
   explanation-quality score." A template scoring higher than the LLM is the
   expected outcome, not a bug — it means fluency is not what this metric measures.
2. **Four attribute hints were added** that the paper's table lacks
   (subject.role, subject.clearance, object.recordType, subject.mspId), because the Fabric policy uses attributes the
   paper's synthetic schema did not have. Without them those attributes could
   never be scored as covered.

## Per-scenario detail

| Scenario | Decision | Template coverage | LLM coverage | LLM source |
|---|---|---|---|---|
| allow / assigned inspector | allow | 1 | 1 | llm |
| escalate / low clearance | escalate | 1 | 1 | template |
| deny / role has no permission | deny | 1 | 1 | llm |
| deny / revoked credential | deny | 1 | 1 | template |
| escalate / juvenile record | escalate | 1 | 1 | template |
| escalate / sealed record | escalate | 1 | 0.5 | llm |

## Example LLM output

**allow / assigned inspector** (allow)

> As an inspector with a high clearance and from the District-North jurisdiction, you have been granted access to view the case diary for the purpose of investigating a FIR. This decision was made based on policy, as your role and clearance meet the requirements outlined in crime-policy-v1. Your request has been approved.

**escalate / low clearance** (escalate)

> Access was escalated for senior review because the requester clearance sits below the record sensitivity level. The attributes that decided it were requester clearance and record sensitivity level. Context: requester role constable, requester clearance low and purpose investigation. What would change the outcome: decision would change if requester clearance were 'medium' or higher. Evaluated under policy crime-policy-v1.

**deny / role has no permission** (deny)

> The access request for viewing a FIR record was denied due to insufficient permissions, specifically because your role as defense counsel does not have the required "view" permission on FIR records. This is based on our policy version crime-policy-v1 and its associated rules. The reason code RBAC_NO_PERMISSION indicates that this decision is made through Role-Based Access Control (RBAC) mechanisms.

