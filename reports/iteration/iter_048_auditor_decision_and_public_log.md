# Iteration 048 — The auditor decision that would not commit, one request screen, and a public decision log

**Date:** 2026-09-16
**Branch:** `dias-backend-llm` (no commits made)
**Chaincode:** `diasrecords` 2.2, sequence 3, on `diaschannel`
**Result:** the reported failure is fixed and explained on screen; the two
overlapping request screens are one; every identity on the channel can read the
decision log; a fresh install starts with no case and no case file.

## 1. The report

"Force allow / force deny is not working." The researcher also asked for one
request screen instead of two, for decisions to be readable by everyone on the
blockchain, and for a fresh system to hold no case or case file so the first ones
are created through the application.

## 2. What was actually wrong

The ledger's own access log holds the answer: twenty `dias.auditor.decision`
events, all `rejected` with status 422, all by `sp.north` on
`REQ-79a5a0b4681250c0` — a request `sp.north` had raised. The chaincode rule is
deliberate (`a requester cannot decide their own request`, live scenario R10), so
nothing was broken on the ledger. What was broken was the screen: the refusal
appeared only as a toast that disappeared, the dialog looked unchanged, and the
buttons stayed active, so the obvious reading was "the button does nothing".

## 3. Changes

| Area | Change |
| --- | --- |
| Auditor review | `decisionAvailability()` decides, before anything is pressed, whether this auditor may decide this request. Their own request: a warning at the top of the dialog naming the other district heads (dj.north, cfo.north, dp.north, sp.south) and both buttons disabled with the reason as their tooltip. A recommendation still being prepared: the same treatment. |
| Auditor review | A refusal from the ledger is now rendered inside the dialog ("The ledger refused this decision" + the contract's sentence + "Nothing was recorded"), not only as a toast. |
| Backend | Gateway errors lose the transport prefix, so the screen shows `a requester cannot decide their own request` instead of `chaincode response 500, unauthorized: …`. |
| Frontend | `llm-policy-console.js` and `search-records.js` are replaced by one `request-access.js`: find a case or case file, choose operation, purpose and reason, submit, watch the decision, then read the metadata and collect the complete PDF. |
| Chaincode 2.2 | `AccessContract.QueryAccessDecisions(limit)` returns every settled request with what was decided: requester, case file, action, purpose, outcome, the auditor and their decision, the LLM agreement, and the transaction ids. Readable by any identity with a role on the channel; it carries no identity hash, no justification and nothing the LLM produced. |
| Backend + frontend | `GET /api/access/decision-log` and a "Decision log" screen open to every signed-in identity. |
| Seeding | `make dias-seed` now writes only identities and departments. The two demo cases and three case files moved to `make dias-demo-data`, which the live suites need; both live suites fail with a named precondition if it has not been run. |

## 4. Verification

| Check | Result |
| --- | --- |
| `make test` | chaincode 211, backend 168, policies 27, frontend 39, dataset 93 — all passing |
| `make check` | exit 0 |
| `make smoke` (live API suite) | 16 passing |
| `make dias-acceptance` (chaincode 2.2) | 14/14 scenarios, 81/81 checks |
| Full flow through the API | create case `CASE-DEMO-448600` → file `REC-DEMO-448600` → find it from another station → request → LLM `ALLOW (POLICY_SATISFIED)` → `dj.north` FORCE_ALLOW → ledger records `AGREED` → `const.verma` reads it in the decision log |
| Browser, the reported case | `sp.north` opening their own request sees "You cannot decide your own request" and two disabled buttons; `dj.north` opening the same request decides it, and the dialog shows `NOT_AGREED` and the dynamic authorization it created |
| Browser, decision log | rendered for `const.verma` (a constable): 60 decisions, newest first |

## 5. Left as it is

- The seeded demo data already on this ledger (`CASE-2026-001`, `CASE-2026-002`,
  their three records, and `CASE-PROOF`) cannot be removed: the chaincode has no
  delete path, by design. A truly empty start needs either a new channel or a
  network teardown, and the network is shared with the original project's
  checkout, so neither was done here.
- Everyone can now read *that* a decision was made and what it was. The
  justification, the LLM recommendation and the auditor's reason stay off-chain
  and reviewer-only, as designed.
- Nothing is committed.
