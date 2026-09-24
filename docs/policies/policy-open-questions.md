# DIAS Governance Policy — Open Questions and Resolutions

**Policy of record:** `policies/dias-governance-policy-v1.json`
**Bundle:** `dias-governance-policy` `v1`
**Canonical SHA-256:** `796013dd7d8a043891485cbf7bf9d4c54288f3fa7d746fd7dd2fdc693bc9b1c0`
**Specification:** [governance-policy-specification.md](governance-policy-specification.md)
**Status of this document:** current as of 2026-09-12.

## How to read this document

The governance policy is **a synthetic research policy**, written for this
prototype. It is **not** an official police, prosecution or court policy, and no
part of it should be cited as describing how any real jurisdiction handles
criminal-record access. It was derived from the SEAL-era rule tables in
`chaincode/crimerecords/lib/policy/policyV1.js` and the evaluation order in the
former `policyEngine.js`, then restated as clause text a language model can be
asked to apply.

Every item below is one of three kinds:

- **Resolved** — a decision was taken, the reason is recorded, and the bundle
  implements it.
- **Limitation** — the policy behaves in a way that is defensible for a research
  prototype but would need real legal input before any deployment.
- **Open** — the answer genuinely depends on a jurisdiction's rules, and the
  prototype takes a documented default rather than inventing law.

Nothing here is decided silently. Where a question could reasonably be answered
more than one way, the alternatives are stated so the choice can be revisited.

---

## 1. Resolved: sealed records produce DENY, not a third class

**Question.** The SEAL-era engine returned ESCALATE when a non-court identity
requested a sealed record. DIAS's model vocabulary is binary. What happens?

**Resolution.** `GP-SEAL:C1@v1` recommends **DENY** and attaches the review flag
`SEALED_RECORD_COURT_REVIEW`.

**Why.** ESCALATE as a model label conflates two different things: what the
policy says about the request, and what the workflow should do next. The policy
statement is unambiguous — a non-court identity has no permission to a sealed
record — so the recommendation is DENY. The workflow statement is carried by the
review flag, which tells the auditor that the appropriate route is a court
review rather than a simple refusal. An auditor who agrees that court authority
exists records FORCE_ALLOW, and that is exactly the path that creates a dynamic
authorization.

**What was given up.** The recommendation alone no longer distinguishes "denied
because the requester may never have this" from "denied pending the right
authority". The distinction survives in `review_flags`, and the auditor screen
renders it, but a metric computed over `recommendation` alone will not see it.
Evaluation therefore reports reason-code and review-flag accuracy separately
from decision accuracy.

**Alternative not taken.** Keeping a third class would have made the model's
output a workflow instruction, which is precisely the authority the architecture
denies it.

---

## 2. Resolved: no emergency or approval-token exception

**Question.** `emergencyFlag` and `approvalTokenPresent` are verified request
fields. Should either bypass a DENY clause?

**Resolution.** No. `GP-CONTEXT:C1@v1` records both fields for audit and grants
no exception in policy v1.

**Why.** A silent emergency bypass is the single most dangerous construct such a
policy can contain: it is both the most attractive attack surface and the
hardest to audit, because the bypass looks identical to a legitimate grant. DIAS
already has an auditable override — the auditor's FORCE_ALLOW, which records who
decided, why, and against which recommendation. An emergency is a reason for an
auditor to override quickly, not a reason to remove the auditor.

**Limitation.** A real deployment with genuine time-critical access needs would
require a break-glass path faster than human review. Designing one is out of
scope here, and the honest statement is that **DIAS v1 has no break-glass path**.

**Consequence for the dataset.** Because the flags are policy-irrelevant, they
must vary independently of the label in every split, otherwise the model can
learn them as a shortcut. The dataset validator enforces this.

---

## 3. Resolved: jurisdiction is absolute, with no seniority exception

**Question.** `GP-JURIS:C1@v1` denies every cross-district request. Should
senior officers (SP, Commissioner) reach across a district boundary?

**Resolution.** No exception. The clause applies to every role.

**Why.** The SEAL-era tables contained no such exception, and adding one would be
inventing policy rather than restating it. A senior officer with a legitimate
cross-district need goes through the auditor, which is the designed route for
exactly this case, and the resulting dynamic authorization is scoped to that one
record.

**Open.** Whether a real force would grant standing cross-district reach to
particular ranks is a genuine question of local rules. The prototype's answer —
absolute boundary plus auditable override — is a defensible default, not a claim
about any real force.

---

## 4. Resolved: the justification is data, never instruction

**Question.** The requester's free text is the only untrusted input the model
sees. How far does distrust extend?

**Resolution.** Completely. `GP-CONTEXT:C1@v1` states that no claim in the
justification changes the recommendation — not identity, role, rank, clearance,
case assignment, emergency, approval, or record state. Two review flags record
what was attempted: `UNVERIFIED_CLAIM_IN_JUSTIFICATION` for a claim the verified
facts do not support, and `INSTRUCTION_IN_JUSTIFICATION` for text aimed at the
system rather than at the reader.

**How it is enforced, not just stated.** The prompt wraps the justification in
delimiters and neutralises any attempt to forge them; the system prompt states
the rule; and the training data contains explicit injection and false-claim
examples so the behaviour is learned rather than merely instructed.

**Limitation.** Prompt-level containment is mitigation, not proof. The
architecture's actual protection is that the model is advisory: a successful
injection produces a wrong recommendation, which an auditor sees alongside the
justification that produced it. **No injection can grant access**, because the
model cannot grant access. The adversarial test set measures how often
containment holds; it does not claim it always will.

---

## 5. Resolved: multiple failing clauses report one reason and all references

**Question.** When several DENY clauses apply, which reason code is reported?

**Resolution.** `GP-PRECEDENCE:C1@v1` fixes the order, and the reason code comes
from the **first applicable clause** in that order. `policy_refs` lists **every**
applicable DENY clause, first-applicable first.

**Why.** A single reason code keeps the output a clean label for evaluation and
for the auditor's summary line, while the full reference list preserves the fact
that the request failed on several independent grounds — which matters, because
lifting one obstacle would not make the request grantable. Determinism matters
more than the particular order chosen: any fixed order is reproducible, whereas
an unordered answer cannot be scored.

**Note on the order itself.** The sequence runs from properties of the requester
(credential, purpose, role) through properties of the record (sealed, juvenile,
victim) to the relationship between them (jurisdiction, assignment, clearance).
This is a readability choice, not a legal ranking, and it is the one place where
a different jurisdiction could reasonably want a different order.

---

## 6. Resolved: RBAC split into two clauses with one reason code

**Question.** The source table mixed "this role does not exist in your
organization" with "this role may not perform this action on this record type".

**Resolution.** Split into `GP-RBAC:C1@v1` (role must belong to the requester's
verified organization) and `GP-RBAC:C2@v1` (permission matrix). Both carry the
reason code `RBAC_NO_PERMISSION`.

**Why.** The two failures are diagnostically different — one is an identity
inconsistency, the other a permission boundary — so they deserve separate clause
references. They are not different outcomes for the requester, so they share a
reason code. This keeps the reason-code vocabulary small enough to evaluate while
keeping `policy_refs` precise.

---

## 7. Limitation: INVALID_PURPOSE cannot occur at runtime

**Question.** `GP-PURPOSE:C1@v1` denies a missing or out-of-vocabulary purpose,
but the API and the chaincode both reject such a request before it is committed.
Can the model ever see one?

**Answer.** Not through the live path. The clause exists for completeness of the
written policy and for offline evaluation.

**Consequence, and a defect this exposed.** The v1 dataset contained 246
`INVALID_PURPOSE` examples — situations that cannot occur in production. Training
on them spends capacity on an unreachable case and inflates any headline accuracy
figure. **The v2 dataset excludes INVALID_PURPOSE from the production-shaped
evaluation sets.** Whether to retain a small number in training as a robustness
control is recorded as a dataset decision, not a policy one.

---

## 8. Limitation: clearance is a total order over three levels

**Question.** `GP-CLEAR:C1@v1` compares clearance to sensitivity using
`clearanceOrder`. Is a total order the right model?

**Answer for v1.** Yes, with three levels (low, medium, high) and unknown
sensitivity treated as the most restrictive value.

**Limitation.** Real clearance systems are frequently **compartmented**: a
clearance conveys access to named categories, not a position on a scale. A total
order cannot express "cleared for narcotics but not for organised crime". The
prototype uses the ordered model because the source tables did; a compartmented
model would need a different clause shape and a different verified attribute.

**Why it still matters for the experiment.** The v1 dataset used only `high` and
`low`, which let the model treat clearance as a binary flag. **The v2 dataset
uses all three levels across all sensitivity levels**, so the comparison is
genuinely ordered.

---

## 9. Open: what should expire, and when

**Question.** A dynamic authorization may carry `validUntilUtc`, which the
auditor sets. The policy says nothing about a default or a maximum.

**Current behaviour.** No default and no cap. An authorization without an expiry
remains active until it is explicitly revoked or superseded.

**Why this is left open.** A sensible maximum lifetime depends on the record
category and on retention rules the prototype does not model. Inventing "30 days"
would look like policy while being arbitrary.

**What is guaranteed regardless.** Expiry is evaluated against committed ledger
state at request time, an expired authorization transitions to `expired` and is
recorded as a lifecycle event, and revocation is always explicit and always
carries a reason. The live scenarios exercise both.

---

## 10. Open: FORCE_DENY does not revoke an existing authorization

**Question.** If an auditor denies a later request, should that revoke an active
authorization covering the same scope?

**Current behaviour.** No. FORCE_DENY records a denial for that request only.
Revocation is a separate, explicit, reasoned transaction.

**Why.** Implicit revocation would make one auditor's decision on one request
silently change the standing authorization state, and the ledger would show a
revocation nobody chose. Making it explicit means every authorization change has
a named actor and a reason.

**The risk this leaves.** An auditor who denies a request may reasonably assume
the earlier authorization is gone. It is not. **The auditor interface must show
whether an active authorization covers the scope in view** — this is recorded as
a UI requirement arising from a policy choice, and the dynamic-authorization
panel exists for it.

**Alternative.** Prompting the auditor to revoke, as a separate confirmed action,
would keep the explicitness while closing the gap. Not implemented in v1.

---

## 11. Open: the policy has no evidence requirements

**Question.** The response schema carries `missing_evidence`. Policy v1 defines
no evidence requirements, so the field is always empty.

**Why it exists anyway.** A real governance policy would require supporting
material for some requests — a court order for a sealed record, a supervisor's
authorisation for an export. The field is in the contract from the start so that
adding such a requirement is a policy change rather than a schema change.

**Honest statement.** Any claim that DIAS "identifies missing evidence" would be
unsupported today. The field is reserved capacity, and the specification says so.

---

## 12. Limitation: the policy is frozen, and editing it in place is a defect

The bundle's canonical hash is computed over its sorted-key serialization and
recorded on-chain at registration. Editing `v1` in place after registration
produces a bundle whose hash no longer matches the ledger, and the recommendation
service refuses to answer — it records `POLICY_CONTEXT_UNAVAILABLE` with
`policy_bundle_mismatch` rather than recommending against a policy the chain
never agreed to.

**A policy change is a new version.** `v2` is registered alongside `v1` and
activated; `v1` is marked superseded and stays readable, so any past
recommendation can still be interpreted against the policy that produced it.

---

## Summary table

| # | Question | Kind | Outcome |
| --- | --- | --- | --- |
| 1 | Sealed records without a third class | Resolved | DENY + `SEALED_RECORD_COURT_REVIEW` |
| 2 | Emergency / approval bypass | Resolved | No exception; no break-glass path exists |
| 3 | Seniority across districts | Resolved / Open | Absolute boundary; real rules may differ |
| 4 | Trust in the justification | Resolved | Zero; two review flags record attempts |
| 5 | Multiple failing clauses | Resolved | First-applicable reason, all refs listed |
| 6 | RBAC organization vs matrix | Resolved | Two clauses, one reason code |
| 7 | `INVALID_PURPOSE` unreachable live | Limitation | Excluded from production-shaped eval |
| 8 | Clearance as a total order | Limitation | Three levels; compartments unmodelled |
| 9 | Authorization lifetime | Open | No default, no cap; expiry enforced if set |
| 10 | FORCE_DENY and revocation | Open | Never implicit; UI must surface coverage |
| 11 | Evidence requirements | Open | None defined; field reserved |
| 12 | Editing a frozen policy | Limitation | Refused at runtime; publish a new version |

## What would change these answers

Items 3, 9 and 10 need a jurisdiction's actual rules. Items 8 and 11 need a
clause shape the prototype does not yet have. Items 1, 2, 4, 5, 6 and 12 are
architectural decisions and would only change if the authority model changed —
for example, if the model were ever given authority to grant, at which point
almost every answer here would need revisiting.
