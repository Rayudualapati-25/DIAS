# DIAS Crime Records Network

DIAS is a research prototype for **Dynamic and Explainable Access Control for
Blockchain-enabled Inter-organizational Data Sharing** among five organizations
on a permissioned Hyperledger Fabric channel. The LLM runs in the application
backend; there is no AI organization.

**The model recommends, a human auditor decides, and only an auditor's override
of a model DENY can create a reusable authorization.** Everything in the
codebase exists to make that true by construction rather than by convention.

It is not a CCTNS/ICJS replacement and it is not a production police system. All
demonstration data is synthetic, and the governance policy is a synthetic
research policy, not an official one — see
[`docs/policies/policy-open-questions.md`](docs/policies/policy-open-questions.md).

> **Standalone DIAS snapshot.** This folder is an independent copy containing
> the application, Fabric configuration, retained evidence, and the model-portable
> synthetic fine-tuning datasets. Changes here do not modify the original
> `wt-dias` worktree or the `crime-records-network` tree that holds V6.

## Start here

| To understand | Read |
| --- | --- |
| How the system is put together and why | [`docs/architecture.md`](docs/architecture.md) |
| What happens on one request, end to end | [`docs/walkthrough.md`](docs/walkthrough.md) |
| The retired AI-organization design (historical) | [`docs/ai-as-network-participant.md`](docs/ai-as-network-participant.md) |
| The governance policy of record | [`docs/policies/governance-policy-specification.md`](docs/policies/governance-policy-specification.md) |
| Decisions that were open, and how they were resolved | [`docs/policies/policy-open-questions.md`](docs/policies/policy-open-questions.md) |
| The training/evaluation dataset | [`experiments/dias-finetuning/v2/README.md`](experiments/dias-finetuning/v2/README.md) |

## Architecture

The component, trust-boundary, scope and ledger design is in
[`docs/architecture.md`](docs/architecture.md). Older architecture figures are
retained as historical artifacts and do **not** describe the DIAS authority flow.

```text
Browser
  -> Node.js API (validation and Fabric Gateway, signing as the logged-in user)
  -> chaincode commits the request log (who requested which record, action, purpose)
     and checks the latest active dynamic authorization in the same transaction
     -> exact match: GRANTED automatically; the model and the auditor are skipped
     -> no match:    the backend asks the LLM for an advisory ALLOW/DENY
                     recommendation and keeps it off-chain for the auditor screen
                     (or stores that none could be produced)
                     -> an AuditMSP district head chooses FORCE_ALLOW or FORCE_DENY
                     -> the chaincode commits the decision log: the decision and
                        whether it AGREED, NOT_AGREED, or had NO_RECOMMENDATION
                     -> ONLY FORCE_ALLOW that did not agree with an LLM DENY
                        creates an exact-record dynamic authorization
  -> only a granted outcome releases metadata and permits a PDF request, and the
     grant basis is re-checked at release time
  -> the owning station uploads the PDF off-chain; Fabric records its hash and release
  -> every settled request appears in the decision log, which any signed-in identity
     on the channel can read: who asked for which case file, what was decided, by
     whom, and whether it agreed with the LLM
```

The identity that raised a request may never decide it: an auditor who opens
their own request finds both buttons disabled and is told which other district
head can decide it.

Fabric is authoritative for application-domain state:

- departments and identity-backed user profiles;
- cases, record metadata, content hashes, and off-chain references;
- access requests (who requested which record, with the action, purpose and
  verified facts), auditor decisions with their LLM agreement, access outcomes,
  and exact-record dynamic authorizations with their full lifecycle. The LLM
  recommendation, the requester's justification and the auditor's reason are
  kept off-chain in the backend's review store (`backend/data/dias-reviews/`);
- evidence metadata, custody transfers, court workflow, and audit events.

Raw crime-record content and evidence bytes are deliberately **not** placed on
the shared blockchain. The prototype stores them as permission-restricted files
in each agency's local vault and commits a SHA-256 content hash and `vault://`
reference to Fabric. This avoids replicating victim data and large files to every
peer. A production system would replace this adapter with an encrypted,
agency-controlled document/object store.

There is no application PostgreSQL or SQLite database and no hidden database
fallback. CouchDB is the configured Fabric peer world-state database, not an
independent source of truth. Fabric CA maintains its own internal identity
registry as infrastructure.

## Authentication and the wallet

Each demo user has:

1. an X.509 certificate and private key issued by that department's Fabric CA;
2. a `UserProfile` ledger asset containing role, rank, department, station,
   jurisdiction, clearance, assignment, and credential status.

The local MSP folder is the Fabric "wallet": it contains the certificate and
private key used to sign transactions. It is not application data and it does
not contain a blockchain balance or a password.

No password or password hash is stored on-chain. The development login screen
selects an already-enrolled server-held identity and proves it can sign a
Fabric request. This is a custodial local-demo identity selector, not a secure
production login. A deployment would use user-controlled keys, hardware-backed
credentials, or an enterprise identity provider mapped to Fabric identities.

## DIAS authority model

The model's vocabulary is **binary**: `ALLOW` or `DENY`. `ESCALATE` is not a
label. Failure to generate — unreachable, timed out, unparseable, context
overflow, policy context unavailable — is a *generation status*, never a
recommendation. The backend calls the model itself; there is no AI organization
on the DIAS channel.

The model is always advisory. On a dynamic-authorization miss an AuditMSP
district head is the final authority and chooses `FORCE_ALLOW` or `FORCE_DENY`.
The backend works out whether that decision agreed with the stored LLM
recommendation and commits it with the decision. A reason is mandatory whenever
the auditor did not agree with the model or no recommendation exists; it is kept
with the off-chain review, not on the ledger.

| Model | Auditor | Outcome | Ledger records | Dynamic authorization |
| --- | --- | --- | --- | --- |
| ALLOW | FORCE_ALLOW | granted | AGREED | none |
| ALLOW | FORCE_DENY | denied | NOT_AGREED | none |
| DENY | FORCE_DENY | denied | AGREED | none |
| **DENY** | **FORCE_ALLOW** | **granted** | **NOT_AGREED** | **created** |
| none (generation failed) | either | as the auditor decided | NO_RECOMMENDATION | none |

### Exact-record scope

An authorization is scoped to

```
stableUserId · recordId · caseId · action · purpose
```

plus the committed hash of the governed conditions, and it matches only while it
is active, unrevoked, unexpired and the facts are unchanged.

> **This replaces the earlier property-fingerprint design.** The SEAL-era rule
> was a hash over governed *properties* and could therefore apply to a different
> record that happened to share them. A rule for one record now authorizes that
> record and no other. Live scenario R6 demonstrates that a different record,
> action, purpose or user all miss.

Matching reads the latest committed world state inside the same transaction that
commits the request, never a local cache. Revocation is explicit, reasoned and
its own transaction: `FORCE_DENY` never implicitly revokes.

### Evidence

Fourteen acceptance scenarios (81 checks) were run through the backend API
against `diasrecords` 2.2 on the live five-organization `diaschannel`; transaction
ids and lifecycle traces are in
[`experiments/runs/20260916_dias_backend_llm_acceptance_054757/`](experiments/runs/20260916_dias_backend_llm_acceptance_054757/acceptance.json)
and summarised in
[`reports/iteration/iter_048_auditor_decision_and_public_log.md`](reports/iteration/iter_048_auditor_decision_and_public_log.md);
the same scenarios passed unchanged against 2.1
([`iter_047`](reports/iteration/iter_047_dias_bug_sweep.md)).
The same scenarios first passed against 2.0, after two attempts that failed on
harness defects; all three are kept in
[`experiments/runs/20260915_dias_backend_llm_acceptance/`](experiments/runs/20260915_dias_backend_llm_acceptance/acceptance.json)
([`iter_046`](reports/iteration/iter_046_dias_backend_llm.md)).
Run them again with `make dias-acceptance`; each run gets its own folder.

The earlier fifteen-scenario run
([`iter_036`](reports/iteration/iter_036_dias_live_fabric.md)) tested the
retired AI-organization design and is kept as evidence for that design only.

## Requirements

- Docker or Colima with the Docker CLI available;
- Node.js 20+ for the application (22.9+ for `npm start` in `backend/`, which
  reads `.env` with `--env-file-if-exists`) and Node.js 22 with npm 11.5.1 for the
  isolated Caliper workspace;
- Hyperledger Fabric binaries, configuration, and Docker images in the sibling
  `../fabric-samples` directory;
- Apple Silicon and MLX-LM (`.venv-qwen-policy`) for the local Qwen3-14B model
  server, `make dias-model`;
- Ollama `qwen3:14b` for the controlled untuned baselines.

## Start from a clean local network

```bash
cp .env.example .env  # replace JWT_SECRET before non-disposable use
make doctor
make install
make all           # network, identities, DIAS channel, chaincode and seed data
```

`make all` performs, in order:

```bash
make up            # base Fabric network: CAs, orderer, peers, world state (tears down a previous one)
make seed          # issue deterministic X.509 demo identities
make dias-all      # create diaschannel, deploy diasrecords 2.2, seed users and departments
```

A fresh install holds **no case and no case file**: create the first case under
"Cases" and the first record under "File a record", as a police officer such as
`insp.sharma`. The live suites (`make smoke`, `make dias-acceptance`) need fixed
fixtures instead, which `make dias-demo-data` writes (two cases, three case files).

DIAS runs on its own five-organization channel (`diaschannel`, no AI
organization). The base network still starts the SEAL-era six-organization
channel `crimechannel`, which DIAS does not use. On a network that is already
up, `make dias-all` alone adds DIAS without touching `crimechannel`.

Start the model server and the API. Port **8081** is the DIAS default so that an
existing service on 8080 is never disturbed; the API calls the model itself:

```bash
make dias-model    # Qwen3-14B-4bit on :8081 (DIAS_ADAPTER=<dir> for a fine-tune)
make dias-backend  # API and web interface on :3001
```

A request waits as `awaiting-auditor` until an auditor decides; the auditor screen
shows the LLM recommendation once the backend has prepared it. Nothing is
released while a request waits.

Then open `http://localhost:3001` and select a seeded Fabric identity such as
`insp.sharma` (requester) or `sp.north` (auditor); no application password is
requested.

To serve a fine-tuned adapter, pass its directory to `make dias-model` and give
the backend the matching identity (`DIAS_MODEL_ID`, `DIAS_ADAPTER_ID`,
`DIAS_ADAPTER_HASH`) so each stored recommendation names the model that made it.

Useful commands:

```bash
make test             # offline suites: chaincode, backend, policies, frontend, dataset
make smoke            # live API suite against the running DIAS backend (make test-live)
make dias-acceptance  # full live acceptance run, written to a new experiments/runs/ folder
make verify-log       # read direct-ledger access events
make inspect          # inspect the DIAS channel: blocks, endorsements, history
make prove            # permissioned-network checks (writes a proof record under CASE-PROOF)
make down             # stop and remove the generated local network
```

## Manual Caliper benchmark suite

The Caliper suite measures the SEAL-era `crimerecords` deployment on
`crimechannel` and is kept with its retained evidence; it has not been retargeted
to DIAS. With that deployment running, prepare the current identities
and then start the low-load test manually. On a clean checkout, install and
validate the pinned controller first:

```bash
make caliper-install
make caliper-check
make caliper-prepare
make caliper-smoke
```

Caliper is installed in the isolated `benchmarks/caliper` workspace. Each test
creates a new retained directory under `experiments/runs/`. The initial smoke
test checks connectivity only; it is not a paper-quality performance result.
See `benchmarks/caliper/README.md` and `benchmarks/caliper/EXPERIMENT_PLAN.md`
before running a formal comparison.

After the smoke test passes, start and check the local metrics collector before
using any of the five manual test commands:

```bash
make caliper-monitoring-up
make caliper-monitoring-check
make caliper-read
make caliper-write
make caliper-load
make caliper-mixed
make caliper-endurance
```

Run these one at a time. The endurance target lasts two hours; the other targets
are shorter pilots that should be reviewed before endurance testing.

## Main components

```text
chaincode/crimerecords/lib/
  governanceContract.js   departments, cases, court workflow
  userContract.js         identity-backed UserProfile and status history
  recordContract.js       record/evidence metadata, custody, protected release
  accessContract.js       request log, auditor decision log with LLM agreement,
                          outcomes, exact-record dynamic authorizations
  auditContract.js        complete request reconstruction and verification
  dias/                   verified request, lifecycle events, authorization
                          scope/matching; the shared LLM response schema used by
                          the backend and the dataset tooling
  policy/                 SEAL-era modules, retained OFFLINE only and excluded
                          from the deployed package by deployCC.sh

backend/src/
  fabric/                 per-user Fabric Gateway and CA registration
  dias/                   policy context, the single prompt, the response
                          parser, the recommender, the off-chain review store,
                          the recommendation worker, LLM agreement
  llm/                    SEAL-era modules, unreachable from the DIAS runtime
                          (proved by backend/test/architectureGuard.unit.test.js)
  routes/                 domain API routes
  storage/vault.js        replaceable agency file-vault adapter

frontend/js/modules/      request-access.js (find a case file, request it, read the
                          decision, collect the PDF), decision-log.js (the public
                          ledger view), auditor-review.js, cases, records, PDF
                          requests, evidence, audit, departments, officers
LLMxAI/                   fine-tuned Qwen adapter, training/evaluation data,
                          retained runs, model server scripts, and result tables
solidity-frontend/        standalone EVM companion prototype with its own UI,
                          README, and retained evidence
```

## GitHub repository readiness

The repository includes a GitHub Actions workflow for checks that do not
require a live Fabric network:

- publication-boundary, Compose, and source-syntax checks;
- chaincode unit tests with enforced coverage thresholds;
- deterministic backend unit and security tests;
- policy package, frontend, and dataset/evaluation tests;
- Caliper configuration, runner-helper, and plot-axis validation;
- production dependency audits for the backend and chaincode.

The live API suite (`make smoke`) and the acceptance run (`make dias-acceptance`)
are local live-network checks because they need `make all`, seeded Fabric
identities, the model server, and the backend running on `localhost:3001`. See `CONTRIBUTING.md` and
`docs/github-repository.md` for the local verification commands, evidence
policy, and publication checklist.

For local environment settings, copy `.env.example` if needed and set a real
`JWT_SECRET` before running anything beyond the disposable local demo.

## License

Apache License 2.0. See `LICENSE`.

## Citation

GitHub can generate a software citation from `CITATION.cff`. The frozen
manuscript package and its evidence provenance are retained under
`output/overleaf/SEBA_XAI_Overleaf_Package/` and `papers/final_paper/`.

## Known limitations

- The network runs on one computer with one orderer; it does not demonstrate
  production fault tolerance or multi-site performance.
- Demo private keys are held by the backend and login is identity selection.
- The filesystem vault has restrictive file permissions but no at-rest
  encryption, HSM/KMS integration, malware scanning, or retention policy.
- The prototype treats an authorized auditor as final, including when the model
  disagrees. That is the design, not an oversight.
- Usernames and requested record IDs are visible to all channel members in this
  research design; production privacy controls are not implemented.
- A dynamic authorization is a standing exception. It is exact-scoped,
  attributed, revocable and expirable, but an auditor can still create one that
  should not exist. The auditor screen states before the click whether one will
  be created.
- `FORCE_DENY` on a later request does **not** revoke an existing authorization
  covering the same scope. This is deliberate — see
  [`docs/policies/policy-open-questions.md`](docs/policies/policy-open-questions.md)
  §10 — and the risk it leaves is recorded there.
- The governance policy is a synthetic research policy derived from the SEAL-era
  tables, not official Indian police policy. Sealed-record handling, absolute
  jurisdiction boundaries, clearance as a total order, and the absence of any
  break-glass path are documented decisions with stated alternatives.
- The datasets are synthetic. `data-v2-binary` is validated (25/25 checks) but
  **not** human-reviewed; its review sample is `pending_manual_review`.
- The ledger proves who requested which record, what the auditor decided and
  the agreement value the backend reported. It does **not** prove what the LLM
  recommended: the recommendation, the justification and the auditor's reason
  are kept in the backend review store, which is not replicated and has no
  tamper evidence.
- The chaincode trusts the backend's agreement value. A compromised backend could
  report `NOT_AGREED` for an LLM ALLOW and so turn an auditor's `FORCE_ALLOW`
  into a dynamic authorization. The auditor role, the self-decision rule and the
  facts check are still enforced on-chain.
- There is no live CCTNS/ICJS integration and no real personal or crime data.
- Fabric strengthens identity, provenance, freshness, approval integrity, and
  tamper evidence; it cannot make an incorrect model decision correct.
- Security, privacy, legal compliance, and production readiness have not been
  established by this prototype.
