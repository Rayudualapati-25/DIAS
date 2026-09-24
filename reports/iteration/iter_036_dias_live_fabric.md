# Iteration 036 — Live DIAS deployment and acceptance scenarios

**Date:** 2026-09-12
**Artifacts:** `experiments/runs/20260912_dias_live_fabric/`, `results/tables/dias_live_fabric_scenarios.csv`
**Result:** 15/15 scenarios pass, 72/72 individual checks.

## 1. What was deployed, and what was left alone

The redesigned chaincode was packaged and committed under a **separate name**,
`diasrecords` v1.0 sequence 1, on the existing `crimechannel`. The SEAL-era
`crimerecords` 3.7 deployment is still committed, still running, and was not
modified.

```
Committed chaincode definitions on channel 'crimechannel':
Name: crimerecords, Version: 3.7, Sequence: 1
Name: diasrecords,  Version: 1.0, Sequence: 1
```

All six organisations approved: PoliceMSP, ForensicsMSP, ProsecutionMSP,
CourtMSP, AuditMSP, AIOrgMSP. Commit transaction
`448818b413a6177cf3fe757f5d24578f63c03a66f47eca1b23874d6bc53fa464`.

**Untouched, and verified untouched afterwards:** the V6 MLX server on port 8080
(PID 54194), the `wt-dias` directory the live network runs from, and the
`crimerecords` ledger state.

The Fabric network itself runs from `wt-dias/network`, which is read-only for
this work. Deployment ran from this repository's `network/` directory using its
own copy of the crypto material, which the peers accept because the CA roots are
identical (verified before deploying). Nothing was written into `wt-dias`.

## 2. An integration defect the deployment exposed

Seeding `diasrecords` failed with a generic `10 ABORTED: failed to endorse`.
The cause was the same class of defect the backend had: `scripts/seed-domain.js`
still called `PolicyContract.CreatePolicyVersion`, `ActivatePolicyVersion` and
`ActivateLLMPolicyModel` — SEAL-era methods the rewritten contract no longer
exposes.

The compatibility guard had not caught it because it scanned only `backend/src`.
It now scans `scripts/` too, and reported all five stale calls immediately. The
SEAL-era `scripts/activate-llm-model.js` was retired; policy and model
registration is now `scripts/dias/register-policy-and-model.js`, which is
idempotent and verified so.

**Recorded for completeness:** while fixing this, a syntax check of the form
`node -e "require('./scripts/seed-domain.js')"` executed the script's `main()`
against the default chaincode, `crimerecords`. Every call returned "already
exists" and was skipped; the two demo cases on `crimerecords` still carry their
original `2026-09-10` timestamps, so no state was written. Scripts whose `main`
runs on import are not safe to `require` for a syntax check.

## 3. Registration

```
adapter: untuned base model, no adapter
registered policy bundle dias-governance-policy v1
activated policy bundle dias-governance-policy v1 796013dd…3bc9b1c0
registered model MODEL-7b71cc952fbaa411 qwen3-14b-4bit-untuned
activated model MODEL-7b71cc952fbaa411 qwen3-14b-4bit-untuned (previous: none)
```

Re-running the script writes nothing:

```
policy bundle already active: dias-governance-policy v1 796013dd…
model already active: MODEL-7b71cc952fbaa411 qwen3-14b-4bit-untuned
```

The registration refuses an adapter-backed model whose directory it cannot read
or whose recomputed digest differs from the expected one — a registration that
describes no local bytes cannot be checked by anyone later.

## 4. What the live model actually recommended

Scenario A needs a model ALLOW and scenario C needs a model DENY. Rather than
assume which request produces which, candidates were probed first
(`probes.json`):

| Candidate | Model answer |
| --- | --- |
| assigned inspector, own district, ordinary FIR | **ALLOW** `POLICY_SATISFIED` |
| cross-district inspector, same FIR | **DENY** `CROSS_JURISDICTION` |
| constable, juvenile record | **DENY** `NOT_ASSIGNED` |
| court clerk, juvenile record | **DENY** `RBAC_NO_PERMISSION` |
| assigned IO, evidence record | **ALLOW** `POLICY_SATISFIED` |

These are the untuned base model's own answers, recorded on chain with signed
provenance. Scenarios were routed by what the model said, not by what it was
hoped to say.

## 5. Scenario results

| | Scenario | Result |
| --- | --- | --- |
| A | Model ALLOW + FORCE_ALLOW → grant, no authorization | PASS (5/5) |
| B | Model DENY + FORCE_DENY → deny, no authorization | PASS (4/4) |
| C | Model DENY + FORCE_ALLOW → grant **and** create authorization | PASS (7/7) |
| D | Exact repeat → automatic grant, model and auditor skipped | PASS (7/7) |
| E | Near misses (record, action, purpose, user) → no reuse | PASS (4/4) |
| F | Revocation stops reuse | PASS (5/5) |
| G | Expiry stops reuse | PASS (6/6) |
| H | Model ALLOW + FORCE_DENY → deny, no authorization | PASS (4/4) |
| I | Model unavailable → auditor decides, no authorization | PASS (8/8) |
| J | Invalid model output → INVALID_OUTPUT, routed to auditor | PASS (5/5) |
| K | Restart/replay → committed request still answered, exactly once | PASS (4/4) |
| L | Concurrent duplicate deliveries → exactly one recommendation | PASS (3/3) |
| M | Requester decides own request → rejected | PASS (3/3) |
| N | Non-AI organisation recommends → rejected | PASS (2/2) |
| O | Facts change after recommendation → stale decision refused | PASS (4/4) |

72 of 72 checks pass. Full evidence — transaction ids, lifecycle sequences,
ledger objects, refusal messages — is in `scenarios.json`.

### The two lifecycles that matter

Scenario C, the only path that creates a reusable authorization:

```
1 ACCESS_REQUEST_SUBMITTED → 2 DYNAMIC_AUTHORIZATION_CHECKED
→ 3 POLICY_CONTEXT_ASSEMBLED → 4 LLM_RECOMMENDATION_RECORDED
→ 5 AUDITOR_DECISION_RECORDED → 6 DYNAMIC_AUTHORIZATION_CREATED
→ 7 ACCESS_OUTCOME_RECORDED
```
request `REQ-6a05b62a384b5e59` → authorization `AUTH-3b16fe4f98b0d8de`, scope
`{PoliceMSP::insp.singh, REC-FIR-001, CASE-2026-001, view, investigation}`.

Scenario D, the same request again:

```
1 ACCESS_REQUEST_SUBMITTED → 2 DYNAMIC_AUTHORIZATION_CHECKED
→ 3 LLM_RECOMMENDATION_SKIPPED → 4 AUDITOR_REVIEW_SKIPPED
→ 5 ACCESS_OUTCOME_RECORDED
```
No recommendation record exists for this request: the model was never called.

### Near misses

Every variant returned `NO_AUTHORIZATION` and went to the auditor:

| Variant changed | Check outcome |
| --- | --- |
| record (`REC-EVIDENCE-001`) | `NO_AUTHORIZATION` |
| action (`export`) | `NO_AUTHORIZATION` |
| purpose (`prosecution`) | `NO_AUTHORIZATION` |
| user (`insp.rathore`) | `NO_AUTHORIZATION` |

## 6. Audit trail

`GetRequestAuditTrail` reconstructs one request completely from committed state
(`audit-trail-scenario-C.json`): 7 lifecycle stages grouped into 3 transactions,
both related authorizations with their events and full key history, and the
private text with hash verification.

Private justification, model explanation and auditor reason all verify against
their committed hashes for a reviewer; a requester sees the hash checks without
the text.

## 7. Two harness defects found and fixed

Both were in the test harness, not the system:

1. The first run gave every ordinary request an 8-second inference budget, which
   turned real answers into `UNAVAILABLE`. The acceptance suite would have been
   measuring its own timeout. Budget raised to 240 s.
2. Scenario G created an authorization valid for 20 seconds, but the setup
   (inference plus two commits) consumed the window before the "still valid"
   half could run. The ledger correctly recorded the expiry — the test was
   simply too impatient. The window now outlasts the setup and the harness
   asserts that it did.

Neither was a chaincode defect; both are recorded because a green suite that
reached green by having its assertions loosened is worth nothing.

## 8. Limitations

- The model here is the **untuned base**, so these scenarios demonstrate the
  workflow, not model quality. Quality is Phase 5/7.
- Scenarios I–L answer requests in-process through `handleRequest`, the same
  function the listener calls, because they need control over how a delivery
  fails. The background listener is stopped for the run and the runner refuses
  to start while it is up.
- Scenario O forces the fact change by sealing and unsealing the record. A real
  change would more often be a transfer or a status update; the mechanism the
  chaincode checks (the committed verified-request hash) is the same either way.

## 9. Commands

```bash
cd network && ./scripts/deployCC.sh crimechannel diasrecords 1.0 auto
CHAINCODE=diasrecords node scripts/seed-users-onchain.js
CHAINCODE=diasrecords node scripts/seed-domain.js
CHAINCODE=diasrecords node scripts/seed-demo-records.js
node scripts/dias/ensure-signing-key.js
CHAINCODE=diasrecords node scripts/dias/register-policy-and-model.js \
  --model-id qwen3-14b-4bit-untuned --purpose research-baseline
CHAINCODE=diasrecords DIAS_MODEL_URL=http://127.0.0.1:8081/v1 node backend/src/ai/start.js   # listener
# stop the listener, then:
CHAINCODE=diasrecords DIAS_MODEL_URL=http://127.0.0.1:8081/v1 \
  node scripts/dias/run-live-scenarios.js --out experiments/runs/20260912_dias_live_fabric
```
