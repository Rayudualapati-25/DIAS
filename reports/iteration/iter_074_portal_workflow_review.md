# Iteration 074 — Search, auditor decisions and blockchain workflow logging

Date: 2026-10-12. Requested behavior: Search starts access evaluation; the LLM
advises and the auditor makes the binding decision. Exact reusable authorization
skips the LLM and new review. The requester sees the committed outcome, and all
workflow stages are reconstructable on Fabric. Plan:
`experiments/plans/20261012_portal_workflow_review.md`. Run evidence:
`experiments/runs/20261012_portal_workflow_review/`. Comparison: `results/tables/20261012_portal_workflow_review.csv`.
Baseline source: `60a92b0ba53fb019fcff65bbbcbdf4ed8dd832b4`.

## Review scope and interpretation

Reviewed the active portal modules/API, enrolled identity boundaries, public case
and record discovery, backend request/recommendation/review store/worker,
chaincode authorization/commitment/decision/outcome/release contracts, event
logging, and step 15 acceptance/load/reuse interfaces. Also checked native
Android client/repository coverage and distinguished the retained SEAL/oracle,
training, old generators and old result artifacts from runtime DIAS. Existing
architecture guard, privacy, policy-binding, release, signature, expiry, model
failure and dataset suites were included in regression. This is a workflow
review with bounded verification, not a claim of exhaustive security assurance
for every historical notebook, artifact or dependency.

Discovery exposes identifiers and ownership to enrolled users. It does not
release a protected PDF or narrative. Search collects operation, purpose and a
meaningful reason. A unique record, case-number match or evidence parent submits
immediately. Several matching files require choosing a target rather than
silently requesting them all. Existing evidence custody/private-collection
rights remain a separate district/member permission path; this change does not
claim that every evidence API now requires a DIAS auditor grant.

## Findings and fixes

| Finding | Effect before change | Correction and evidence |
| --- | --- | --- |
| Search and request were separate | Clicking lookup did not start the LLM workflow | One Search form resolves the scope and submits; helper fixtures and browser `search-request.txt` prove the request |
| Request history used browser IDs | A new session could lose previous request navigation | `QueryMyAccessRequests` returns only the signing identity's ledger history; fresh-session browser proof includes prior denial/cancellation |
| Access log read settled decisions only | Requests awaiting review, preparation and current authorization checks were absent | Reviewer-only `QueryAccessWorkflowLog` reconstructs advice, decision, outcome and reuse; `pending-workflow-row.json` and `access-log-final.txt` |
| Arbitrary query filters could enter application logs | Unvalidated/private fields could be copied even on a refused call | Identifier/field allowlists; baseline copied marker=true, updated=false in `log-target-comparison.json` |
| Failed application event submission was discarded | Searches/reads could be lost during transient Fabric failures | Encrypted local event staging and retry with per-identity idempotent receipts; outbox isolation tests |
| Signed recommendation retry required restart | A transient commitment failure could leave an otherwise complete review stuck | 15-second recovery resumes the stored signed object without another LLM call; worker isolation test |
| Cancelled requests were presented as denials | Requester saw a misleading auditor outcome | Closed/cancelled presentation with no access; `cancelled-request.txt` |

The existing binding decision mechanism was retained: the backend automatically
produces and commits signed recommendation κ after a reuse miss; the auditor
reviews that object; Fabric derives agreement and final outcome. Exact reuse
checks current identity, record, operation, purpose, credential and policy scope
without creating a model review. Release still rechecks eligibility/current
policy/authorization and protected payload hash. Pending recommendation privacy
also applies when a reviewer is the requester. No counterfactual or other
ledger-derived explanation was restored; the existing LLM explanation remains.
Requests and workflow writes are already atomic ledger records. Separate logged
reads/searches use encrypted staging before a buffered response ends, then
asynchronous Fabric submission. Staging failure returns 503 before releasing
that response. Failed/unreadable entries are retained; overlapping flushes and
confirmed-submit retries do not duplicate the ledger event. This covers tested
process restart/timeout recovery, not a proof against every power-loss or disk
failure scenario. Staging adds local I/O; its latency impact has not been measured.

## Verification and component isolation

| Check | Result | Evidence relative to run directory |
| --- | --- | --- |
| Existing baseline package regression | 868 pass, 0 fail | `baseline-tests.log` |
| Expected new regressions against baseline | Missing Search/history/staging/recovery and incomplete pending-log presentation detected | `baseline-search-tests.log`, `baseline-history-tests.log`, `baseline-pending-log-tests.log`, `baseline-recovery-tests.log`, `baseline-retry-tests.log` |
| Changed worktree regression | 350 chaincode + 326 backend + 27 policy + 83 frontend + 104 dataset = 890 pass, 0 fail | `updated-tests.log` |
| Isolated staged source, excluding older mobile edits | 350 + 320 + 27 + 83 + 104 = 884 pass, 0 fail | `clean-index-tests.log`, `clean-index-config.json` |
| Step 15 acceptance/load/reuse script regression | 25 pass, 0 fail, also in staged source | `script-tests-complete.log`, `clean-index-script-tests.log` |
| Real model and Fabric workflow | 21 pass, 0 fail | `live-04/summary.json` |
| Browser workflow | Search creates review; auditor sees committed advice; requester sees final outcome; new-session cancelled history correct; workflow log shows reuse and approval separately | `search-request.*`, `auditor-recommendation.*`, `requester-final-decision.*`, `cancelled-request.*`, `access-log-final.*` |
| Final health | API responsive; no pending staged application events at observation | `final-health.json` |

The six additional worktree backend tests belong to pre-existing uncommitted
mobile work, which is excluded from this source commit. Staged-source tests
reuse installed dependencies rather than proving a fresh dependency install.
Isolation/fault cases cover absent helper/API, ambiguous target without hidden
requests, exact reuse with no model work, non-reviewer rejection, self-requester
recommendation withholding, unchanged privacy marker filtering, encrypted event
retry after failure/restart, unreadable event retention, overlapping drains,
changed retry rejection, staging failure preventing buffered release, and
transient signed-commit recovery with no repeat model call. Existing regression
covers unavailable model/release/policy failures. These are engineering checks
and component isolation, not baseline/proposed model-quality experiments or
research-performance ablations.

Three live verification-script attempts failed before the final successful run:
`live` used the wrong decision field (8 checks passed), `live-02` used the wrong
lifecycle field (9 passed), and `live-03` expected an evidence `entries` wrapper
instead of the endpoint's array (16 passed, 1 failed). The test adapters were
corrected; production evidence lookup was already returning the expected array.
All failed evidence is retained. An initial script command exercised only three
checks; the complete corrected 25-check run is the reported evidence.

The browser request `REQ-e3c8b66127918eec` acquired a committed FORCE_ALLOW while
verification was in progress. A subsequent attempted decision was refused as
already decided, and requester display matched the committed grant. The actor
of that concurrent action was not independently identified; it is not claimed
as a decision issued by this review. `ui-decision-race.json` preserves the
observation. Separate synthetic API requests verify committed denial and reuse.

## Development-host deployment and retained state

Upgraded only the existing Mac DIAS definition from 2.5/sequence 3 to
3.0/sequence 4 after offline checks. All five organization approvals are
observed; commit was validated by their peers. Prior and current definitions,
heights, config and block observations remain in `ledger-before/` and
`ledger-after/`; deployment output is `deploy.log`. Package identifier:
`diasrecords_3.0:5fbef89a8a17e237554278c977112e47fedd39e86ad1486233845171d5c61be5`.
The temporary deployment layout is recorded in `deploy-layout.json`; reviewed
source hashes are in `source-digests.json`.

The channel, identities, prior requests, records and other channel were not
reset. The backend was restarted against the new definition. Existing
untuned Qwen3-14B on port 8081 was preserved; V7 was not trained or activated.
Synthetic requests/access records and two evidence fixtures remain auditable.
Temporary authorizations `AUTH-3432dd181196d76a` and
`AUTH-4382058e054ac0b7` were revoked; the final evidence parent request was
cancelled. Live IDs and timestamps are generated, so reruns reproduce behavior,
not exact transaction identifiers. No private keys, authentication tokens or
review-store files are included in the evidence bundle.

## Worked, weak and next

Worked: automatic Search submission, real LLM recommendation and signed ledger
commitment, auditor final decision, requester visibility, exact reuse without
model work, complete workflow rows, scoped public evidence discovery, retained
application-event retry, and unchanged step 15 script checks.

Remaining: native Android has login/case summaries/SQLite/manual refresh but no
complete request/auditor parity. The five-organization network is on one Mac;
step 16 four-VM deployment/full acceptance and step 17 accuracy/load/fault/
stability/ablation reruns remain pending. Prototype sign-in still selects
custodial identities rather than proving production officer possession of a
private key. New history/evidence APIs scan world state (result limits do not
bound scan work); indexes/pagination need evaluation under load. Existing
certificate-based reviewer/member reads and expiry sweep self-request coverage
are further review limitations. Anonymous failures cannot be honestly signed
as an enrolled user; unreadable staged files need operator/key recovery.

Next refinement: implement native request/review/decision/history screens on the
same API, then deploy current source on the isolated testbed and rerun the
planned model baseline/proposed comparisons and load/fault/component ablations.
No end-to-end latency, accuracy improvement or publication-readiness claim is
supported by this iteration; existing paper numbers still require those reruns.
