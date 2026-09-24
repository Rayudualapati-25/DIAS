# DIAS walkthrough

What happens, in order, when someone asks for a case file. The steps below are
exercised on a live Fabric network by `scripts/dias/run-backend-acceptance.js`,
which drives the backend API exactly as the web interface does; its evidence is
written under `experiments/runs/<date>_dias_backend_llm_acceptance/`.

## 1. The request

An inspector picks a record, an action (`view`), a purpose (`investigation`) and
writes a sentence explaining why. The backend keeps that sentence off-chain; it is
never a chaincode argument and never reaches the ledger.

`CreateAccessRequest` then, in one transaction:

- reads the requester's profile and the record from committed state and builds
  the **verified request** — the requester's certificate decides who they are,
  not anything they typed;
- commits the **request log**: who requested which record, with the case, action,
  purpose and the hash of the verified facts;
- checks the latest active dynamic authorization against the exact scope.

## 2a. An authorization matches

The request is granted immediately. The model is never called and no auditor is
involved. The ledger records that plainly:

```
ACCESS_REQUEST_SUBMITTED → DYNAMIC_AUTHORIZATION_CHECKED
→ AUDITOR_REVIEW_SKIPPED → ACCESS_OUTCOME_RECORDED
```

## 2b. No authorization matches

The request waits as `awaiting-auditor`, and the API answers the requester at
once. The backend then prepares the recommendation for the auditor:

1. it stores the justification and the committed verified request in its
   off-chain review store;
2. it checks that the verified request hashes to the committed hash. **If it does
   not, the model is not called at all**;
3. it assembles the governance policy context and builds the prompt with the
   single shared prompt module;
4. it calls Qwen at temperature 0 and parses the answer against the response
   contract.

It stores one of two results:

- a schema-valid **ALLOW or DENY** with its reason code, explanation and policy
  references, unchanged. Nothing corrects it;
- a **generation status** (`UNAVAILABLE`, `INVALID_OUTPUT`, `CONTEXT_OVERFLOW`,
  `POLICY_CONTEXT_UNAVAILABLE`) with an error code. No recommendation is
  invented.

Requests are answered one at a time. If the backend restarts, it answers again
any recommendation it left pending.

## 3. The auditor

The auditor screen shows the verified facts, the requested record, the action
and purpose, the justification **marked untrusted**, and the model's answer
marked advisory — or that it is still being prepared, or that the model produced
nothing and why.

Before the auditor clicks, the screen states what the click will do: whether a
dynamic authorization will be created, whether a reason is required, and what the
ledger will record about agreement with the LLM. A reason is mandatory whenever
the auditor does not agree with the model or no recommendation exists; the
backend enforces that and keeps the reason off-chain.

The decision is `FORCE_ALLOW` or `FORCE_DENY`, and it is final. The backend works
out the agreement from the stored recommendation and `SubmitAuditorDecision`
commits the **decision log**: the auditor, the decision, and `AGREED`,
`NOT_AGREED` or `NO_RECOMMENDATION`.

## 4. The one path that creates an authorization

Model **DENY** overridden to **FORCE_ALLOW** — recorded as `NOT_AGREED`:

```
ACCESS_REQUEST_SUBMITTED → DYNAMIC_AUTHORIZATION_CHECKED
→ AUDITOR_DECISION_RECORDED → DYNAMIC_AUTHORIZATION_CREATED
→ ACCESS_OUTCOME_RECORDED
```

The authorization is scoped to that exact user, record, case, action and purpose,
bound to the hash of the governed conditions, and optionally given an expiry.
Every other combination ends after `ACCESS_OUTCOME_RECORDED` without one.

## 5. Later requests

| Situation | What happens |
| --- | --- |
| The identical request | granted automatically; model and auditor skipped |
| A different record, action, purpose or user | no match; back to the model and the auditor |
| Any governed fact changed since approval | `CONDITIONS_CHANGED`; no match |
| The authorization was revoked | `REVOKED`; no match |
| Its expiry has passed | `EXPIRED`, transition recorded; no match |

## 6. Release

A granted outcome is not a permanent key. `AuthorizeRecordRead` re-checks the
basis at release time: the requester's credential must still be active, and an
authorization-based grant is released only while that authorization is still
active and unexpired.

## 7. Reading it back

`GetRequestAuditTrail(requestId)` returns the story from committed state: a
summary, the request log, every lifecycle stage grouped by the transaction that
wrote it, the decision log with its LLM agreement, the access outcome, and every
related authorization with its events and full key history. For a reviewer the
backend adds the off-chain review — justification, LLM recommendation and auditor
reason — clearly marked as not coming from the ledger.

## Running it

```bash
make dias-all          # diaschannel (five organizations), diasrecords 2.2, users and departments
make dias-demo-data    # optional: the demo cases and case files the live suites use
make dias-model        # the model server on :8081 (8080 is left for any existing service)
make dias-backend      # the API and web interface on :3001; it calls the model
make dias-acceptance   # the live acceptance run through the backend API
```
