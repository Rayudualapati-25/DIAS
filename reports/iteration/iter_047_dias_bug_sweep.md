# Iteration 047 — Repository bug sweep and publication readiness

**Date:** 2026-09-15
**Branch:** `dias-backend-llm` (no commits made)
**Live evidence:** `experiments/runs/20260915_dias_backend_llm_acceptance_170525/`
**Result:** 11 defects found and fixed; every offline suite, the live API suite,
the acceptance run, and the permissioned-network proof pass.

## 1. Request

"Check for bugs in the project and solve them, making the whole system
functional and ready for publishing repo." The standing constraints applied:
work only inside `DIAS/`, leave `wt-dias` and `crime-records-network` untouched,
keep negative evidence, and commit only when asked.

## 2. How the sweep was run

- **Every CI step locally:** `make check` (publication boundary, Compose, shell),
  `node --check` on every tracked and untracked JavaScript file, `py_compile`,
  `bash -n`, the four npm suites, and the production dependency audits.
- **API probe:** every GET route for all thirteen seeded identities (198 calls),
  looking for 5xx answers and for refusals that should have been grants.
- **Flow probe:** request → LLM → auditor decision → metadata → full-document
  request → upload → PDF download, byte-compared.
- **Browser:** each module opened as several roles, console and network errors
  read, the requester and auditor journeys driven end to end.
- **Fresh-clone simulation:** the exact publication set
  (`git ls-files --cached --others --exclude-standard`, 2,212 files) copied to a
  clean directory, dependencies installed from the lockfiles, then `make check`
  and `make test` — both exit 0 there.

## 3. Defects found and fixed

| # | Defect | Effect | Fix |
| --- | --- | --- | --- |
| 1 | `/api/explain/:record/:decision` read SEAL decision fields DIAS never writes | Every granted request showed "Plain-language wording is unavailable … internal error" | Route unmounted and deleted; the frontend now renders a DIAS decision summary (`accessDecisionView`); the architecture guard fails if `backend/src/llm/` becomes reachable again |
| 2 | Case-file lookup used `RecordContract.GetRecord` | An officer outside the owning station searching `REC-FIR-001` was told "No case or case file called …" — the cross-district journey the paper is about | `QueryRecords` accepts an exact `recordId` filter (chaincode 2.1) and the lookup route reads that public index |
| 3 | Officer registration refused any department but the caller's own | `UserContract` admits officers only through an AuditMSP district head, so no police, forensics, prosecution or court officer could be registered from the UI | Backend `administrationRefusal` mirrors the chaincode; the form now chooses the department and filters roles by it; the same guard covers status changes |
| 4 | Frontend role groups did not mirror the chaincode | Screens were offered to users the chaincode refuses (a prosecutor saw every audit screen; an oversight SP saw "File a record"; case workflow was offered to the retired `sho` role) | `core/access.js` rebuilt as organisation+role rules; `frontend/test/access-roles.test.mjs` checks them against the chaincode tables |
| 5 | `make all`, `make backend`, `make deploy` targeted the retired deployment, and the Makefile exported `CHANNEL=crimechannel` to every recipe whenever `.env` existed | `make all` then `make backend` could not sign in; `make backend` alone pointed the API at `diasrecords` 1.0 on `crimechannel` | Base-channel variables renamed (`BASE_CHANNEL`), `all` = `up seed dias-all`, `backend` = `dias-backend`, `deploy` = `dias-deploy`, seed steps pinned to the DIAS channel |
| 6 | `make smoke` ran `backend/test/api.test.js`, which does not exist | The documented smoke command always failed | `scripts/smoke-test.sh` runs the live API suite; `make test-live` is the same target |
| 7 | `backend/test/api.live.test.js` still described the listener design | The live suite could not pass | Rewritten for the current design: 16 tests, all passing |
| 8 | `make prove` and `make inspect` targeted `crimechannel` with SEAL-era expectations | Both failed against the current system | Retargeted to `diaschannel`/`diasrecords` with `ORG_SET=dias`; proof writes now go to a dedicated `CASE-PROOF` case; the authority checks use the AuditMSP roles the chaincode enforces |
| 9 | A form `pattern` used an unescaped `-` at the end of a character class | Browsers compile `pattern` with the RegExp `v` flag: the attribute was rejected, logged an error on every search, and the field lost its validation | Hyphen escaped; `frontend/test/form-patterns.test.mjs` compiles every pattern the way a browser does |
| 10 | A commit conflict (MVCC/phantom read) surfaced as HTTP 500 "internal error" | An auditor decision lost to a concurrent write looked like a server fault; the earlier design's log shows this happening | Bounded retry in the gateway (codes 11 and 12 only) and a 409 with a plain explanation when the retries are exhausted |
| 11 | `readiness.js` still scored the retired 2026-09-12 run, and counted a `.log` file as a V7 training run | The completion checklist reported evidence that does not describe the current system | It now reads the newest `*_dias_backend_llm_acceptance*` run and only directories |

Smaller corrections in the same pass: the review store skips an unreadable entry
instead of failing the whole backend start-up; a request whose off-chain review
cannot be saved still answers 202 and is decided with `NO_RECOMMENDATION`; the
access logger no longer maps retired routes (an unknown route is logged by path
with no body fields); `.env.example` documents the DIAS settings instead of only
SEAL-era ones; the acceptance runner refuses to overwrite an earlier run and
keeps its own `runner.log`; stale comments in `.gitignore`, `network-down.sh`,
`seed-domain.js` and several screens now describe the current design; and the
dead `record-lookup.js` and `explanation.js` frontend modules and the two
orphaned SEAL-era scripts (`verify-ai-peer-flow.js`, `ensure-llm-signing-key.js`)
were removed — all four are kept in the before-change snapshot
`experiments/runs/20260915_dias_backend_llm/before/`.

## 4. Deployment

`diasrecords` **2.1**, sequence 2, approved by all five organizations and
committed on `diaschannel`
(tx `33a3175400edd48723a7207a4ea88b76950ba53e8d02a5a8f73d2bbef3db40d6`). The only
chaincode change from 2.0 is the public case-file index filter; the access
workflow is untouched. `crimechannel`, the SEAL-era `crimerecords` deployment,
`wt-dias` and `crime-records-network` were not modified.

## 5. Verification

| Check | Result |
| --- | --- |
| `make test` (chaincode / backend / policies / frontend / dataset) | 208 / 168 / 27 / 37 / 93 passing |
| `make check` (publication boundary, Compose, shell syntax) | exit 0 |
| Fresh-clone simulation of the publication set | `make check` and `make test` exit 0 |
| `make smoke` (live API suite) | 16 passing |
| `make dias-acceptance` | 14/14 scenarios, 81/81 checks |
| `make prove` | 12 checks passed, 0 failed |
| `make inspect` | reads `diaschannel`: five members, equal heights, 3-of-5 endorsements, committed definition 2.1 |
| API probe, all roles | 198 answers, no 5xx |
| Browser | no console errors; cross-station lookup, granted-decision view, auditor queue and registration form all correct |
| `npm audit --omit=dev --audit-level=high` | backend and chaincode pass (backend carries 3 moderate `qs` advisories through express) |
| `readiness.js` | 27/28; the remaining item is "the working tree has no unexplained changes", which needs a commit |

Recommendation latency in the 2.1 acceptance run: 11 recommendations,
4.63–8.58 s of inference, median 6.78 s, one request at a time on a Mac that was
also running other work. The 2.0 run measured 2.39–7.48 s, median 3.36 s. Neither
is a controlled measurement.

## 6. What the verification left on the ledger

- The acceptance run's 14 requests, one revoked and one expired authorization.
- `make prove`: the case `CASE-PROOF`, the record `FIR-QUORUM-1789491864` with one
  evidence commitment, and a suspension of `const.verma` that the script reverted
  (verified: the account is active again).
- The flow probe: one granted request for `REC-FIR-001` and a 45-byte placeholder
  PDF in the police vault.
- One request is still waiting for an auditor (`REQ-91d034e8fe30e5d9`,
  insp.sharma, annotate), left deliberately so the auditor screen has work to
  show.

## 7. Left for the researcher to decide

- **Nothing is committed.** 183 working-tree entries, including this iteration's
  fixes, the earlier redesign, and untracked evidence from the V7 runs and paper
  rewrites.
- `experiments/runs/20260912_dias_live_fabric/api-server.log` and `listener.log`
  gained lines after that run was recorded, from processes that kept writing to
  them. They are left as they are; committing or restoring them is a call about
  evidence, not code.
- The base network still starts the six-organization `crimechannel` with the AI
  organization's peer and CA. Removing it entirely means changing the Compose
  files, `registerEnroll.sh` and `seed-identities.sh`, which cannot be tested
  without tearing down the running network.
- The Caliper suite still measures the SEAL-era deployment; it has not been
  retargeted to DIAS.
- `CITATION.cff` now names DIAS, but its `version` and `date-released` still come
  from the SEAL release.
- Third-party papers under `reports/research/**/llm_sources/` would be
  redistributed by publishing; their licences have not been checked here.
- The three moderate `qs` advisories could be cleared with `npm audit fix` in
  `backend/`, which rewrites the lockfile.
- The paper's Implementation and Results sections still describe the AI
  organization.
