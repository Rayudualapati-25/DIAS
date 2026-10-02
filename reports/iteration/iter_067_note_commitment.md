# Iteration 067 — auditor note commitment h_N

- **Date:** 2026-10-02
- **Plan step:** 11.
- **Requirements:** M11, M13, M19 and M26 done; I07 done except encryption (step 13).

## What changed

- **Contract:**
  - `SubmitAuditorDecision` refuses a decision recorded as NOT_AGREED or NO_RECOMMENDATION when it carries no `noteHash` (`DIAS_NOTE_REQUIRED`). The refusal writes nothing.
  - An agreeing decision may carry a note digest, or none.
  - `GetAuditorReview` now returns `{request, commitment, decision}`. The backend uses the decision to settle a note after an uncertain submission.
- **Backend:** the note protocol of design §11.
  1. Validate: up to 2,000 characters (it was 500), trimmed, and required for disagreement or no recommendation.
  2. Stage `{noteHash, text, decision}` in the review store before anything is sent. A request with no review entry gets a note-only entry.
  3. Submit the decision with `h_N` only.
  4. On success, the note becomes the committed `auditorNote`.
- **When the submission fails:**
  - **the contract refused:** the note is dropped and the refusal is passed on (as before, an expired or stale-policy request is also closed);
  - **the outcome is unknown** (a timeout, a lost response): the decision is read back from the ledger.
    - If it is there, the call succeeds (201, `recoveredFromLedger`) and the note is committed.
    - If not, the note stays staged and the auditor gets HTTP 503 "not confirmed", never "nothing was recorded".
  - **a retry on a decided request:** refused with 409 "already decided", and its staged note is settled. A second decision is never submitted.
  - **at start-up:** `reconcileStagedNotes` settles every note a stopped process left staged. It commits, drops or keeps each note according to the ledger, and counts the ones it cannot read.
- **Audit reconstruction (M19):** a reviewer's request trail now includes `offChainVerification`. For the justification, the recommendation object and the note, it reports `verified`, `mismatch`, `missing` or `not-committed`.
- **Browser:**
  - API errors now carry their HTTP status.
  - The auditor screen separates three cases:
    - a refusal ("nothing was recorded");
    - an unconfirmed decision (503, or no response at all): "reopen before deciding again";
    - a request already decided.
  - The note box allows 2,000 characters and says that only the note's fingerprint goes on the ledger.
  - The audit-trail screen shows the verification of each off-chain object.

## Tests

- **Contract:** `diasNoteCommitment.test.js`, 9 tests. The 4 note-required cases failed before the change, and so did the read-back test.
  - **Changed baseline expectation:** the auditor review's keys gain `decision` (`diasAccessSecurity.test.js`). This is intended: it is the read-back the note protocol needs.
- **Backend:**
  - `auditorNote.unit.test.js`, 13 tests: the store, the route (durable before submit, refusal, lost response that committed, unknown outcome, retry on a decided request, optional note, length limits, no review entry) and start-up settlement;
  - `offChainVerification.unit.test.js`, 6 tests.
  - The shared decision fixtures moved to `test/fixtures/decisionFixtures.js`; the route tests are otherwise unchanged.
- **Browser:** 2 tests (failure messages, verification rows).
- **Suites:**
  - chaincode 321 passing (statements 92.68%, branches 85.66%);
  - backend 278 passing (statements 82.64%);
  - frontend 50/50;
  - policies 27/27;
  - dataset 104/104.

## What is weak

- **No atomicity across stores.** A committed decision whose note file is later lost keeps its `h_N`. That proves only that a note with that digest existed; the text cannot be recovered.
- **"Unknown" depends on how the error is classified.** A refusal is recognized by a chaincode message or a commit conflict. Any other error counts as unknown, so the note is kept staged rather than dropped. That choice is safe, but an operator may see staged notes for decisions that were never sent.
- **Not run.** Nothing here was run on Fabric. `testbed/load/run-ledger.js` (W2) still sends the v2 arguments, which the v3 contract refuses. It is updated in step 15.

## Next

Step 12: the recommendation service as a separate, authenticated process, so the backend no longer holds the signing key.
