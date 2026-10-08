# Iteration 069 — privacy controls, and what the requester may read

- **Date:** 2026-10-08
- **Plan step:** 13.
- **Requirements:** A02, A03, A04 and I07 done. The contract was redeployed on this host the same day, so all of it is live there.
- **Author's instruction for this step:** the officer who made a request sees the LLM recommendation and explanation according to the auditor's decision.
  - Not allowed: the officer sees the LLM explanation of why, and the auditor's decision.
  - Allowed: the officer sees the necessary information.

## How the instruction was read

- **Before an auditor decides:** the officer sees nothing from the LLM, not even ALLOW or DENY.
- **Denied:** the officer sees the auditor's decision, the LLM recommendation, its written reason, the reason code, the policy clauses it cited, what it said was missing, and its review flags.
- **Allowed:** the officer sees the auditor's decision and the LLM recommendation value. The grant itself releases the case-file information, as before. The explanation is not shown.
- **No auditor decision** (a reused authorization, an expiry, a cancellation): nothing from the LLM.
- **Never shown to the officer:** the auditor's note, and how the recommendation was produced.
- This reading is one function, `requesterView` in `backend/src/dias/recommendationDetail.js`. If "necessary information" should include the explanation for an allowed request, that function is the only place to change.

## What changed

### 1. Contract: who may read what (design §10)

- **Record history:** reviewers and the owning station only. It was open to every identity.
- **Evidence list and custody chain:** reviewers, and same-district members of the police, forensics, prosecution and court. They were open to every identity.
- **Decision log:** full for reviewers. Every other identity, the requester included, receives reduced entries: outcome, basis, decision, LLM recommendation, agreement, generation status, action, purpose, the requester's organization and the time. Names, case files, authorizations and transactions are dropped.
- **Recommendation before the decision:** the contract returns a withheld commitment to the requester until an auditor decision exists, in `GetRecommendationCommitment` and in the request audit trail (commitment, summary and lifecycle event).
- **Inactive members:** a station or district member whose certificate credential is not active is refused record history and evidence. This was added before the redeploy; the design did not state it.
- The rules are in one new module, `chaincode/crimerecords/lib/dias/visibility.js`.

### 2. Backend: the LLM's account and the off-chain text

- `GET /access/request/:id/recommendation` now reads the ledger's request trail as the caller and applies the rule above. An audit-organisation district head reads everything at any time. Anyone else is refused with 403.
- The justification, the recommendation and the auditor's note in a reviewer's trail are sent only to audit-organisation district heads. Court and prosecution reviewers receive the check of each object against its ledger digest, without the text.

### 3. Backend: the review store is encrypted at rest

- AES-256-GCM with a fresh 96-bit IV per write. The request identifier is bound in, so a file moved to another request does not open.
- The key comes from `DIAS_REVIEW_STORE_KEY` and `DIAS_REVIEW_STORE_KEY_ID`; earlier keys go in `DIAS_REVIEW_STORE_PREVIOUS_KEYS`. `scripts/dias/review-store-key.js` creates a key.
- The backend does not start without a key.
- Entries written before encryption are still read, and are encrypted when the backend starts.

### 4. Screens

- **Request access:** a decided request now shows the auditor's decision and the LLM recommendation; a denied one also shows the LLM explanation.
- **Decision log:** shows the reduced table when the ledger sends reduced entries. The "Why" button is only for audit-organisation district heads.
- **Audit trail:** tells a court or prosecution reviewer why the off-chain text is not shown.

## Tests

- **Contract:** 341 passing (was 321); statements 93.12%, branches 86.47%.
  - `diasPrivacy.test.js`, 20 new tests, seen failing first.
  - **Changed baseline expectation:** three decision-log tests in `diasAccessWorkflow.test.js` read the log as a constable or an inspector and expected full entries. They now read it as a reviewer. The reduced entries are tested in `diasPrivacy.test.js`. This is the intended change of step 13.
- **Backend:** 319 passing (was 293).
  - explanation access: 10 tests for the requester at each stage, the auditor, and other organisations;
  - off-chain text: 3 tests for the auditor, another reviewer and the requester;
  - encryption: 10 tests (round trip, fresh IV, wrong key, changed ciphertext, IV or tag, moved file, rotation, older entries, no key, configuration);
  - runtime: start-up refuses without the key, and the stored file is encrypted after a real request.
- **Frontend:** 77 passing (was 71); syntax check passes.
- **Policies:** 27 passing. **Dataset:** 104 passing.

## Live check (single machine, 2026-10-08)

- A key was created in the ignored `.env` with the new script, and the backend was restarted.
- Start-up log: recommendations resumed 0, older reviews encrypted 2. Both files on disk are encrypted envelopes.
- As `sp.north`: the justification of the waiting request reads back, its recommendation still verifies against the ledger, and the decided request's justification, recommendation and note all verify.
- As `insp.sharma`, against the real backend and ledger:
  - the waiting request `REQ-4a97d0bb8d965008`: nothing from the LLM;
  - the allowed request `REQ-24601cfdab132c5f`: FORCE ALLOW by `sp.north`, LLM recommendation ALLOW, agreed, and no explanation. The screen shows this with the case-file metadata.
- A denied request does not exist on the ledger, so the denied screen was checked with a simulated answer: decision, recommendation, written reason, reason code, clauses, missing evidence and flags are shown, and no case-file metadata.

## Redeploy and live verification (2026-10-08, afternoon)

The author asked for the redeploy and for every test needed to confirm the system works. Plan: `experiments/plans/20261008_step13_redeploy.md`. Evidence: `experiments/runs/20261008_step13_redeploy/`.

- **Redeploy:** `diasrecords` on `diaschannel` went from version 2.2, sequence 1 to version 2.4, sequence 2. All five organizations approved, and the commit was valid on all five peers. Channel height went from 140 to 146. The ledger state was kept; `crimechannel` was not touched.
  - Label 2.4 was chosen because 2.2 was on this channel and 2.3 is the label of the code evaluated on the testbed. The Makefile default is unchanged; the final v3 label belongs to plan step 15.
  - Identities were reached through a temporary symlink layout, as on 2026-10-06. Nothing was copied.
  - Every peer answered a query from the new contract. The containers of the 2.2 contract are no longer running.
- **Automated suites after the redeploy:** contract 335, backend 312, frontend 76, policies 27, dataset 104. No failures.
- **Live check of the new rules** (`experiments/check-step13-live.js`): 42 of 42 passed, nothing left unexercised.
  - **Denied, real data:** `REQ-4a97d0bb8d965008` was denied by `sp.north` against an LLM ALLOW. Before the decision the officer's trail withheld the recommendation and the officer read nothing from the LLM. After it, the officer read the decision, the recommendation and the explanation, and never the auditor's note.
  - **Refusals:** `const.verma`, `pp.mehta` and `judge.rana` were refused the LLM account of that request. The court reviewer received the verification of the off-chain objects without their text.
  - **Reuse:** the model recommended DENY for `insp.singh` (another district). FORCE ALLOW created `AUTH-505ba2efddcbcfb2`. The repeat request was granted at once, no recommendation was made for it and no review file was written. The authorization was revoked again, the next request went back to the auditor, and it was cancelled.
  - **Decision log:** reduced for `insp.sharma`, `analyst.rao` and `pp.mehta`, with no name, case file, request or transaction in it. Full for `sp.north`, `judge.rana` and `sp.south`.
  - **Record history:** readable by the owning station and reviewers; refused for another station, another organization, and a reviewer organization without the role.
  - **Evidence list:** readable by same-district police, forensics and prosecution and by a reviewer of another district; refused for a police officer of another district, also through the API (403).
  - **Store:** every review file on disk is encrypted.
- **Live check of the normal workflow** (`experiments/check-dias-host.js`): 15 of 15 passed, from sign-in through the model's recommendation, the commitment, the auditor decision, the audit trail, the authorized metadata read and the vault hash (`REQ-c86e69fe1680a3d6`).
- **Screens:** the access log showed all six settled requests with every case; the denied officer's screen showed the real LLM explanation; the decision log showed the reduced table for an officer. One wording fault was found and fixed there: a cancelled request said "LLM not consulted"; it now says "Not recorded: no decision was made".

## Security review, fixes and second redeploy (2026-10-08, afternoon)

An independent security review of step 13 gave "Warning": 1 high, 2 medium and 6 low findings, none critical. It confirmed that a police requester cannot learn the recommendation before the decision through any contract or backend path, that the reduced log drops every identifier, and that the new screens have no script injection.

- **High, fixed:** the requester rule failed when the requester was also a reviewer or an auditor. A court judge or an audit district head could read the recommendation of their own request before the decision, cancel, and ask again.
  - Contract: the requester rule now comes before reviewer rights in the request trail and in `GetRecommendationCommitment`. The trail says `isRequester`.
  - Contract: a district head is refused the auditor view of their own request, and it is left out of their queue.
  - Backend: whoever made the request gets the requester's view, also when they hold an auditor or reviewer role. A reviewer who is the requester no longer gets 403 after the decision.
- **Medium, fixed:** the private evidence detail was not scoped to the district. It now follows the evidence rule.
- **Medium, fixed:** one stored review that could not be opened returned an error to every auditor's queue. Such an entry is now reported and treated as absent, so a decision on it is refused as "object not available".
- **Medium, fixed:** entries sealed with an earlier key were never re-sealed. Start-up now re-seals them, encrypts entries left in the clear, and counts what it cannot open.
- **Low, fixed:**
  - the authentication tag must have its full length;
  - an encrypted store refuses an entry in the clear after start-up;
  - writes are flushed before the rename;
  - the requester's trail no longer carries the digest of the auditor's note;
  - a denied officer whose explanation is missing from the store is told so, instead of "no recommendation".
- **Second redeploy:** version 2.5, sequence 3, five approvals, valid on five peers.
- **Results on the corrected deployment:**
  - contract 341, backend 319, frontend 77, policies 27, dataset 104, no failures;
  - live check of the rules 59 of 59, now including a court reviewer (`judge.rana`) and an audit district head (`dj.north`) as requesters of their own requests;
  - live check of the normal workflow 15 of 15;
  - the access log screen showed all 13 settled requests, and the auditor queue was empty.

## What is weak
- **These are interface controls.** Every member's peer stores every block, so an organization reading its own peer sees every request record.
- **The key sits with the backend.** Encryption protects copies and backups of the store, not the running backend. Losing the key in `.env` loses the stored reviews; the ledger keeps only their digests.
- **Disagreement on a denial.** When the LLM recommended ALLOW and the auditor denied, the officer sees the LLM's explanation as it was given and that the auditor did not agree. The auditor's own reason stays with the auditors.
- **Testbed scripts.** The load and reuse scripts read review files directly and wait for the old `ready` state. They need the store key and the v3 state before any rerun (step 15). The testbed backend also needs the two key settings.
- **`scripts/inspect-ledger.sh`** calls `GetRecordHistory` with an administrator identity, which the new rule refuses (step 15).
- **Version label.** This host runs label 2.4 while the Makefile default is still 2.2. A plain `make dias-deploy` here would try to deploy label 2.2 again at the next sequence.
- **Credential check on reads.** Station and district readers are checked against the certificate only, and reviewers not at all. A member suspended in the ledger profile but holding an active certificate is still let through.
- **Digests are not salted.** Someone who sees the digest of a justification or a note can confirm a guessed text. The requester no longer sees the note digest; reviewers do.
- **Chaincode events.** The lifecycle event of a commitment carries its generation status. The backend exposes no events, so a requester cannot reach it, but a member organization can.
- **Older reviews.** 64 reviews from earlier runs sit in `backend/data/dias-reviews/` in the clear. The running backend uses a subdirectory and never touches them.
- **Experiment trace.** When `DIAS_TRACE_FILE` is set, recommendation values are logged in the clear.
- **Demo sign-in.** The backend issues a token for any registered username without a secret. Every backend rule in this step assumes real authentication.
- **A district head's own request.** The start-up settlement of staged notes runs as one audit identity; for a request that this identity made itself it is now refused and the note stays staged.
- **Reduced log and identity.** A reduced entry keeps the exact time and the requester's organization. Someone who also knows when a colleague made a request can match the two.

## Next

- Step 14 (counterfactual explanations), which follows the same requester rule.
