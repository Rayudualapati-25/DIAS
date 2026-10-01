# DIAS v3 integrity revision — plan of record

- **Date:** 2026-10-01
- **Approval:** on 2026-10-01 the author approved running all steps end to end without stopping for approval. The design defaults in Step 2 are the approved choices. Every choice must be written down so the author can review it afterwards.
- **Evidence it starts from:** `reports/paper_code_alignment_audit.md` (line numbers there refer to the code at tag `eval-baseline-2026-10-01`; check them before use).
- **Baseline:** `experiments/runs/20261001_eval_baseline/` (Step 1, done).

## Ground rules

1. **Branch.** All work happens on `feat/dias-v3-integrity`. Never push to or merge into `main`. `main` stays equal to the evaluated baseline until the experiments are rerun on the new code.
2. **Commits.** One commit or a few per step. Message format: `<type>: <description>`, then a body with What, Why and Tests. No co-author trailers and no tool-attribution lines in commits, pull requests, branch names or files.
3. **Test first.** For each change: write a failing test, make it pass, then run the package's full suite. Keep the baseline suites green (211 / 184 / 27 / 39 / 93, validator 25/25) apart from tests that the new design deliberately replaces; record each replaced test and the reason.
4. **Iteration reports.** After each step, write `reports/iteration/iter_0NN_<topic>.md` with: what changed, what worked, what is still weak, what comes next. Numbering continues from 058 (057 is the baseline). Numbers 055 and 056 exist only on the author's machine.
5. **Ignored names.** `.gitignore` silently drops report and plan files whose names contain `paper`, `manuscript`, `latex`, `rewrite`, `figure`, `svg`, `acm_`, `claim_aligned`, `results_reference_style` or `professor_review`. Do not use these words in new file names. Run `git status` after writing a file to confirm it is tracked.
6. **Raw evidence is read-only.** Never edit logs, `raw/`, predictions or metrics of earlier runs under `experiments/runs/`. Add labels next to them instead.
7. **No invented numbers.** Anything that needs the Fabric network, the four testbed VMs or the MLX model server is marked **NOT RUN — needs the author's Mac**, with the exact command to run.
8. **Model.** Training stays stopped. V7 is not activated, and no model is served.
9. **Other networks.** Never point scripts at `wt-dias` or `crime-records-network`.
10. **Network design.** Do not add an AI organization to the network; this was a design decision on 2026-09-15. The recommendation service signs with its own key and is not a Fabric organization.
11. **Final report.** Use plain language: short headings, numbered steps and bullets. For each step, give what changed, the test results and what is still weak. Then list the work that needs the author's Mac and give the pull-request link.

## Setup

- Node 22. Run `npm ci` in `chaincode/crimerecords` first, then in `backend`; the backend unit tests import `chaincode/crimerecords/lib`.
- `policies`, `frontend` and `experiments/dias-finetuning/v2` have no dependencies.
- Offline tests: `make test` and `node experiments/dias-finetuning/v2/validate.js`.

## Steps, in dependency order

| Step | Work | Required evidence |
|---|---|---|
| 1 | Preserve the evaluated system | Done: tag, test record, evidence manifest, superseded labels |
| 2 | Freeze the v3 design and ledger schema | `docs/design/dias-v3-ledger-schema.md` |
| 3 | Block inactive auditors | Tests for suspended or revoked ledger profiles and credentials |
| 4 | Re-check access at the final document download | Tests for suspension, revocation, expiry and wrong identity |
| 5 | Separate requester claims from verified facts | Schema-version bump and tests |
| 6 | Define and measure access logging | Which calls write to the ledger, and their measured cost |
| 7 | Expire pending requests | Tests for timeout, cancellation and late auditor decisions |
| 8 | Bind authorizations to the policy version | Old authorizations fail after a policy change |
| 9 | Hash the off-chain objects (h_J, h_M, h_N) | Canonical serialization and tamper tests |
| 10 | Commit the recommendation before review (κ) | Missing, duplicate and wrong commitments rejected |
| 11 | Enforce the auditor note in the contract | Note hash required for disagreement or a missing recommendation |
| 12 | Reduce trust in the backend | Signed recommendation provenance |
| 13 | Strengthen privacy controls | Restricted histories, evidence, explanations and decision log |
| 14 | Add counterfactual explanations | Only changes verified to alter the policy outcome |
| 15 | Update backend, frontend and testbed | All components use the new schemas and transactions |
| 16 | Complete verification | Full test list below |
| 17 | Rerun affected experiments | Offline experiments now; the rest prepared for the Mac |
| 18 | Update the manuscript | Outside this repository; not part of this branch |
| 19 | Prepare the public repository | Reproducibility, licences and clean-up; no release tag yet |

### Step 2 — design defaults (approved)

The design document must cover: what is on-chain and off-chain; who is trusted; the κ format; `policyVersion` and `policyHash`; h_J, h_M and h_N; the recommendation generation statuses; the auditor-note rules; request expiry; who may see decisions and explanations; how older ledger records are handled; and the new schema and chaincode versions.

- **Decision log:** full details for authorized auditors; redacted details for other organizations.
- **Pending-review expiry:** configurable, with an explicit EXPIRED outcome.
- **Recommendation service:** separately authenticated, and its output digitally signed.
- **Off-chain review data:** encrypted and hash-committed.
- **Policy change:** authorizations issued under an older policy version become invalid.
- **Older ledger records:** v3 is deployed on a fresh research network. Readers report the schema version, and records without one are treated as v2 and never reused.
- **Generation status:** all statuses reach the ledger, not only UNAVAILABLE.

### Steps 3–7 — small fixes

Starting points from the audit:

- **Step 3:** `SubmitAuditorDecision` and `RevokeDynamicAuthorization` in `lib/accessContract.js`; auditor roles in `lib/policy/authority.js`; ledger profiles in `lib/userContract.js`.
- **Step 4:** `AuthorizeRequestedDocumentRead` in `lib/recordContract.js` must re-check the grant basis (the existing grant re-check helper in the same file) and the requester's credential.
- **Step 5:** `lib/dias/verifiedRequest.js`; `CreateAccessRequest`; backend `routes/access.js`; `backend/src/dias/recommendationPrompt.js`.
  - Flags asserted by the requester (for example `emergencyFlag`) must not sit inside the verified context.
  - This changes the model's input, so V7's accuracy must be re-measured on the Mac. Say this in the step's report.
- **Step 6:** `backend/src/middleware/accessLogger.js` and `RecordAccessEvent` in `lib/auditContract.js`.
- **Step 7:** request statuses and `lib/dias/lifecycle.js`.

### Steps 8–12 — integrity core

- **Policy version.** Store `policyVersion` and `policyHash` in the access request, κ, the auditor decision, the reusable authorization and the final outcome. Reuse and release fail when the active policy differs. Add the policy-registration path the contract needs.
- **Hashes.** h_J (requester justification), h_M (full recommendation object), h_N (auditor note). Use deterministic canonical JSON, so equal objects always give equal hashes.
- **Pre-review commitment.** A transaction such as `CommitRecommendation(requestId, recommendation, generationStatus, recommendationHash, justificationHash, policyVersion, modelVersion, signature)`. One active κ per request. The auditor reviews exactly the committed object, and the contract derives the agreement from κ, not from a value the backend sends with the decision.
- **Auditor note.** Store the note off-chain first, then pass h_N to the decision transaction. The contract requires it for NOT_AGREED and NO_RECOMMENDATION. Retries must be safe.
- **Recommendation provenance.** The recommendation service signs its output with its own key. The backend cannot replace a recommendation without detection.

### Steps 13–15 — privacy, explanations, integration

- Restrict `GetRecordHistory`, `ListEvidence`, the public decision log and access to the full explanation.
- Encrypt the off-chain review store.
- Counterfactuals come from the reference policy oracle. Keep only changes that, when applied, actually flip the oracle's outcome.
- Update the backend API, the auditor and requester screens, the testbed scripts (add the missing `testbed/scripts/prepare-chaincode.sh`), the chaincode version in the `Makefile`, and the README.

### Step 16 — required tests

- Inactive auditor rejected.
- Inactive requester rejected at release.
- Revoked and expired authorization rejected at download.
- Old-policy authorization rejected.
- Changed justification, recommendation or auditor note detected.
- Missing, duplicate or wrong commitment rejected.
- Missing note rejected.
- Unauthorized explanation access rejected.
- Pending request expires correctly.
- Recommendation signature verified.
- Complete audit trail reconstructed.

Multi-VM tests and live UI checks: NOT RUN — needs the author's Mac.

### Step 17 — experiments

- **Offline, can run anywhere:**
  - commitment and hashing latency;
  - tamper detection;
  - policy-update invalidation;
  - storage overhead per record.
- **Needs the author's Mac** (Fabric testbed, MLX model). Prepare scripts and a run checklist with expected runtimes:
  - baseline versus proposed recommendation evaluation;
  - input ablations;
  - multiple seeds;
  - exact-scope reuse;
  - concurrent users;
  - one-hour stability;
  - orderer and peer faults;
  - ledger growth;
  - CPU, RAM and GPU monitoring.
- Store every configuration, log, metric and plot under `experiments/runs/<date>_<name>/`, `results/tables/` and `results/plots/`.

### Step 19 — repository

- `REPRODUCE.md`.
- Pinned Python dependencies for `testbed/analysis/` and `experiments/cross-dataset/`.
- Scripts for the result figures, built from tracked data.
- Dataset and external-data licence notes.
- Remove third-party PDFs from the tree and add them to `.gitignore`.
- Replace home-directory paths in scripts and configs. Document, do not edit, those inside raw logs.
- Move legacy content to `archive/` only after a dependency check shows nothing imports it.
- Run the tests from a clean clone.
- No release tag until Steps 17–18 are done.

## Finish

- Push the branch.
- Open a pull request into `main` with these sections: What changed, Why, Effect on the paper, and Not run — needs the author's Mac.
- Do not merge it.
