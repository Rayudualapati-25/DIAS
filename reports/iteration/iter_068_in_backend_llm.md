# Iteration 068 — the backend asks the LLM itself; auditor screen and access log

- **Date:** 2026-10-08
- **Plan step:** 12, changed by the author on this date (plan, Amendments).
- **Requirements:** M21 design text done. A05 closed without a separate process: the backend holds the signing key.
- **Author's instructions:**
  1. The LLM is invoked automatically, without any special service. When a request is not a reusable authorization, the LLM is invoked immediately and its answer goes to the auditor's decision screen.
  2. The access log is a simple table that shows who requested, what was requested, what the LLM recommended, and what the auditor decided, with the decision stated together with the LLM recommendation.

## What changed

### 1. No separate recommendation service

- The unfinished step 12 work is removed: the test file for a separate service process, and the step 12 cases in the runtime and architecture tests. None of it was committed.
- `backend/src/recommender-service/` is gone. Its code is `backend/src/dias/signedRecommendation.js`; only names and wording changed.
- `answerCommittedRequest` (access routes) is the one place that decides what happens after the ledger commits a request:
  - a request granted by a reusable authorization is finished, and the recommendation runtime is never touched;
  - every other request has its off-chain review saved and its LLM recommendation queued at once.
- The contract is not changed. The backend still signs each recommendation with the registered key, and κ is still committed before review.

### 2. The auditor screen updates by itself

- New route `GET /access/auditor/pending/status?ids=…`: for each request id, whether its recommendation is still being prepared.
  - It reads only the off-chain review store and returns no case data.
  - It accepts 1 to 50 request ids, and answers only a district head of the audit organisation. It checks the organisation itself, because no contract call stands behind it.
  - It is a routine read. A successful call writes no access-log transaction; the queue read itself stays sensitive and always logged.
- The auditor screen asks every 3 seconds while it shows "Being prepared", in the queue or in the open review. It asks in calls of at most 50 ids, so a long queue is covered.
- When a recommendation is ready, the screen loads the queue again without blanking it and refreshes the open review. The auditor's typed reason, the focus and the caret are kept. A review the auditor closed in the meantime is not reopened.
- The watch ends when nothing is left to wait for or the screen is left.
- The watch gives up, and the screen says "Automatic checking has stopped. Press Refresh to check again.", when the backend refuses a check, when the network fails three times in a row, or after 10 minutes. The Refresh buttons still work.
- A review whose recommendation is shown but not yet confirmed on the ledger has a "Check again" button.

### 3. The access log screen

- Tab "Access requests": time, who requested, what was requested, LLM recommended, auditor decided. The decision cell names the recommendation it was taken against, for example "FORCE ALLOW — agreed with the LLM's ALLOW · by sp.north".
- It has a count, the time of the last refresh, a refresh button, a filter button with the number of active filters, and a time column that sorts both ways.
- Rows without an auditor say why: a reusable authorization matched, the request expired, or the requester cancelled it.
- It loads the newest 100 settled requests and says so when the list is full.
- Tab "Searches and reads" keeps the earlier list of application access events unchanged.
- The data is the ledger's existing decision records (`QueryAccessDecisions`). What is written to the ledger did not change.

## Tests

- **Before (2026-10-08):** backend 283 passing and 4 failing, plus one test file that could not load; all from the unfinished step 12. Frontend 50/50.
- **After:** backend 293 passing, 0 failing. Frontend 71/71. Frontend syntax check passes.
- **New backend tests, written before the code (the suite failed until the code existed):**
  - `requestToRecommendation.unit.test.js`, 3 tests on the real composition root with a stand-in model endpoint: the LLM is asked once, at once, with no service address or token; a reused authorization never reads the runtime, the LLM or the ledger; a stopped model server gives the auditor a committed "no recommendation";
  - architecture guard: the separate-service files must not exist, and the access routes must reach the signing module in-process;
  - status route, 3 tests: only an audit-organisation district head is answered; which requests are still being prepared; the `ids` validation;
  - access-log policy: the status check is routine, the queue read stays sensitive.
- **New frontend tests:** 13 for the watch and 8 for the access-log rows, order, filters and time format.
  - The watch tests cover: ready, nothing left, never twice, calls of at most 50 ids (checked against the backend's limit), a refusal, a network failure that recovers, repeated network failures, the screen left before and during a check, the time limit, and a check in flight.
- **Coverage of the changed backend modules (statements, measured before the review fixes):** `signedRecommendation.js` 94%, `recommendationWorker.js` 93%, `reviewStore.js` 94%, `accessLogger.js` 90%, `runtime.js` 89%. `routes/access.js` was 69%, because its Express handlers are thin wrappers that the unit tests do not call, as before.
- **Not run:** chaincode, policies and dataset suites. No file in those packages changed.

## Code review

- An independent review of the three changes gave "Warning": 1 high, 3 medium and 4 low findings, none critical.
- **Fixed:**
  - high: with more than 50 waiting requests the status call was refused and the watch stopped, and each refusal wrote a failed-call entry on the ledger. The screen now asks in calls of at most 50 ids;
  - medium: the watch ended silently. It now retries after a network failure, and tells the screen when it gives up;
  - medium: an automatic refresh could reopen a review the auditor had closed, and lost the focus while typing. Both are guarded, and the queue is no longer blanked on an automatic reload;
  - low: leaving the screen during a check no longer triggers a queue read; the status route checks the audit organisation; the access log says when only the newest 100 are loaded; one test that could not fail was made to bite.
- **Left as it is:**
  - each recommendation that becomes ready on an open auditor screen causes one logged queue read, and one logged review read when that review is open. Reads of the queue are sensitive by design;
  - route logic is tested as exported functions, as elsewhere in this project, not over HTTP. The auditor-screen wiring has no automated test, because the project has no browser test setup; it was checked by hand;
  - the "being prepared" states are defined once in the backend and once in the frontend;
  - the registered key's ledger label still reads `dias-recommendation-service`.

## Live check (single machine, 2026-10-08)

- The backend on port 3001 was restarted with `make dias-backend` to load the new code, twice: once for the change and once for the review fixes. Start-up log both times: recommendations resumed 0, staged notes 0.
- One synthetic request was submitted as `insp.sharma` for `REC-FIR-001` (view, investigation): `REQ-4a97d0bb8d965008`, submitted 08:46:37.
- The backend log shows `REQ-4a97d0bb8d965008 -> committed OK ALLOW` with no other action.
- The auditor queue (`sp.north`) showed the row as "being prepared" and then as ALLOW without a click. The browser made one status call and then one queue read.
- The ledger's access events for the day hold no status-check entry (0 of 17); the queue and review reads are there as before.
- The open review was checked with simulated answers in the browser, because the real recommendation was already there. After the review fixes:
  - "Being prepared" changed to ALLOW by itself, with the typed reason, the focus and the caret kept, the decision buttons enabled, and no further status call;
  - a review closed while its automatic refresh was in flight stayed closed;
  - a simulated refusal produced one status call, then the "Automatic checking has stopped" notice in the review and in the queue card.
- The real status route answered `sp.north` with HTTP 200 and `preparing: false` for the committed request.
- The request is still waiting for an auditor. No decision was made.

## What is weak

- **The backend is trusted for the recommendation.** It runs the model and holds the signing key, so the signature does not protect against a compromised backend. A recommendation cannot be changed after κ is committed.
- **The paper still names a recommendation service.** The Methodology draft lists it as an actor in Algorithm 1 and in the sequence figure. The manuscript was not changed.
- **Requests are answered one at a time.** Under load a request waits its turn before the LLM is asked.
- **A new request does not appear on an open auditor screen by itself.** The screen only watches rows it already shows; one Refresh is needed to see a request that arrived later.
- **An open auditor screen adds logged reads.** Every recommendation that becomes ready while the screen is open is one more queue read on the ledger. Keep auditor screens closed during ledger-growth measurements.
- **The access log lists settled requests only.** A request that is still waiting is not in it. An expired or cancelled request shows "Not recorded" for the LLM, because the ledger's decision list carries the recommendation only with a decision.
- **Contract comments still say "recommendation service".** They are not edited, because any change to the chaincode package needs a redeploy.
- **In `DIAS_ACCESS_LOG_MODE=all` every call is logged,** so an open auditor screen that is waiting adds one access-log transaction every 3 seconds in that mode.
- **Live check on one machine only.** The reuse path was verified by tests, not live: no reusable authorization exists on the channel. Nothing was run on the four-VM testbed.

## Next

- Step 13 (privacy controls), unless the author changes the order.
- The author decides the paper wording for the trust model and for the recommendation actor.
