# Paper–Code Alignment Audit: DIAS

- **Paper:** `/Users/venkatrayudu/Downloads/SEAL___Secure_Explainable_AI_based_Law_Enforcement-13.pdf` (19 pages; printed title "DIAS: Dynamic Explainable Access Control for Blockchain-Based Data Sharing")
- **Repository:** `/Users/venkatrayudu/Workspace/XAI workspace/DIAS`
- **Inspection date:** 2026-09-28
- **Mode:** read-only audit. This file is the only file created in the repository. No existing file was changed, moved or deleted.

How to read this report:

- Page numbers are the numbers printed at the bottom of each PDF page (1–19).
- **WT** means the current working tree: committed files plus uncommitted edits and untracked files.
- **HEAD** means commit `7de0a20` (tag `paper-base-2026-09-23`). It is the only commit in the repository.
- File references use `path:line`. Line numbers refer to the working tree on 2026-09-28.

---

## 1. Executive summary

**Verdict: PARTIALLY ALIGNED.**

### 1.1 Do the paper and the repository describe the same system?

Partly.

- **Where they match.** The paper's Implementation section (§V) and Experimental Results section (§VI) match the code and data in the working folder closely. I traced every number in Tables VI–XIII to a retained artifact. Every value I recomputed matched.
- **Where they do not.** The Methodology section (§IV), Algorithm 1, Table II and Fig. 2 describe security mechanisms that the code does not have:
  - a pre-review recommendation commitment κ;
  - policy-version binding (v_P) of reusable authorizations;
  - on-chain hashes of the justification, the recommendation and the auditor note (h_J, h_M, h_N);
  - an auditor-side hash check before a decision can be submitted;
  - a contract-enforced note commitment.
- The paper itself admits the κ and v_P gaps in §V (pages 11, 13, 14) and §VII (page 18). The manuscript therefore contradicts itself.

### 1.2 Strongest areas of alignment

- **Exact-scope reusable authorization.** Scope, matching, lifecycle, revocation, supersession and expiry are implemented in the contract and unit-tested. They were exercised live in the reuse run: 2,400/2,400 requests completed, 72 authorizations were created, and there were 0 automatic grants on unapproved records.
- **Model training and evaluation.**
  - Table IV matches `adapter_config.json` and `training.log`.
  - All 50 values in Table VII match counts recomputed from tracked prediction files.
  - The dataset validator passes 25/25 checks and reproduces all 8,013 labels from the policy oracle.
  - No scenario group, scenario family or fact hash crosses the train/validation/test splits.
- **Testbed numbers.** Tables IX, X, XII and XIII and Figs. 10 and 12 match `REPORT.md` and the CSV tables derived from the raw logs.
- **Deployed code equals working tree.** The chaincode deployed on the testbed (`diasrecords` 2.3) and the backend image used for the experiments are byte-identical to today's working-tree source. Only cosmetic frontend files changed later. I verified this against the staging folders in `~/dias-testbed`.
- **Tests pass on the working tree:**
  - chaincode: 211 passing;
  - backend: 184 passing;
  - policy package: 27/27.

### 1.3 Most serious discrepancies

1. **Unimplemented methodology.** §IV and Algorithm 1 describe κ, v_P, h_J/h_M/h_N and note commitments. None of these exist in the code. See §9, C-01 to C-05.
2. **The evaluated code is not committed.** The code that produced the paper's numbers, and all Section VI evidence, exist only as uncommitted edits and untracked files.
   - The only commit (HEAD) runs an older contract in which the backend supplies the agreement value directly. This contradicts Fig. 6 and §V-G.
   - The committed README still describes that older behaviour.
3. **Abstract figure from a superseded run.** The abstract says exact-scope reuse avoids "up to 23.75%" of repeated reviews. That value comes from a superseded offline replay. The reported experiment (Table VIII) reaches at most 21.0%.
4. **Baseline accuracy mixes two conventions.** The introduction says fine-tuning raised balanced accuracy "from 60.27% to 98.67%".
   - 60.27% excludes unusable answers.
   - The paper's own Table VII counts unusable answers as wrong. Under that rule the untuned baseline is 56.0%.
5. **Wrong fault-test explanation.** The paper says three of the four failures "occurred before any component was stopped". The raw backend trace contradicts this: all four failures were ledger writes in flight during the orderer failover.
6. **Missing release-time check.** The paper says the grant is re-checked at release. The final PDF download step (`AuthorizeRequestedDocumentRead`) does not do this.
7. **Misleading model-node memory panel.** Fig. 13(j) plots the model process's resident memory (8.8 GB). During the same run the model's GPU memory was 12.5 GB mean and 17.3 GB peak (12.546 / 17.346 GB), which the figure does not show.

### 1.4 Are the reported results reproducible?

- **Re-scoring and re-analysis: yes.** The raw inputs are retained in the working folder. Most of them are untracked.
- **Re-running the experiments from a clean checkout: no.**
  - The V7 adapter weights are git-ignored.
  - `scripts/dias/train-v7.sh` refuses to start without a V6 adapter file stored outside the repository.
  - The testbed deploy script depends on a `prepare-chaincode.sh` that does not exist.
  - VM creation is documented only as prose.
  - The Python analysis dependencies are not pinned.
  - Figs. 8–12 have no generating script or data file in the repository.

### 1.5 Is the repository safe and understandable enough for public release?

**Safe:**

- No live secrets or private keys were found in tracked or untracked files.
- `.env` is ignored and was never committed.
- Fabric key material (406 files under `network/organizations/`) is ignored.

**Not yet release-ready:**

- The public commit does not contain the code that produced the paper's numbers.
- 235 tracked files embed absolute home-directory paths.
- 50 third-party paper PDFs are tracked.
- Large legacy (SEAL-era) components remain, including a 187-file duplicate code snapshot. These will confuse reviewers.
- The PDF itself is a working draft. It opens with a "Review Comments" section (44 comments), has no Conclusion, and its file name uses the old project name "SEAL".

**I do not consider the paper or the repository ready for publication.**

---

## 2. Audit scope and repository state

| Item | Value |
|---|---|
| PDF | `/Users/venkatrayudu/Downloads/SEAL___Secure_Explainable_AI_based_Law_Enforcement-13.pdf` — 19 pages, pdfTeX, created 2026-09-28 12:25 IST |
| Printed title | "DIAS: Dynamic Explainable Access Control for Blockchain-Based Data Sharing" |
| PDF structure | I. Review Comments (44 items), II. Introduction, III. Related Work, IV. Methodology, V. Implementation, VI. Experimental Results, VII. Future Work, References. **There is no Conclusion.** |
| Repository | `/Users/venkatrayudu/Workspace/XAI workspace/DIAS` |
| Branch / commit | `main` at `7de0a20c26882196e0c777589a0af6d275a64130`, "chore: DIAS base for the paper revision (2026-09-23)". Tag `paper-base-2026-09-23`. One commit in history, no stash. |
| Tracked files | 2,321 |
| Modified tracked files | 28 (backend 10, chaincode 7, frontend 11 — listed below) |
| Untracked, not ignored | 19 entries = 421 files, 244 MB |
| Git-ignored material relevant to the paper | `Proof reading/`, `DIAS latex paper/`, `papers/final_paper/`, `output/overleaf/` (manuscript, kept local on purpose per README); V7 adapter weights (`*.safetensors`); `backend/data/`; `network/organizations/` |
| Instruction files read | `./AGENTS.md` (repository evidence and reproducibility rules) and `/Users/venkatrayudu/AGENTS.md` (workspace description, no audit-specific rules). No other `AGENTS.md` exists under the repository. |

**Modified tracked files at the start of the audit:**

- Backend (10):
  - `backend/src/config.js`, `backend/src/dias/agreement.js`, `backend/src/dias/recommendationWorker.js`, `backend/src/dias/recommender.js`
  - `backend/src/fabric/gateway.js`, `backend/src/middleware/accessLogger.js`, `backend/src/routes/access.js`, `backend/src/server.js`
  - `backend/test/accessDias.unit.test.js`, `backend/test/accessLogger.unit.test.js`
- Chaincode (7):
  - `chaincode/crimerecords/lib/accessContract.js`, `lib/auditContract.js`, `lib/dias/authorization.js`
  - `test/diasAccessSecurity.test.js`, `test/diasAccessWorkflow.test.js`, `test/diasAuthorization.test.js`, `test/diasTestWorld.js`
- Frontend (11):
  - `frontend/css/base.css`, `components.css`, `layout.css`, `frontend/index.html`
  - `js/core/api.js`, `js/modules/audit-trail.js`, `js/modules/decision-log.js`, `js/modules/request-access.js`
  - `js/shared/dias.js`, `js/views/login.js`, `js/views/shell.js`

**Untracked entries at the start of the audit (19):**

- Backend (4): `backend/src/dias/recommendationDetail.js`, `backend/src/util/trace.js`, `backend/test/diasRecommendationDetail.unit.test.js`, `backend/test/testbedInstrumentation.unit.test.js`
- Experiments (5): `experiments/cross-dataset/`, `experiments/plans/20260924_multi_vm_experiments_plan.md`, `experiments/runs/20260924_cross_dataset/`, `experiments/runs/20260924_testbed_multivm/`, `experiments/runs/20260925_reuse_100_users/`
- Reports and results (9): `reports/iteration/iter_054_dias_multi_vm_remaining_experiments.md`, `results/plots/dias-testbed/`, and seven `results/tables/dias_testbed_*` files
- Testbed (1): `testbed/`

**What I ran.** Every command was read-only, or wrote only to the system temp folder or a session scratch folder outside the repository.

- `git status`, `git diff`, `git ls-files`, and hash/listing commands.
- `pdftotext` and `pdftoppm` into a scratch folder outside the repository.
- Chaincode tests: `npx mocha --recursive 'test/**/*.test.js'`, run **without** the `nyc` coverage wrapper so `coverage/` was not rewritten. Result: **211 passing**.
- Backend tests: `npx mocha --require test/setup.unit.js 'test/**/*.unit.test.js'`. Result: **184 passing**. These tests write only to `os.tmpdir()`.
- Policy tests: `node --test ...`. Result: **27/27 pass**.
- Dataset validator: `node experiments/dias-finetuning/v2/validate.js`, run without `--json` so it wrote nothing. Result: **25/25 checks pass**.
- Small Python scripts that read artifacts: counts, overlaps, E7 timing, E6 GPU memory.
- Read-only `diff` of `~/dias-testbed/chaincode-staging/src` and `~/dias-testbed/build/app` against the repository.
- `git status --short` after all commands: the same 47 entries as at the start.

**Limitations of this audit**

- **Not run:** no training, no model inference, no Fabric network and no VM was started. No experiment was re-run.
- **Not checked online:** GitHub CI status (no network calls were made).
- **Manuscript source missing:**
  - The LaTeX source of this exact PDF (version "-13") is not in the repository. I did not find it in the local manuscript folders either.
  - The image files of Figs. 8–12, and the tool that drew them, were not found.
  - I therefore traced values, not figure files.
- **Review Comments section:** Section I of the PDF ("Review Comments", 44 items) was treated as document content, not as instructions.
- **Legacy folders sampled, not read line by line:** `LLMxAI/`, `paper-tests/`, `benchmarks/`, `solidity-frontend/`, and the more than 1,400 tracked files under `experiments/runs/`. I inventoried them by structure, README headers and targeted checks.
- **Earlier notes:** notes from earlier work sessions were used only as pointers. Every fact in this report was re-checked against repository files.

---

## 3. Paper-to-code traceability matrix

Statuses follow the audit prompt. "(WT only)" means the evidence exists only in uncommitted or untracked files.

### 3.1 Architecture and methodology

| Claim ID | Paper claim | PDF page/section | Repository evidence | Status | Confidence | Problem or limitation | Required action |
|---|---|---|---|---|---|---|---|
| P-ARCH-001 | An exact match with an active reusable authorization is checked first, in the same transaction that records the request. On a match the request is granted without the LLM or an auditor. | p7 §IV; p8 §IV-C; p10 Alg. 1 l.3–9; p13 §V-E | `accessContract.js:331-474` (check at 369-371; GRANTED outcome and `AUDITOR_REVIEW_SKIPPED` event at 441-474); `backend/src/routes/access.js:150-158` (returns 201, no model call); test `diasAccessWorkflow.test.js:218`; reuse run `experiments/runs/20260925_reuse_100_users/analysis/RESULTS.md` (504 automatic grants, 0.53 s median) | MATCHED | High | — | None |
| P-ARCH-002 | Two storage domains: the ledger holds verified state and "compact commitments"; J, M and N stay off-chain. | p7 §IV | Request stores `verifiedRequest` + `verifiedRequestHash` (`accessContract.js:392-418`). J, M and N are in `backend/src/dias/reviewStore.js:49-65` and `routes/access.js:293-305`. No on-chain commitment of J, M or N exists; the justification hash appears only in off-chain provenance (`recommender.js:87`). | PARTIALLY MATCHED | High | The off-chain split is real. The "compact commitments" are not. | Remove the word "commitments", or implement the hashes |
| P-ARCH-003 | The ledger reconstructs the request context, check, recommendation value and generation status, decision, agreement, lifecycle and outcome. Off-chain objects can be verified against on-chain hashes. | p7 §IV; p9 §IV-G | `auditContract.js:236-280` (`GetRequestAuditTrail`) returns the request, lifecycle, decision (with `llmRecommendation`, WT only), outcome and authorizations. The generation status collapses to `UNAVAILABLE` (`accessContract.js:63-67`; `agreement.js:42-45`). There is no h_M, h_J or h_N. | PARTIALLY MATCHED | High | Off-chain objects cannot be verified. The specific failure status is lost. | Narrow the claim, or add the hashes |
| P-ARCH-004 | A pre-review commitment κ = (id, h_C, v_P, q, s, modelVersion, h_M) is committed before auditor review; one active κ per request. | p7 §IV & §IV-A; p8 §IV-D Eq. (2); p10 Alg. 1 l.12–16; Fig. 2 caption | No κ in the code. `SubmitAuditorDecision(ctx, requestId, decisionText, llmRecommendationText, validUntilUtc)` receives the value at decision time (`accessContract.js:602-612`). The paper's own §V-A (p11), §V-F (p14) and §VII (p18) say κ is not implemented. | CONTRADICTED | High | Methodology describes a mechanism the system does not have. | Implement κ, or rewrite §IV, Alg. 1 and Fig. 2 around the implemented design |
| P-ARCH-005 | The auditor interface checks H(M) = h_M and matches κ before a decision can be submitted. | p8 §IV-D; Alg. 1 l.16 | The backend only blocks a decision while the recommendation is pending (`routes/access.js:271-276`). No hash check in backend or frontend. | PAPER ONLY | High | — | Implement or remove |
| P-ARCH-006 | "The backend does not provide g"; the contract derives agreement from the committed recommendation. | p8 §IV-E Eq. (3) | WT: the contract derives g (`accessContract.js:91-98, 612`) from a recommendation value the backend supplies at decision time (`routes/access.js:277-292`). HEAD `7de0a20`: the contract accepts `llmAgreementText` directly from the backend (`git diff HEAD`). | PARTIALLY MATCHED | High | The backend still controls g through q; §VII admits this. The public commit contradicts the claim. | Commit the WT contract; state the backend trust in §IV |
| P-ARCH-007 | Decision validation is fail-closed: self-review, context mismatch, policy-version mismatch, missing note commitment, commitment mismatch or invalid expiry each cause rejection with no writes. | p9 §IV-E; p10 Alg. 1 l.19–33 | Implemented: self-review (`accessContract.js:615-618`), facts unchanged (`619`, `235-240`), expiry rules (`620-623`; `authorization.js:56-65`). Rejection is atomic because the contract throws. Not implemented: policy-version, note-commitment and κ checks. | PARTIALLY MATCHED | High | 3 of the 6 listed checks are missing. | Implement them, or remove them from the list |
| P-ARCH-008 | A reusable authorization is created only for an auditor FORCE ALLOW over a valid model DENY. An agreed ALLOW, any FORCE DENY, or a missing recommendation creates none. | p9 §IV-F; Alg. 1 l.31; p14 §V-G | `accessContract.js:620` (`FORCE_ALLOW && NOT_AGREED`); `authorization.js:83-88`; tests `diasAccessWorkflow.test.js:94,130,144`, `diasAuthorization.test.js:95` | MATCHED | High | "Valid DENY" means DENY as reported by the backend (see P-ARCH-006). | See P-ARCH-006 |
| P-ARCH-009 | Exact scope σ = (sid(u), r, c, a, p). Another record with the same type or sensitivity has a different scope. | p8 Eq. (1); p9 §IV-F; p13 §V-E, Fig. 4 | `authorization.js:43-54`; `accessContract.js:360-371`; tests `diasAuthorization.test.js:64`, `diasAccessWorkflow.test.js:256,271`; reuse run: 0 grants on unapproved records | MATCHED | High | — | None |
| P-ARCH-010 | Reuse requires the authorization to have been issued under the currently active policy version v_P. A v_P change forces reassessment. v_P is stored in the request and in α. | p8 §IV-C; p9 §IV-F, §IV-G; Alg. 1 l.5–6, 24–25, 36; Table II | No v_P in the DIAS chaincode or backend. A search for `policyVersion` finds it only in the unreachable legacy `backend/src/llm/*`. `matchAuthorization` (`authorization.js:131-161`) has no version check. §V-E (p13) and §VII (p18) admit this. | CONTRADICTED | High | Methodology contradicts implementation. | Implement v_P binding, or rewrite §IV |
| P-ARCH-011 | Authorization lifecycle: ACTIVE, REVOKED, EXPIRED, SUPERSEDED. Optional future expiry. Revocation needs a reason. A new override supersedes the previous generation. Transitions are appended. | p9 §IV-F; p13 §V-E | `authorization.js:24-29, 56-65, 163-190`; `accessContract.js:476-499` (expiry), `533-559` (supersede), `713-749` (revoke; reason required at 716-717); tests `diasAccessWorkflow.test.js:284,303,319` | MATCHED | High | Expiry is optional: `validUntilUtc: null` never expires. | Researcher decision on mandatory or maximum expiry |
| P-ARCH-012 | A later FORCE DENY cannot override an authorization that still matches. A denial never implicitly revokes. | p8 §IV-C; p10 §IV-H; p13 §V-E | The match branch runs before the auditor path (`accessContract.js:441-474`). Only `RevokeDynamicAuthorization` revokes. Test `diasAccessWorkflow.test.js:343`. | MATCHED | High | — | None |
| P-ARCH-013 | The contract appends lifecycle events for submission, authorization check, recommendation commitment, auditor decision, agreement derivation, authorization creation or transition, and outcome. Automatic grants state that generation and review were skipped. | p9 §IV-G | The `EVENT` list (`lib/dias/lifecycle.js:21-31`) has no recommendation-commitment event and no separate agreement event. Agreement is a field of `AUDITOR_DECISION_RECORDED` (`accessContract.js:662-680`). The skip event gives reason `ACTIVE_DYNAMIC_AUTHORIZATION` (`449-458`). | PARTIALLY MATCHED | High | Two of the listed events do not exist. | Align the text with the `EVENT` list |
| P-ARCH-014 | Governed release re-checks the GRANTED outcome and credential at release time. Reused grants must still be active, unexpired and bound to the active v_P. The owner verifies the content hash before delivery. | p9 §IV-G | `recordContract.js:133-150` re-checks credential and authorization for metadata (`351`), `AuthorizeRecordRead` (`369`) and the PDF **request** (`409`). The final PDF release `AuthorizeRequestedDocumentRead` (`526-551`) checks only requester identity and `ready` status. The backend checks the content hash (`routes/records.js:166-181`). No v_P. | PARTIALLY MATCHED | High | A revocation or credential suspension after the PDF request does not block the download. | Add the grant re-check to the final release, or narrow the claim |
| P-ARCH-015 | Protected content stays in the owning organization's private repository. The ledger holds only the ID, storage reference and content hash. | p9 §IV-G; p12 §V-C | Content is off-chain (`backend/src/storage/vault.js`; `routes/records.js:68-90` commits the hash). But one backend process holds every agency's vault (`VAULT_DIR`, `backend/src/config.js:47-52`), unencrypted (README "Known limitations"). Record metadata (type, sensitivity, jurisdiction, flags) is on-chain. | PARTIALLY MATCHED | Medium | Per-organization custody is simulated. | Describe it as a simulated per-agency vault |
| P-ARCH-016 | Trust model: requester and LLM untrusted; the LLM holds no ledger credential. Trusted: MSP, endorsement policy, auditor, record owner, recommendation service. | p7 §IV-A | The model is called over HTTP and has no Fabric identity (`recommender.js:58-76`). The gateway signs with user keys held by the backend (`backend/src/fabric/gateway.js:29-64`). | PARTIALLY MATCHED | High | The backend holds keys, the review store and q, so it is part of the trusted base. §IV-A does not list it. | Add the backend to the §IV-A trust list |
| P-ARCH-017 | If off-chain data is lost, the ledger still keeps the recommendation, its generation status and its digital fingerprint. | p7 §IV-A | The WT ledger keeps only the recommendation value (ALLOW / DENY / UNAVAILABLE) of decided requests. There is no fingerprint. HEAD keeps no recommendation at all. | CONTRADICTED | High | — | Rewrite |
| P-ARCH-018 | Algorithm 1 formalizes the workflow. | p10 §IV-H | Implemented: l.1, 3–5, 7–11, 13 (M stored off-chain), 17, 19–23, 28, 31–39. Missing: l.2 (h_J), l.6 (h_J, v_P), l.12 and 14–16 (h_M, κ, verification), l.18 (note stored before the transaction, h_N), l.24–27, l.29–30. | PARTIALLY MATCHED | High | About a third of the steps are not implemented. | Revise the algorithm, or implement the steps |
| P-ARCH-019 | Fig. 2 workflow; bottom box: "Permissioned audit record: request, recommendation, decision, authorization, and outcome". | p9 Fig. 2 | Steps 1–7 match the code paths above. The ledger holds only the recommendation **value** (WT). | PARTIALLY MATCHED | Medium | The figure implies the full recommendation is on the ledger. | Relabel the box |
| P-ARCH-020 | Fig. 1(b): the LLM suggests, the auditor decides, the ledger records each request and decision. | p4 Fig. 1 | As P-ARCH-001 and P-HUM-001 | MATCHED | Medium | — | None |

### 3.2 Implementation

| Claim ID | Paper claim | PDF page/section | Repository evidence | Status | Confidence | Problem or limitation | Required action |
|---|---|---|---|---|---|---|---|
| P-IMPL-001 | Hyperledger Fabric 2.5.16, Fabric CA 1.5.22, CouchDB 3.4.2, Node.js | p1 Abstract; p10–11 §V-A; p14 §VI | `network/compose/compose-net.yaml:20,61,79`; `network/compose/compose-ca.yaml:14`; image digests in `experiments/runs/20260924_testbed_multivm/manifest.json` | MATCHED | High | — | None |
| P-IMPL-002 | One channel `diaschannel` with Police, Forensics, Prosecution, Court and Audit MSPs; one peer each; CouchDB world state | p10 §V-A | `testbed/config/configtx.yaml:10-128, 223-231`; `network/configtx/configtx.yaml:248-269`; manifest `fabric` block | MATCHED | High | The base network still also builds the SEAL-era six-organization `crimechannel`, including an AI organization (`network/configtx/configtx.yaml:220-242`). | Document or remove |
| P-IMPL-003 | Five peers on three Linux VMs; three-node Raft with one orderer per VM; backend on a fourth VM; LLM on the physical host | p11 §V-A; p14 §VI; Fig. 7 | `testbed/README.md` (machine table); `testbed/config/configtx.yaml:161-219`; manifest `vms`, `fabric` (WT only). The committed `network/` is single-host with one orderer (`network/configtx/configtx.yaml:224-228`). | MATCHED | High | Evidence is untracked. | Commit `testbed/` |
| P-IMPL-004 | Blocks close after 2 s or ten transactions | p11; p14 | `network/configtx/configtx.yaml:185-187`; `testbed/config/configtx.yaml:166-168` | MATCHED | High | — | None |
| P-IMPL-005 | No chaincode-specific endorsement policy; the channel default MAJORITY requires 3 of 5 organizations | p11 §V-A; p14 | `testbed/scripts/deploy-cc.sh:63-66` (no `--signature-policy`); `testbed/config/configtx.yaml:150-155`; `network/configtx/configtx.yaml:173-178` | MATCHED | High | — | None |
| P-IMPL-006 | Research governance policy v1 with ten DENY clauses in precedence order and reason codes (Table III). POLICY_SATISFIED when none applies. The first applicable clause gives the primary code. | p11 Table III | `policies/dias-governance-policy-v1.json` (DENY clauses at precedence 1–10, ALLOW at 11); `policies/reference-oracle/referencePolicyOracle.js`; policy tests 27/27 pass | MATCHED | High | The chaincode vocabulary file `lib/policy/policyV1.js:20` is labelled `crime-policy-v2`. | Rename or document |
| P-IMPL-007 | The contract does not apply the written clauses. The earlier policy engine and disagreement guard are excluded by the packaging script and checked by an architecture test. | p11; p12 §V-D | `network/scripts/deployCC.sh:33-40`; `chaincode/crimerecords/test/architectureGuard.test.js:17-24, 48-66`; the deployed testbed package lacks exactly these five modules (diff against `~/dias-testbed/chaincode-staging/src`) | MATCHED | High | — | None |
| P-IMPL-008 | Five contracts with the transactions listed in Table V | p12 Table V | `chaincode/crimerecords/index.js:3-16`; `governanceContract.js:104,144,162`; `userContract.js:111,167,207`; `recordContract.js:158,409,526`; `accessContract.js:331,602,713`; `auditContract.js:122,178,236` | MATCHED | High | — | None |
| P-IMPL-009 | Every state-changing transaction derives the caller's organization and role from the X.509 certificate; request-body attributes cannot grant writes | p12 §V-D | `lib/util/identity.js:30-46`; allow-list validation `lib/util/validate.js:40-48`; every writing transaction checks the caller (seal/unseal through `recordContract.js:314-317`) | MATCHED | High | `RecordAccessEvent` accepts any identity; it logs the caller's own action. | None |
| P-IMPL-010 | Auditors are AuditMSP identities with a district-head role, checked from the signing certificate | p12 §V-C | `accessContract.js:174-179`; `lib/policy/authority.js` `DISTRICT_HEAD_ROLES` = sp, commissioner, chief-forensic-officer, director-of-prosecution, district-judge; test `diasAccessSecurity.test.js:63` | MATCHED | High | — | None |
| P-IMPL-011 | Account creation: a CA certificate with attributes plus a ledger profile. An AuditMSP district head registers users through the application. | p12 §V-C | `userContract.js:86-100, 111-155`; `backend/src/fabric/ca.js`; `frontend/js/modules/register-user.js` | MATCHED | Medium | Genesis exception: any AuditMSP identity may admit the first user (`userContract.js:97`). Not in the paper. | Mention |
| P-IMPL-012 | Sign-in selects an enrolled username. The backend checks the certificate and key against the active ledger profile and issues a time-limited token. Demonstration only. | p12 §V-C | `backend/src/routes/auth.js`; `userContract.js:167-188`; JWT expiry 8 h (`backend/src/config.js:216`) | MATCHED | High | — | None |
| P-IMPL-013 | The backend reports a state-changing request as successful only after the ledger confirms it | p12 §V-C | `backend/src/fabric/gateway.js:94-121` | MATCHED | High | — | None |
| P-IMPL-014 | The backend submits a separate access-log entry after the reviewer decision | p12 §V-C | `backend/src/middleware/accessLogger.js:1-12` (runs after the response) → `auditContract.js:137-175`. E6 recorded 1,843 access-log writes (`REPORT.md` §5). | MATCHED | High | Best-effort: a logging failure does not fail the request. | Mention |
| P-IMPL-015 | `CreateAccessRequest` builds C from the certificate and the ledger profile (identity, organization, role, rank, station, jurisdiction, clearance, credential status in both places, case assignment, record facts, allow-listed action and purpose). It stores C and its SHA-256 hash h_C. J is not in C and stays off-chain. | p13 §V-E | `accessContract.js:191-213, 331-351, 392-418`; `lib/dias/verifiedRequest.js:18-71, 112-114`; `backend/src/routes/access.js:118-140`; tests `diasAccessSecurity.test.js:27,52` | MATCHED | High | Rank, station, jurisdiction and clearance are compared only when set in the profile (`accessContract.js:202-206`). An inactive credential is recorded, not rejected. | None |
| P-IMPL-016 | C contains the requester's stable identity and the record identifier | p8 §IV-C | `lib/dias/verifiedRequest.js:10-11` deliberately excludes identity and record/request IDs from C; they are in σ instead | CONTRADICTED | High | Minor wording error | Fix §IV-C |
| P-IMPL-017 | h_J = H(J) is recorded on-chain | p8 §IV-C; p9 §IV-G; Alg. 1 l.2, 6 | The justification hash exists only in off-chain provenance (`recommender.js:87`). §V-F (p14) says there is no on-chain hash of J. | CONTRADICTED | High | — | Implement or remove |
| P-IMPL-018 | An expired authorization found by a request is recorded as a transition | p13 §V-E | `accessContract.js:476-499`; test `diasAccessWorkflow.test.js:319` | MATCHED | High | — | None |
| P-IMPL-019 | "The evaluated authorization does not store or compare v_P" | p13 §V-E | `authorization.js:79-161` | MATCHED | High | Contradicts §IV (see P-ARCH-010). | See P-ARCH-010 |
| P-IMPL-020 | One worker calls the locally served 4-bit Qwen3-14B with the V7 LoRA through MLX-LM: temperature 0, top-p 1, at most 512 tokens, thinking off | p11 §V-B; p13 §V-F | Serial queue in `backend/src/dias/recommendationWorker.js:36-117`; decoding in `recommender.js:58-76`; 512 tokens in `backend/src/config.js:233`; model command in `testbed/README.md`; manifest `model` block; E4: 600/600 answers byte-identical to the stored V7 outputs (`REPORT.md` §2) | MATCHED | High | The library default `maxTokens: 256` (`recommender.js:25`) is overridden by the config. | None |
| P-IMPL-021 | A run manifest records the model revision, adapter hash and inference settings | p13 §V-F | `experiments/runs/20260924_testbed_multivm/manifest.json` (`model`); per-recommendation provenance (`recommender.js:80-90`) | MATCHED | High | The manifest is untracked. | Commit |
| P-IMPL-022 | The prompt marks C as ledger facts and J as untrusted text inside USER_JUSTIFICATION delimiters. It asks for one JSON object with recommendation, reason code, explanation, policy references, missing evidence and review flags. | p13 §V-F | `backend/src/dias/recommendationPrompt.js:13-31, 56-61, 71-79`; `chaincode/crimerecords/lib/dias/recommendationSchema.js:13-18` | MATCHED | High | — | None |
| P-IMPL-023 | The backend checks fields and permitted values. A failure is stored as a status, not as a DENY. | p13 §V-F | `backend/src/dias/recommendationContract.js:46-71`; `recommender.js:103-191`; `agreement.js:42-45` | MATCHED | High | — | None |
| P-IMPL-024 | Generation status s (OK; UNAVAILABLE or INVALID OUTPUT) is recorded on-chain in κ | p7–8 §IV-B | The code has five statuses (`recommendationSchema.js:19-25`). The ledger receives only ALLOW, DENY or UNAVAILABLE (`accessContract.js:63-67`). | PARTIALLY MATCHED | High | The specific failure status is lost on-chain, and there is no κ. | Rewrite, or extend the contract |
| P-IMPL-025 | Review store: one JSON file per request, written through a temporary file and a rename; not tamper-evident | p14 §V-F | `backend/src/dias/reviewStore.js:39-46` | MATCHED | High | — | None |
| P-IMPL-026 | The recommendation value reaches the ledger only with the auditor decision. No earlier κ; no on-chain hash of M or J. | p11; p12; p14 §V-F; p18 §VII | `accessContract.js:602-612, 635-651` (WT only). HEAD records no recommendation. | MATCHED | High | Evidence only in the uncommitted WT. | Commit |
| P-IMPL-027 | `agreementFor` derives AGREED, NOT_AGREED or NO_RECOMMENDATION from the value the backend submits. Fig. 6 shows the deployed code. | p14 §V-G; Fig. 6 | `accessContract.js:91-98, 602-623`. The line numbers match Fig. 6 exactly (WT). The deployed testbed source is identical to the WT. HEAD differs: it accepts the agreement value. | MATCHED | High | WT only | Commit |
| P-IMPL-028 | `SubmitAuditorDecision` checks the auditor role, awaiting-review status, that the auditor is not the requester, and that facts are unchanged. Only FORCE ALLOW over DENY creates an authorization, and an expiry is accepted only then. | p14 §V-G | `accessContract.js:602-623`; tests `diasAccessSecurity.test.js:63,91,97`, `diasAccessWorkflow.test.js:335` | MATCHED | High | — | None |
| P-IMPL-029 | The backend requires an auditor note for a disagreement or a missing recommendation; the text stays off-chain | p6 §III; p14 §V-G | `routes/access.js:280-285, 293-305`; `agreement.js:58-60` | MATCHED | High | Enforced by the backend only | None |
| P-IMPL-030 | The note is stored off-chain **before** the decision transaction; h_N is in the transaction; the contract requires it for NOT_AGREED and NO_RECOMMENDATION | p8–9 §IV-E; Alg. 1 l.18, 29–30 | The note is written **after** the ledger commit (`routes/access.js:289-305`). The contract has no note or hash parameter (`accessContract.js:602`). | CONTRADICTED | High | If `store.update` fails after the commit, the decision is on the ledger without its note. | Reorder and add the hash, or rewrite |
| P-IMPL-031 | Fig. 4 shows the deployed `buildScope` and `matchAuthorization` | p13 Fig. 4 | `authorization.js:43-52, 131-161`. Line numbers match the WT; in HEAD the numbering after line 111 is one lower. | MATCHED | High | — | None |
| P-IMPL-032 | Fig. 5: auditor review screen with an advisory recommendation and separate FORCE ALLOW / FORCE DENY controls | p14 Fig. 5 | `frontend/js/modules/auditor-review.js:33-51, 91-117, 231-238` | MATCHED | Medium | Screenshot provenance not verified | None |
| P-IMPL-033 | Stated limitations: κ not implemented, v_P not stored, delimiters are no injection defense, the backend holds keys, one physical host | p18 §VII | Consistent with `accessContract.js:602`, `authorization.js:79-161`, `recommendationPrompt.js:56-61`, `gateway.js:29-64` and the manifest | MATCHED | High | These limitations contradict §IV (see §9). | Resolve §IV |

### 3.3 Experimental setup

| Claim ID | Paper claim | PDF page/section | Repository evidence | Status | Confidence | Problem or limitation | Required action |
|---|---|---|---|---|---|---|---|
| P-EXP-001 | Apple M3 Max, 16 CPU cores, 64 GB; four VMs with 3 vCPU and 6 GB each | p14 §VI | Manifest `host` and `vms` (memory 6,189,420,544 bytes per VM) | MATCHED | High | Untracked | Commit |
| P-EXP-002 | Table IV configuration: rank 8, dropout 0.05, scale 20, 16 layers; 12.8 M of 14,768 M parameters (0.087%); Adam with constant LR 1e-5; batch 1 with gradient accumulation 4; max length 2,560; loss on response tokens only; 5,254 iterations ≈ 1,300 updates; seed 42; validation every 250 iterations on 100 batches; checkpoint every 500; about 19 h; peak memory 13.3 GB | p11 Table IV | `LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7/adapter_config.json` (tracked); `experiments/runs/20260913_dias_qwen3_lora_v7_full/training.log:14` (12.845M / 14,768.307M); peak memory 13.275 GB in the same log; `run.json` (09:41:05Z → 04:24:29Z = 18 h 43 min; base revision `a4d9b2df…`); 5,254 / 4 = 1,313 updates | MATCHED | High | "Longest example 2,150 tokens" is documented (`docs/training-configuration.md:34`) with a script (`experiments/dias-finetuning/v2/token_audit.py`), but no output is stored. | Store the token-audit output |
| P-EXP-003 | V7 was trained from the unmodified base model, not from an earlier adapter | p11 §V-B | `adapter_config.json` has `resume_adapter_file: null`; the `scripts/dias/train-v7.sh` preflight refuses to resume | MATCHED | High | — | None |
| P-EXP-004 | Validation loss: 1.423 before training; below 0.01 by iteration 1,500; then between 0.002 and 0.007; final 0.003; minimum 0.002 at iteration 4,500; the final checkpoint is evaluated; no checkpoint chosen on test data | p11–12; Fig. 3 | `training.log:17-281`; `checkpoint-selection.json` | PARTIALLY MATCHED | High | At iteration 1,750 the loss is 0.008, outside the stated range. | Say "0.002–0.008" |
| P-EXP-005 | The untuned base model is the baseline, with the same examples, prompt, policy, response check and decoding | p11 §V-B | Both `experiments/runs/20260912_dias_qwen3_baseline/metrics.json` and `.../20260914_dias_qwen3_lora_v7_full_final_eval/metrics.json` show the same base revision, prompt version, schema version, policy hash `796013dd…`, decoding (0, 1, 512, thinking disabled) and harness | MATCHED | High | README says the baselines use Ollama; the metrics show MLX (`url :8081`, `adapterPath null`). | Fix the README |
| P-EXP-006 | Labels come from programmed rules applied to synthetic requests | p11; p14–15 | `validate.js` run on 2026-09-28: "8013 labels reproduced from the oracle", 25/25 checks pass | MATCHED | High | Not human-reviewed (README); the paper does not say so. | State it |
| P-EXP-007 | Table VI sizes and class splits; 1,764 distinct test requests in five overlapping groups | p15 Table VI | `experiments/dias-finetuning/data-v2-binary/*.cases.jsonl`: all counts match; 1,764 distinct test IDs; the groups sum to 2,299 | MATCHED | High | The overlap is not quantified: 115 of the 389 adversarial examples are also in the balanced set. | Report the overlap |
| P-EXP-008 | Training and validation are balanced; requests describing the same situation stay in one split | p15 | 2,627 / 2,627 and 200 / 200. Zero shared splitGroup, scenarioFamily or factsHash between train/validation and any test group. The validator's family, feature and template leakage checks pass. | MATCHED | High | — | None |
| P-EXP-009 | 60 complete-request examples (31 ALLOW / 29 DENY) are part of the evaluation data | p15 Table VI | `workflow-evaluation.cases.jsonl` exists (60; 31 / 29). It is used only by the superseded offline replay `experiments/dias-finetuning/v2/eval/scope-ablation.js`. No §VI result uses it. | PARTIALLY MATCHED | High | Listed data with no reported result | Remove the row, or report its use |
| P-EXP-010 | Reuse experiment: 100 accounts × 3 records = 300 requests per round, 8 rounds; users, records and approvals fixed; broader rule replayed | p16 §VI-B | `testbed/reuse/generated/reuse-100-users-plan.json` (seed 20260925, `approvalProbability 0.5`, scripted auditor rule); `testbed/analysis/analyze_reuse.py:56-69, 96-124`; `RESULTS.md` | PARTIALLY MATCHED | High | The paper does not say that approvals were a random draw (p = 0.5) per base request, that the auditor was scripted, or which properties the fingerprint uses. | Describe these |
| P-EXP-011 | Component tests: 600 sequential model calls; four ledger operations at 10–100 operations in flight | p16 §VI-C | `testbed/load/run-ledger.js:13-17, 111-139`; `testbed/analysis/analyze_e3.py`; `REPORT.md` §2–3 | MATCHED | High | Not explained: W1 runs for 60 s; W2 decides exactly the requests W1 created (hence equal counts); R2 failures come from a 30 s client deadline. | Explain |
| P-EXP-012 | External tasks: 180 LLMAC-reconstructed and 100 OrgAccess easy-binary requests, no further training | p17 §VI-D | `experiments/cross-dataset/*.py`; `experiments/runs/20260924_cross_dataset/COMPARISON.md` | MATCHED | High | Untracked | Commit, with licence notes |
| P-EXP-013 | Whole system: 10/25/50/75/100 users × 3 repetitions = 780 workflows; scripted auditor; latency excludes human time | p17 §VI-E | `testbed/load/run-burst.js`, `plan.js` (seed 20260924); `REPORT.md` §4; `results/tables/dias_testbed_e5_levels.csv` | MATCHED | High | Not stated: the workload is a seeded plan over 12 requester profiles in the testbed world, not the held-out test set. | State it |
| P-EXP-014 | One-hour test: 100 simulated users, 369 requests | p17 | `testbed/load/run-steady.js`; `raw/e6-steady-20260925T023853Z/run.json` (369 / 369); two aborted attempts retained | MATCHED | High | — | None |
| P-EXP-015 | Fault test: the active orderer is stopped, then a peer; 83 requests | p18 | `testbed/scripts/run_fault_test.py`; `raw/e7-fault-20260925T043602Z/fault-timeline.json` (orderer3 stopped, then peer0.court) | MATCHED | High | — | None |
| P-EXP-016 | (The paper reports no ablation study) | — | V7 input ablations (`…/20260914_dias_qwen3_lora_v7_full_final_eval/ablations/metrics.json`; `results/tables/dias_paper_final_input_ablation.csv`), a three-seed pilot, an expanded adversarial set and scope ablations all exist | REPOSITORY ONLY | High | `AGENTS.md` requires ablations; the paper has none. | Report or justify |
| P-EXP-017 | (Validation-set accuracy is not reported) | — | `results/tables/dias_testbed_accuracy.csv`: V7 395/400, untuned 215/400 | REPOSITORY ONLY | High | — | Optional |

### 3.4 Results

| Claim ID | Paper claim | PDF page/section | Repository evidence | Status | Confidence | Problem or limitation | Required action |
|---|---|---|---|---|---|---|---|
| P-RESULT-001 | V7 balanced accuracy is 98.67% on 600 held-out decisions | p1 Abstract; p5; p14 | `results/tables/dias_testbed_accuracy.csv` (0.9867); V7 `metrics.json` (0.986667); tracked predictions | MATCHED | High | — | None |
| P-RESULT-002 | Fine-tuning raises balanced accuracy from 60.27% to 98.67% | p5 §II | 60.27% is balanced accuracy over **usable answers only** (`metrics.json` 0.602737; harness rule `experiments/dias-finetuning/v2/eval/metrics.js:11-14`). Under the paper's Table VII rule (unusable = wrong) the value is (70/300 + 266/300)/2 = 56.0%. | CONTRADICTED | High | Two conventions mixed | Use 56.0%, or state and apply one convention |
| P-RESULT-003 | Table VII (all 50 values) | p16 Table VII | `results/tables/dias_testbed_accuracy.csv`; `results/tables/dias_paper_final_model_comparison.csv`; `REPORT.md` §1 (recomputed from predictions; matches stored values) | MATCHED | High | "Exact refs." is an order-sensitive exact list match (`metrics.js:96-97`); the paper does not say this. | State the definition |
| P-RESULT-004 | Fig. 8 counts | p15 Fig. 8 | `REPORT.md` §1; accuracy CSV | MATCHED | High | No script in the repository draws this figure. | Add a script |
| P-RESULT-005 | False DENYs 204 → 2, unusable 46 → 0, false ALLOWs 14 → 6; V7 98.5–100% and untuned 48.3–95.1% across groups | p15 | Same sources | MATCHED | High | — | None |
| P-RESULT-006 | Adversarial set: V7 383/389; all six errors are false ALLOWs | p15 | Accuracy CSV; `results/tables/dias_v7_unsafe_allow_failures.csv` (6 rows) | MATCHED | High | The repository's per-case analysis of these six is not in the paper. | Consider adding |
| P-RESULT-007 | Exact-scope reuse avoids **up to 23.75%** of repeated reviews without unapproved grants | p1 Abstract | The reported experiment (Table VIII, `RESULTS.md`) reaches at most 21.0% (504 / 2,400). 23.75% appears only in the superseded offline sweep (`results/tables/dias_scope_workload_sweep.csv` rows 33 and 36; `reports/iteration/iter_052_dias_overnight_experiments.md:63`). | CONTRADICTED | High | The abstract cites a superseded experiment. | Change to 21% |
| P-RESULT-008 | Table VIII and Fig. 9 | p16 | `experiments/runs/20260925_reuse_100_users/analysis/RESULTS.md`, `reuse-conditions.csv`, `reuse-rounds.csv` | MATCHED | High | Untracked | Commit |
| P-RESULT-009 | Tables IX and X; Fig. 10 | p16–17 | `results/tables/dias_testbed_e3_functions.csv`; `results/tables/dias_testbed_e4_summary.json`; `REPORT.md` §2–3 | MATCHED | High | Untracked | Commit |
| P-RESULT-010 | Table XI and Fig. 11 | p17 | Confusion counts in `COMPARISON.md` | MATCHED | High | Untracked | Commit |
| P-RESULT-011 | Table XII and Fig. 12 | p17–18 | `results/tables/dias_testbed_e5_levels.csv`; `REPORT.md` §4 | MATCHED | High | — | — |
| P-RESULT-012 | Table XIII counts and times | p18 | `results/tables/dias_testbed_e6_summary.json`; `results/tables/dias_testbed_e7_summary.json`; `analysis/e7/e7-summary.json` | MATCHED | High | — | — |
| P-RESULT-013 | "Of the four failures, three occurred before any component was stopped" (text and Table XIII note) | p18 | Raw trace `raw/e7-fault-20260925T043602Z/backend-trace.jsonl`: the four HTTP 500 calls started between 0.7 s before and 10.5 s after orderer3 was stopped (timeline epoch 1790311335.78). They ended with 10–60 s timeouts. `analyze_e7.py:71` groups workflows by workflow **start** time. | CONTRADICTED | High | An artifact of grouping by start time | Rewrite: all four were ledger writes in flight during the failover |
| P-RESULT-014 | Fig. 13: CPU and memory of each node | p18 Fig. 13 | `analysis/e6/e6-machines-series.csv`; `raw/mac/mac-samples.csv`; `testbed/analysis/resource_grid.py:83` plots `model_rss_bytes` | PARTIALLY MATCHED | High | The model node shows RSS (8.75 GB mean, 8.80 GB peak). GPU memory (12.55 GB mean, 17.35 GB peak) and GPU utilisation (85.8% mean), computed from the same samples, are not shown. The figure is not discussed in the text. | Plot GPU use, or caption the limitation |

### 3.5 Security, explainability and human review

| Claim ID | Paper claim | PDF page/section | Repository evidence | Status | Confidence | Problem or limitation | Required action |
|---|---|---|---|---|---|---|---|
| P-SEC-001 | Requests and decisions are recorded on a ledger no single participant can alter (C2; Table I) | p4; p6–7 | MAJORITY endorsement (3 of 5); three-node Raft; after the fault test all five peers report the same block hash (`fault-timeline.json`, `chain_info_after.same_hash: true`) | MATCHED | High | The backend holds every user's key, so a compromised backend can submit valid transactions as anyone (acknowledged on p18). | Keep the disclosure |
| P-SEC-002 | Tamper-evident audit of both the recommendation value and the decision | p6 §III | The WT stores the value at decision time. The value comes from the backend, so the ledger cannot prove what the model said. | PARTIALLY MATCHED | High | — | Qualify |
| P-SEC-003 | Bounded authority: the model cannot grant access; access comes only from an auditor decision or an authorization an auditor created | p5 Contribution 1; Table I | Grants happen only through `SubmitAuditorDecision` (auditor-only) or a MATCH. The LLM has no credential. | MATCHED | High | Holds only if the backend is honest. | Disclose in §IV-A |
| P-SEC-004 | A requester cannot decide their own request | p8 §IV-E; p14 | `accessContract.js:615-618`; test `diasAccessSecurity.test.js:91`; the UI disables the buttons | MATCHED | High | — | None |
| P-SEC-005 | Delimiters do not make the model injection-resistant; safety relies on human authority | p13; p18 | `recommendationPrompt.js:56-61` | MATCHED | High | — | None |
| P-SEC-006 | DIAS lets organizations exchange data "securely ... with confidentiality, integrity, and accountability" | p5 §II | Content sits off-chain in an unencrypted vault inside the shared backend. The public decision log shows every requester and record to every channel identity (`accessContract.js:844-892`, by design). `GetRecordHistory` (`recordContract.js:553-569`) and `ListEvidence` (`633-645`) have no caller checks. No confidentiality experiment exists. | PARTIALLY MATCHED | High | The claim is too general. | Narrow the wording |
| P-SEC-007 | Key custody and compromised-backend risks are stated as limitations | p12; p18 | `gateway.js:29-64`; `routes/access.js:277-292` | MATCHED | High | — | None |
| P-SEC-008 | All VMs share one physical host; no independent failure domains | p11; p14; p18 | Manifest | MATCHED | High | Not disclosed: the separate single-host `wt-dias` network ran in the background (about 0.2 CPU core) during the testbed runs (`testbed/README.md`; `REPORT.md` "Limits"). | Disclose |
| P-XAI-001 | Every recommendation carries a reason code, versioned policy clauses and missing evidence; each decision is proposed with a structured explanation | p1; p6 | Six-key schema (`recommendationSchema.js:13-18`); clause references such as `GP-RBAC:C2@v1` in the labels; stored off-chain | MATCHED | High | Automatic grants carry only the reuse reason. The explanation is not tamper-evident. | None |
| P-XAI-002 | Every outcome states the clause, the attributes, and "what would have to change for a different outcome" | p4 C3 | Only the `missing_evidence` field. There is no counterfactual generation in the DIAS path; counterfactuals exist only in the unreachable `backend/src/llm/template.js`. | PARTIALLY MATCHED | Medium | — | Narrow C3, or add counterfactuals |
| P-XAI-003 | Reason accuracy and exact-reference accuracy measure explanation quality | p15–16 | `metrics.js:94-97`: exact reason-code match, and order-sensitive exact list of references, over usable answers | MATCHED | High | The definitions are not in the paper. | Define them |
| P-HUM-001 | The auditor makes the binding decision; the model stays advisory | p1; p5 | The contract accepts decisions only from auditors; the model has no credential | MATCHED | High | — | None |
| P-HUM-002 | Human review in the evaluation | p17 (E5 only) | E5, E6, E7 and the reuse run all used a scripted auditor (`REPORT.md` §0; reuse plan `auditorRule`). In the reuse run the scripted auditor followed three model false ALLOWs, giving 24 grants through review (`RESULTS.md`). | PARTIALLY MATCHED | High | No experiment used a human auditor. The paper says the auditor was scripted only for E5. | Disclose for every run |
| P-DOC-001 | Name and title "DIAS: Dynamic Explainable Access Control for Blockchain-Based Data Sharing" | p1 | `README.md` and `CITATION.cff:3` say "Dynamic and Explainable Access Control for Blockchain-enabled Inter-organizational Data Sharing". The PDF file name says "SEAL — Secure Explainable AI based Law Enforcement". | CONTRADICTED | High | Inconsistent naming | Use one name everywhere |

---

## 4. Architecture comparison

### 4.1 What the paper's Methodology (§IV) describes

1. The requester submits (u, r, c, a, p, J).
2. The contract builds C and records h_C, **h_J** and **v_P**.
3. The contract checks the latest authorization for σ, including **v_P**.
   - 4a. On a match: automatic grant.
   - 4b. Otherwise: the recommendation service creates M and h_M, and the contract commits **κ** before review.
4. The auditor interface checks **H(M) = h_M** before review.
5. The auditor decides. The note N is stored **first**, and **h_N** goes into the transaction.
6. The contract derives g from **κ** and checks self-review, context, **v_P**, **κ** and **h_N**.
7. The contract creates α (with **v_P** and **κ**) and records the outcome.
8. Release checks the credential, the authorization and **v_P**.

Bold items are not implemented (see §9).

### 4.2 The execution path that actually ran (WT = testbed = today's working tree)

```text
Browser (frontend/js/modules/request-access.js)
  | POST /api/access/request {recordId, action, purpose, justification}
  v
Backend  routes/access.js:133-169
  - zod validation
  - the justification is never sent to Fabric
  - submits CreateAccessRequest(recordId, {action, purpose, emergencyFlag}),
    signed with the user's key, which the backend holds (gateway.js:29-64)
  v
Chaincode  AccessContract.CreateAccessRequest  (accessContract.js:331-512)
  - identity from the certificate; profile and case assignment from the ledger (191-213)
  - verified request C and its SHA-256 hash h_C (340-351)
  - scope sigma and its hash; latest authorization read and matched in the same transaction (360-371)
  +-- MATCH -> GRANTED outcome + AUDITOR_REVIEW_SKIPPED event (441-474) -> HTTP 201; no model call
  +-- miss  -> status "awaiting-auditor" (500-511); an expired authorization is transitioned (476-499) -> HTTP 202
        v
     Backend openReview (routes/access.js:100-116)
       - review-store entry {C, J} (reviewStore.js:49-65; off-chain JSON file)
     Recommendation worker (recommendationWorker.js:36-117), one request at a time
       - recommender.js: prompt (recommendationPrompt.js)
         -> MLX-LM server on the Mac (HTTP; no Fabric identity)
         -> schema check (recommendationContract.js)
       - result {recommendation, reason_code, reason, policy_refs, missing_evidence,
         review_flags, provenance} is written to the review store only
        v
     Auditor UI (auditor-review.js) <- GET /auditor/pending (ledger request + off-chain review)
        | POST /auditor/:id/decision {FORCE_ALLOW | FORCE_DENY, reason?, validUntilUtc?}
        v
     Backend decide() (routes/access.js:265-307)
       - HTTP 409 while the recommendation is pending
       - a reason is required unless AGREED (checked by the backend only)
       - q = stored recommendation in {ALLOW, DENY, UNAVAILABLE}
       - submits SubmitAuditorDecision(requestId, decision, q, validUntilUtc)
        v
     Chaincode SubmitAuditorDecision (accessContract.js:602-710)
       - AuditMSP + district-head role (174-179); status awaiting; not self (615-618); facts unchanged (619)
       - g = agreementFor(decision, q) (91-98, 612)
       - FORCE_ALLOW and NOT_AGREED -> create or supersede the exact-scope authorization (514-595)
       - auditor-decision record + outcome + lifecycle events, in one atomic transaction
        v
     Backend writes the auditor note off-chain AFTER the commit (routes/access.js:293-305)
  v
Release
  - GetAuthorizedRecordMetadata and CreateFullDocumentRequest re-check the grant basis
    (recordContract.js:133-150, 351, 409)
  - the owner station uploads the PDF hash (UploadRequestedDocument, 454-499)
  - final download AuthorizeRequestedDocumentRead (526-551) re-checks only the requester identity
  - the backend compares the vault hash with the committed hash (routes/records.js:166-181)
Access log: after every HTTP response the backend submits AuditContract.RecordAccessEvent (accessLogger.js)
```

### 4.3 Differences between the paper, the evaluated code and the public commit

| Element | Paper §IV (Methodology) | Evaluated code (WT, testbed `diasrecords` 2.3) | Public commit HEAD `7de0a20` (`diasrecords` 2.2 in `Makefile:28`) |
|---|---|---|---|
| Recommendation on the ledger | κ committed **before** review | Value (ALLOW / DENY / UNAVAILABLE) committed **with** the decision | Not recorded |
| Agreement g | Derived by the contract from κ | Derived by the contract from the backend-supplied value | Supplied by the backend |
| Policy version v_P | In the request, κ and α; checked on reuse and release | Absent | Absent |
| h_J, h_M, h_N on the ledger | Yes | No (h_J only in off-chain provenance) | No |
| Auditor note | Stored before the transaction; contract requires h_N | Required by the backend; stored after the commit | Required by the backend (not re-verified for HEAD) |
| Generation status on the ledger | s inside κ | UNAVAILABLE only | None |
| Release re-check | At release, including v_P | Metadata and PDF-request steps only; not at the final PDF download; no v_P | Same as WT (`recordContract.js` is unmodified) |
| Deployment | Three Fabric VMs + three Raft orderers + backend VM + host LLM (§V) | Untracked `testbed/` | Single host, one orderer; SEAL-era `crimechannel` also built |
| AI component | Advisory LLM in the recommendation service | Same; V7 served by MLX-LM on the host | Same code path, but the default `make dias-model` serves the untuned base unless an adapter is given (README) |
| Human review | Binding auditor | Auditor UI and API exist; **every experiment used a scripted auditor** | Same |

---

## 5. Experiment coverage matrix

| Experiment | Paper reference | Runner/config | Dataset | Baseline | Proposed method | Ablation | Raw results | Plot/table | Reproducible? | Gap |
|---|---|---|---|---|---|---|---|---|---|---|
| Recommendation quality, five test groups | §VI-A; Table VII; Fig. 8; Abstract | `experiments/dias-finetuning/v2/eval/evaluate.js`, driven by `experiments/runs/20260912_dias_qwen3_baseline/run-baseline.sh` and `scripts/dias/evaluate-v7.sh`; decoding in `metrics.json` | `experiments/dias-finetuning/data-v2-binary/` (tracked) | Untuned Qwen3-14B-4bit (tracked predictions) | V7 (tracked predictions) | Input ablations exist (200 examples); not reported | Tracked `predictions/*.jsonl` and `metrics.json` for both models | `results/tables/dias_paper_final_model_comparison.csv` (tracked); `dias_testbed_accuracy.csv` (untracked); **Fig. 8: no script** | Re-scoring: yes. Re-inference: needs the V7 weights (ignored), MLX, and about 6 h per model (see `run-baseline.sh` comment and V7 `evaluation.log`). | Weights not published; one training seed; figure script missing |
| Fine-tuning and validation loss | §V-B; Table IV; Fig. 3 | `scripts/dias/train-v7.sh`; `experiments/dias-finetuning/train-v7.yaml`; `adapter_config.json` | `train.jsonl` and `valid.jsonl` (tracked) | — | V7 | Three-seed pilot on a small subset; not reported | `training.log`, `run.json`, `checkpoint-selection.json` (tracked) | Fig. 3 via `testbed/analysis/v7_validation_loss.py` (untracked) | Re-plot: yes. Re-train: blocked by the V6-adapter preflight (path outside the repository); about 19 h on an M3 Max | Single seed; external dependency |
| Adversarial justifications | §VI-A; Table VII | As above | `test-adversarial` (389; 115 also in the balanced set) | Untuned | V7 | 120-example expanded adversarial set; not reported | Tracked | Table VII | Yes (re-scoring) | Overlap not reported |
| Dynamic authorization reuse | §VI-B; Table VIII; Fig. 9; Abstract | `testbed/reuse/{plan,seed,run,check-ledger}.js`; `testbed/scripts/start_reuse.sh`, `finalize_reuse.sh`; plan seed 20260925 | 100 load users, 300 records (generated plan) | No reuse (computed); broader property fingerprint (replayed) | Exact-record reuse (live) | — | `experiments/runs/20260925_reuse_100_users/raw/` (untracked) | `RESULTS.md`, CSVs, `reuse_scope_by_repeats.pdf`; **the paper's Fig. 9 style has no script** | Re-analysis: yes (raw kept). Re-run: needs the testbed, about 4.2 h. | Abstract uses the old 23.75%; random approvals and scripted auditor not disclosed |
| Model alone (E4) | §VI-C; Table X "Model" row; Fig. 10 | `evaluate.js` against the testbed model server; `testbed/analysis/analyze_e4.py` | `test-decision-balanced` (600) | — | V7 | — | `raw/e4-llm-alone` (untracked) | `results/tables/dias_testbed_e4_summary.json` | Re-analysis: yes | — |
| Ledger alone (E3) | §VI-C; Tables IX–X; Fig. 10 | `testbed/load/run-ledger.js`; `testbed/analysis/analyze_e3.py` | Synthetic testbed world | — | DIAS contract 2.3 | — | `raw/e3-ledger-20260925T043602Z/transactions.jsonl` (73 MB, untracked) | `results/tables/dias_testbed_e3_functions.csv` | Re-analysis: yes. The endorsement and orderer timing columns query the testbed Prometheus (`analyze_e3.py:52-53`). | W1/W2 coupling and the R2 deadline are not explained |
| External access-control tasks | §VI-D; Table XI; Fig. 11 | `experiments/cross-dataset/{build_llmac,build_orgaccess,run_eval,score,report}.py` | LLMAC reconstruction (180); OrgAccess easy binary (100) | Untuned | V7 | — | `experiments/runs/20260924_cross_dataset/{base,v7}/*.pred.jsonl` (untracked) | `COMPARISON.md`; **Fig. 11: no script** | Re-scoring: yes | 83 MB of raw OrgAccess data is untracked and has no licence notice; 40 `partial` cases were evaluated but not reported |
| Whole system (E5) | §VI-E; Table XII; Fig. 12 | `testbed/load/run-burst.js`, `plan.js` (seed 20260924); `analyze_e5.py` | Seeded burst plan (12 requester profiles) | — | Full DIAS (V7 + contract 2.3) | — | `raw/e5-burst-20260924T174213Z` | `results/tables/dias_testbed_e5_levels.csv`; **Fig. 12: no script** | Re-analysis: yes | 21 policy disagreements (7 wrongly granted) not discussed |
| One hour (E6) | §VI-E; Table XIII row 1; Fig. 13 | `run-steady.js`, `start_e6.sh`, `analyze_e6.py`, `resource_grid.py` | Seeded steady plan | — | Full DIAS | — | `raw/e6-steady-20260925T023853Z`, `raw/mac/mac-samples.csv`, `raw/containers/container-stats.csv` | `results/tables/dias_testbed_e6_summary.json`; `analysis/e6/e6-machines-series.csv` | Re-analysis: yes | Fig. 13 model memory is RSS; correctness 358/369 not reported |
| Fault test (E7) | §VI-E; Table XIII rows 2–5 | `testbed/scripts/run_fault_test.py`; `analyze_e7.py` | Seeded fault plan | — | Full DIAS | — | `raw/e7-fault-20260925T043602Z` | `analysis/e7/e7-summary.json` | Re-analysis: yes | Failure attribution is wrong; single run |
| Ablations | Not in the paper | `experiments/dias-finetuning/v2/eval/ablations.js`, `run-ablations.js` | 200-example subset | Full input | V7 | Five input removals | Tracked | `results/tables/dias_paper_final_input_ablation.csv` | Yes | Not reported |
| Human-auditor study | Not in the paper | — | — | — | — | — | — | — | — | Not performed |

**Cross-cutting checks:**

- **Seeds.** Training seed 42 is recorded. The plan seeds 20260924 and 20260925 are recorded. Decoding is deterministic (temperature 0).
- **Repeated runs.** E5 has three repetitions. Training and every other experiment ran once. The three-seed pilot, which ran at small scale, shows large variation (validation balanced accuracy 0.67–0.73; false ALLOWs 11–35).
- **Multiple VMs.** Yes: four Lima VMs on one physical host.
- **CPU and memory.** E6 per machine and per container; also the reuse run, which the paper does not report.
- **Negative results kept.**
  - Two aborted E6 attempts are retained under `-ABORTED-not-used` names.
  - Two reuse smoke runs are retained, including a failed one with its runner bug documented.
  - The seed pilot is retained.

---

## 6. Numerical result verification

"Exact match" allows rounding to the precision printed in the paper.

| Paper table/figure | Metric/value | Source artifact | Exact match? | Recalculation possible? | Finding |
|---|---|---|---|---|---|
| Abstract | V7 balanced accuracy 98.67% on 600 decisions | `results/tables/dias_testbed_accuracy.csv` (0.9867); V7 `metrics.json` (0.986667); `test-decision-balanced.cases.jsonl` (600) | Yes | Yes, from tracked predictions | — |
| Abstract | Reuse avoids "up to 23.75%" | `results/tables/dias_scope_workload_sweep.csv` rows 33 and 36 (superseded offline replay) | **No.** The reported experiment reaches 21.0%. | Yes | Contradiction (C-06) |
| §II (p5) | Balanced accuracy 60.27% → 98.67% | V7 and baseline `metrics.json` (0.602737 counts usable answers only) | Value exists; convention differs from Table VII (56.0%) | Yes | Contradiction (C-07) |
| §VI intro (p14) | 98.67%; 21% of reviews avoided | Accuracy CSV; `RESULTS.md` (504 / 2,400) | Yes | Yes | — |
| Table III | Ten DENY clauses, order, reason codes | `policies/dias-governance-policy-v1.json` | Yes | — | — |
| Table IV | All settings | `adapter_config.json`; `training.log`; `run.json` | Yes ("about 19 h" = 18 h 43 min; 13.3 GB = 13.275 GB) | Yes | Longest example 2,150 tokens: no stored output |
| Fig. 3 / text | 1.423; below 0.01 by iteration 1,500; 0.002–0.007 afterwards; final 0.003; minimum 0.002 at 4,500 | `training.log` | Partly: 0.008 at iteration 1,750 | Yes | Minor (C-11) |
| Table VI | All eight rows | `data-v2-binary/*.cases.jsonl` | Yes | Yes | — |
| Text p15 | 1,764 distinct test requests | Computed from the case files | Yes | Yes | Group overlap 535, of which 115 are adversarial ∩ balanced; not reported |
| Table VII, balanced | Untuned 554 valid; 336 correct (56.0%); FA 14; FD 204; reason 203; refs 130. V7 600; 592 (98.7%); 6; 2; 584; 572. | Accuracy CSV; comparison CSV | Yes | Yes | — |
| Table VII, reason-focused | Untuned 509; 448 (83.0%); 19; 42; 244; 122. V7 540; 536 (99.3%); 4; 0; 531; 514. | Same | Yes | Yes | — |
| Table VII, adversarial | Untuned 333; 188 (48.3%); 4; 141; 88; 61. V7 389; 383 (98.5%); 6; 0; 383; 383. | Same | Yes | Yes | — |
| Table VII, paraphrased | Untuned 373; 240 (60.0%); 28; 105; 163; 127. V7 400; 395 (98.8%); 4; 1; 395; 392. | Same | Yes | Yes | — |
| Table VII, multiple-rule | Untuned 352; 352 (95.1%); 0; –; 191; 4. V7 370; 370 (100%); 0; –; 351; 301. | Same | Yes | Yes | — |
| Fig. 8 | V7: allowed 298 correct / 2 FD; denied 294 / 6 FA. Untuned: allowed 70 / 204 / 26 unusable; denied 266 / 14 / 20. | `REPORT.md` §1; accuracy CSV | Yes | Yes (values); figure file not regenerable | — |
| §VI-A text | 204 → 2 FD; 46 → 0 unusable; 14 → 6 FA; 98.5–100% vs 48.3–95.1%; exact refs 301 vs 4 | Same | Yes | Yes | — |
| Table VIII | Rounds 1–8: DIAS 0, 72, …, 504 (21.0%); broader 48, …, 552 (23.0%); unapproved grants 0 vs 48, …, 384 | `RESULTS.md`; `reuse-conditions.csv`; `reuse-rounds.csv` | Yes | Yes (raw kept) | — |
| Fig. 9 | Same values | Same | Yes | Values: yes. Figure file: not found. | — |
| Table IX | R1: 64,373…75,274 OK, 2,145.61…2,508.59 op/s. R2: 71 / 50 / 0 / 0 / 0 OK; 2.28 and 1.20 op/s. | `results/tables/dias_testbed_e3_functions.csv` | Yes | Yes | — |
| Table X | Model 600 / 0, p50 8.334 s, p95 9.189 s, 0.121/s (7.27/min). W1 and W2: all 10 rows. | E3 CSV; `results/tables/dias_testbed_e4_summary.json`; `REPORT.md` §2 | Yes | Yes | W2 counts equal W1 by design |
| §VI-C text | 0.121; 122.70; 90.65; 2,508.59; 2.28 | Same | Yes | Yes | — |
| Table XI | LLMAC untuned 113/180, BA 62.4, valid 169/180, FA 0; V7 119, 65.8, 176, 0. OrgAccess untuned 77/100, 76.7, 99, 2; V7 78, 77.7, 98, 2. | `COMPARISON.md` | Yes | Yes | — |
| Fig. 11 | Confusion counts (for example V7 LLMAC 119 / 57 / 0 / 4) | `COMPARISON.md` | Yes | Values: yes. Figure file: not found. | — |
| Table XII | 30/30, 40.5, 77.7, 7.62, 30/30 … 300/300, 372.3, 699.8, 8.16, 290/300 | `results/tables/dias_testbed_e5_levels.csv`; `REPORT.md` §4 | Yes | Yes | — |
| Fig. 12 | Same values | Same | Yes | Values: yes. Figure file: not found. | — |
| Table XIII | One hour 369 / 369 / 0, 24.3, 57.9. Phases 21/18/3 (18.0, 33.9); 21/20/1 (39.8, 51.5); 17/17/0 (16.8, 30.8); 24/24/0 (31.8, 56.5). | `REPORT.md` §5–6; `analysis/e7/e7-summary.json` | Yes | Yes | — |
| §VI-E text and Table XIII note | "three failures preceded the induced fault" | `raw/e7-…/backend-trace.jsonl`; `fault-timeline.json`; `analyze_e7.py:71` | **No** | Yes | Contradiction (C-08) |
| Fig. 13 (a)–(i) | VM CPU about 0.05–0.18 cores; memory about 1.1–1.4 GB | `analysis/e6/e6-machines-series.csv`; `REPORT.md` §5 (M1 0.11 / 1.11 GB, M2 0.15 / 1.40, M3 0.18 / 1.42, M4 0.05 / 1.11) | Consistent | Yes (`resource_grid.py`) | — |
| Fig. 13 (e), (j) | Model process CPU 0.16 / 0.37 cores; RSS about 8.8 GB | `raw/mac/mac-samples.csv` | Consistent with the plotted series | Yes | Omits GPU memory (12.55 / 17.35 GB) and GPU utilisation (85.8%) |
| §VI setup | M3 Max, 16 cores, 64 GB; 4 × (3 vCPU, 6 GB); Fabric 2.5.16; 5 organizations; 3 orderers; 2 s / 10 transactions; 3 of 5 | `manifest.json`; `testbed/config/configtx.yaml` | Yes | — | — |

---

## 7. Paper-only items

Claims, components or experiments in the paper that lack implementation or evidence in the repository:

1. **Pre-review recommendation commitment κ.** §IV-A (p7), §IV-D Eq. (2) (p8), Algorithm 1 (p10), Fig. 2 caption (p9), Table II (p7). Not implemented.
2. **Auditor-side verification H(M) = h_M** before a decision can be submitted. §IV-D (p8).
3. **Policy version v_P** in the request, in κ and in α, with reuse and release bound to v_P. §IV-C, §IV-F, §IV-G; Algorithm 1; Table II.
4. **On-chain h_J, h_M and h_N**, and an audit tuple τ containing a reference to κ and H(N). §IV-C, §IV-E, §IV-G; Table II.
5. **Contract-enforced note commitment** for NOT_AGREED and NO_RECOMMENDATION, with the note stored before the decision transaction. §IV-E; Algorithm 1 l.18 and 29–30.
6. **Generation-status detail on-chain.** On-chain there is only UNAVAILABLE. §IV-B.
7. **Lifecycle events** for "recommendation commitment" and "agreement derivation". §IV-G.
8. **Release-time re-check at the final PDF release**, and v_P binding at release. §IV-G.
9. **Counterfactual explanation** ("what would have to change for a different outcome"). Challenge C3, p4.
10. **A reported result for the 60 complete-request examples** listed in Table VI.
11. **A stored artifact for "the longest example has 2,150 tokens"** (Table IV). The claim is documented and a script exists, but no output is stored.
12. **Generating scripts or data sheets for the images of Figs. 8–12.** The values are traceable; the figure files are not reproducible from the repository.
13. **The LaTeX source of this PDF.** It is intentionally outside the repository (README: "The manuscript is kept outside this repository until publication"). As a result, the paper text itself cannot be version-matched to a commit.

---

## 8. Repository-only items

Meaningful repository content that the paper does not describe.

| # | Component | Location | What it does | Connected to the main workflow? | State | Document in the paper? | Keep public? | May confuse reviewers? | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | V7 input ablations | `experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval/ablations/`; `results/tables/dias_paper_final_input_ablation.csv` | Removes parts of the prompt on 200 examples. Full: 0.985. No requester: 0.58. No resource: 0.58. No action/purpose: 0.92 (12 false ALLOWs). No policy: 0 valid answers. No justification: 0.99. | Evaluation only | Current | Yes. `AGENTS.md` requires ablations, and these show which inputs matter. | Keep | Low | Tracked files |
| 2 | Three-seed pilot | `experiments/runs/20260916_dias_seed_pilot/`; `results/tables/dias_seed_pilot.csv` | Seeds 17, 42 and 73 on a small subset: validation balanced accuracy 0.67–0.73; false ALLOWs 11–35 | Evaluation only | Pilot | Mention as a seed-sensitivity limitation | Keep | Low | Tracked |
| 3 | Expanded adversarial set | `experiments/dias-finetuning/adversarial-expanded/`; `experiments/runs/20260917_dias_expanded_adversarial/` | 120 all-DENY templated attacks: 0 false ALLOWs, but review-flag accuracy 62.5% and authority role-play 5% (`reports/iteration/iter_052_dias_overnight_experiments.md:40-47`) | Evaluation only | Current | Could strengthen the prompt-injection discussion | Keep | Low | Tracked |
| 4 | Validation-set results | Accuracy CSV | V7 395/400; untuned 215/400 | Evaluation only | Current | Optional | Keep | Low | Untracked CSV |
| 5 | Offline scope ablation and workload sweep | `experiments/runs/20260912_dias_scope_ablation/`, `experiments/runs/20260916_dias_scope_workload_sweep/`; `results/tables/dias_scope_*.csv`, `dias_fingerprint_ablation.csv`; `experiments/dias-finetuning/v2/eval/scope-ablation.js` | Deterministic offline replay (60 users) with 23.75% savings and 224 cross-record grants | Superseded by the live 100-user run | **Obsolete.** `RESULTS.md` explains its flaw: approvals were redrawn in each condition. | No, except as history | Keep, labelled SUPERSEDED | **High** — the abstract number came from it | `iter_052:58-74` |
| 6 | Single-host concurrent-user test (1–12 users, 81 workflows) | `results/tables/dias_concurrent_users.csv`; `iter_052` §5 | Earlier latency test | Superseded by E5 | Obsolete | No | Keep, labelled superseded | Medium (the PDF's own Comment 36 still says 81) | Tracked |
| 7 | Live acceptance scenarios (14 scenarios / 81 checks) and audit reconstruction (7/7 paths) | `experiments/runs/20260916_dias_v7_live_acceptance_r3/`, `experiments/runs/20260916_dias_audit_reconstruction/`; `results/tables/dias_audit_reconstruction.csv`; `make dias-acceptance` | Functional end-to-end checks on a live network | Yes (functional verification) | Predates the uncommitted contract change (`accessContract.js` modified 2026-09-24) | Could support the "reconstructable control path" claim | Keep | Low | Tracked |
| 8 | OrgAccess `partial` cases (40) and medium/hard splits | `experiments/cross-dataset/orgaccess/`; `COMPARISON.md` | Extra evaluation; medium/hard judged unusable for balanced accuracy | Evaluation only | Current | Optional | Keep the processed subsets; the raw splits need a licence notice | Medium | Untracked |
| 9 | Ledger-growth measurement | `REPORT.md` §7; `results/tables/dias_testbed_ledger_growth.json` | The public-log query slows from 94 ms to 3,495 ms at 31,828 requests (full scan in `accessContract.js:844-892`) | Evaluation only | Current | Yes: it explains why R2 collapses in Table IX | Keep | Low | Untracked |
| 10 | Per-container resources; reuse-run resource and timing data | `raw/containers/container-stats.csv`; reuse `RESULTS.md` | Container CPU and memory; reused request 0.53 s vs reviewed request 11.82 s plus a 9–13 min queue | Evaluation only | Current | Useful | Keep | Low | Untracked |
| 11 | Public decision log | `accessContract.js:844-892`; `frontend/js/modules/decision-log.js` | Any channel identity can read who requested which record and what was decided | Main workflow | Current | **Yes**: a privacy-relevant design choice | Keep | Medium | WT |
| 12 | Evidence custody, sealing, court workflow, private data collection | `recordContract.js` (AttachEvidenceHash, TransferEvidenceCustody, Seal/Unseal, GetEvidenceDetail); `governanceContract.js:162`; `chaincode/collections-config.json` | Domain features beyond the access path | Main application, not the DIAS access path | Current | Brief mention | Keep | Low | Tracked |
| 13 | Legacy SEAL-era policy engine | `chaincode/crimerecords/lib/policy/{policyEngine,controlledDecision,llmDecisionProtocol,dynamicPolicy,reasonDecisions}.js`; `chaincode/crimerecords/test/legacy/` | Old rule engine | Excluded from the package (`deployCC.sh:38-40`) | Legacy | Already mentioned as excluded | Human decision | Medium | Architecture guard |
| 14 | Legacy backend LLM modules | `backend/src/llm/` (7 files) | Old decision engine, attestation, prompts | **Not imported by any runtime module** (`server.js` imports; grep) | Dead at runtime | No | Archive (human decision) | High | `backend/test/architectureGuard.unit.test.js` |
| 15 | LLMxAI | `LLMxAI/` (219 tracked files) | SEAL-era LLM-only runtime and datasets v3–v5 | Only the V7 `adapter_config.json` and `requirements.txt` matter to DIAS | Legacy | No | Split or archive | High | `LLMxAI/README.md` |
| 16 | Solidity demo | `solidity-frontend/` | Standalone EVM/MetaMask demonstration | Not connected | Separate prototype | No | Archive separately | High | README |
| 17 | Caliper benchmarks | `benchmarks/caliper/`; `experiments/runs/2026-08-24T*_caliper_*` | SEAL-era benchmarks against `crimechannel` | Not connected; README says "not retargeted to DIAS" | Obsolete for this paper | No | Archive | Medium | README |
| 18 | SEAL paper experiments | `paper-tests/` (104 files); `paper experiment results/` (29 files) | Earlier paper's evidence | Not connected | Obsolete | No | Archive | High | `paper-tests/README.md` |
| 19 | SEAL-era six-organization channel with an AI organization | `network/configtx/configtx.yaml:220-242`; compose files | Built by `make up` | Coupled to setup; not used by DIAS | Legacy | No | Refactor or document | Medium | README |
| 20 | Historical design documents | `docs/ai-as-network-participant.md`, `docs/llm-on-chain-challenges.md`, `docs/related-work-llm-on-chain.md` | Retired design, labelled as historical | — | Historical | No | Keep, labelled | Low | Headers |
| 21 | Duplicate code snapshot | `experiments/runs/20260915_dias_backend_llm/before/` (187 files: backend 53, chaincode 47, frontend 44, scripts 25, policies 9, network 8, Makefile) | Copy of the pre-redesign code | Not connected | Duplicate | No | Archive | High | `git ls-files` |
| 22 | Identical backend traces | `experiments/runs/20260924_testbed_multivm/raw/{,e5-…,e6-…,e7-…}/backend-trace.jsonl` | One cumulative trace copied four times (same MD5) | — | Duplicate | No | Keep one and document | Medium | MD5 |
| 23 | Old graph workbook | `outputs/20260917_google_sheets_experiments/` | Older graphs | Unknown | Unclear | No | Human decision | Medium | — |
| 24 | Third-party papers | `papers/reference_library/` (42 PDFs), `reports/research/**` (7 PDFs), `LLMxAI/2511.20284v2.pdf` | Reading material | — | — | No | **Remove from the public repository** (licence) | Medium | `git ls-files '*.pdf'` |
| 25 | Root leftovers | `_figpreview.svg`, `test-refs.bib` (a placeholder entry `@misc{x, title={X}…}`), `SNAPSHOT.md` (absolute paths) | Leftovers | Not referenced | Obsolete | No | Human decision | Low | File contents |
| 26 | Multi-VM testbed | `testbed/` (untracked) | Builds and runs every Section VI experiment | **Required for the paper** | Current | Yes (already described) | **Commit** | — | `testbed/README.md` |

---

## 9. Contradictions

Direct disagreements involving the paper, the code and the repository's own documents.

- **C-01 — Recommendation commitment.**
  - §IV (p7–10) and Fig. 2 say κ is committed before review.
  - §V-A (p11), §V-C (p12), §V-F (p14) and §VII (p18) say it is not.
  - The code has no κ (`accessContract.js:602-612`).
- **C-02 — Policy version.**
  - §IV-C, §IV-F, §IV-G, Algorithm 1 and Table II bind reuse and release to v_P.
  - §V-E (p13) and §VII say v_P is not stored.
  - The code has no v_P (`authorization.js:79-161`).
- **C-03 — Justification hash on-chain.**
  - §IV-C (p8), §IV-G (p9) and Algorithm 1 l.2 and 6 say h_J is on the ledger.
  - §V-F (p14) says there is no on-chain hash of J.
  - The code keeps it only off-chain (`recommender.js:87`).
- **C-04 — Auditor note.**
  - §IV-E and Algorithm 1 say the note is stored before the transaction, h_N is in the transaction, and the contract requires it.
  - The code checks the reason in the backend and stores the note after the commit (`routes/access.js:280-305`). The contract takes no note (`accessContract.js:602`).
- **C-05 — "The backend does not provide g"** (p8).
  - The backend supplies q, which fully determines g (p14; `routes/access.js:277-292`).
  - In the public HEAD the backend supplies g itself.
- **C-06 — Abstract saving.**
  - The abstract says "up to 23.75%".
  - Table VIII and §VI say 21% (504 / 2,400).
- **C-07 — Baseline accuracy convention.**
  - The introduction says 60.27% (usable answers only).
  - Table VII's rule ("an invalid output counts as an incorrect decision") gives 56.0%.
  - The harness documents the opposite rule (`metrics.js:11-14`).
- **C-08 — Fault-test failures.**
  - The text and Table XIII note say "three occurred before any component was stopped".
  - The raw trace shows all four failing ledger calls were in flight between 0.7 s before and 10.5 s after the orderer stop.
  - The fault script first observed the new Raft leader 12.0 s after the stop (`fault-timeline.json`); `REPORT.md` gives 6.18 s from another measurement.
  - The grouping is by workflow start time (`analyze_e7.py:71`).
- **C-09 — Contents of C.**
  - §IV-C says C includes the stable identity and the record ID.
  - `verifiedRequest.js:10-11` excludes both.
- **C-10 — Release re-check.**
  - §IV-G says the grant basis is re-checked at release.
  - `AuthorizeRequestedDocumentRead` (`recordContract.js:526-551`) does not re-check it.
- **C-11 — Validation-loss range.**
  - Fig. 3 text says 0.002–0.007 after iteration 1,500.
  - `training.log` shows 0.008 at iteration 1,750.
- **C-12 — Public commit and README vs paper.**
  - HEAD's contract accepts the agreement from the backend and records no recommendation.
  - The committed README says "The chaincode trusts the backend's agreement value" and "The ledger … does **not** prove what the LLM recommended".
  - Both contradict the paper's §V-G and Fig. 6, which match the WT.
  - README "Known limitations" says the network "runs on one computer with one orderer", while the paper reports three Raft orderers (from the untracked testbed).
  - `Makefile:28` deploys `diasrecords` 2.2; the evaluated version is 2.3.
- **C-13 — Naming.**
  - Paper title: "Dynamic Explainable Access Control for Blockchain-Based Data Sharing".
  - README and `CITATION.cff`: "Dynamic and Explainable Access Control for Blockchain-enabled Inter-organizational Data Sharing".
  - PDF file name: "SEAL — Secure Explainable AI based Law Enforcement".
- **C-14 — Surviving evidence after data loss.**
  - §IV-A says the ledger keeps the recommendation's "digital fingerprint".
  - No fingerprint exists.
- **C-15 — Fig. 13(j) model memory.**
  - The panel plots process RSS.
  - The repository's own reuse report says process memory "understates its use, because the model's weights sit in GPU memory" (`RESULTS.md`, "Mac memory"). Recomputed over the E6 window from `raw/mac/mac-samples.csv`: GPU memory in use 12.546 GB mean, 17.346 GB peak; `RESULTS.md` quotes 12.6 / 17.4 GB for E6.
- **C-16 — Baseline serving (repository-internal).**
  - README says "Ollama qwen3:14b for the controlled untuned baselines".
  - The baseline `metrics.json` shows the MLX server (`url :8081`, base `mlx-community/Qwen3-14B-4bit`).
- **C-17 — Draft artifacts inside the PDF.**
  - The PDF's own review comments cite superseded numbers (Comment 36: "81 measured workflows"; Comment 6: 23.75%).
  - Section VI now reports 780 workflows and 21%.

---

## 10. Reproducibility gaps

### 10.1 Code version

- **The evaluated code is not committed.**
- The testbed manifest records HEAD `7de0a20` plus a working-tree diff hash (`tracked_diff_sha256` `6d2ba85e…`), but not the diff itself.
- Today's diff hash is `9fa5bf5f…`.
  - The difference is only cosmetic frontend files, changed on 2026-09-25 after the manifest was captured.
  - I verified this by diffing the staged testbed backend (`~/dias-testbed/build/app`) and chaincode (`~/dias-testbed/chaincode-staging/src`) against the repository. Only the frontend differs, plus the five legacy modules that are excluded by design.
- Those staging folders live outside the repository and would not survive a clean checkout.

### 10.2 Model weights

- The V7 weights are git-ignored and not published.
  - `adapters.safetensors`, 51 MB, sha256 `348f4ca5…`.
  - They sit under `LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7/`.
- The base model is public: `mlx-community/Qwen3-14B-4bit` at revision `a4d9b2df…`.
- Re-running inference therefore requires re-training.

### 10.3 Training

- `scripts/dias/train-v7.sh` hard-codes a V6 adapter path outside the repository.
- It exits with "PREFLIGHT FAILED" if that file is missing or has a different digest.
- **A clean checkout cannot run the documented training command.**
- Expected runtime is about 19 h on an M3 Max with 64 GB (from `run.json`).

### 10.4 Testbed

- `testbed/scripts/deploy-cc.sh:8,16` needs `chaincode-staging/src`, prepared by `prepare-chaincode.sh`. **That script does not exist.**
- `capture_manifest.py:86` reads `chaincode-staging/SOURCE_SHA256`, whose computation is also undocumented.
- `testbed/vm/` is empty. The VMs are created by `limactl` commands written as prose in `testbed/README.md`.
- Requirements:
  - Lima 2.1.4, Docker 29.x and Docker Swarm;
  - a runtime folder `~/dias-testbed` outside the repository;
  - Fabric CA enrolment with demo secrets (`testbed/scripts/register-users.sh:18`).
- `testbed/scripts/finalize.sh` regenerates the report and figures, but it:
  - reads `~/dias-testbed`;
  - re-captures a live manifest;
  - relies on the testbed Prometheus for some E3 columns.
- The individual `testbed/analysis/*.py` scripts do run on the saved raw folders.

### 10.5 Base network

- `make all` needs Fabric binaries and images in a sibling folder, `../fabric-samples`.
- The default `make dias-model` serves the untuned model unless `DIAS_ADAPTER` is given.

### 10.6 Dependencies

- **Node:** `package-lock.json` files are present for the backend and the chaincode.
- **MLX:** pinned in `LLMxAI/experiments/llm_policy_engine/requirements.txt` (`mlx==0.32.2`, `mlx-lm[train]==0.31.3`). This matches the local environment and the manifest (`mlx_lm.server 0.31.3`).
- **Python analysis and cross-dataset scripts:** matplotlib and other dependencies are **not pinned**.

### 10.7 Data

- **Main dataset:** fully tracked and validated (25/25 checks).
- **OrgAccess:** the raw download (83 MB) is untracked, and there is no download script with a pinned revision.
- **LLMAC reconstruction:** generated by `build_llmac.py`, which is untracked. The provenance is documented in `COMPARISON.md`.

### 10.8 Seeds and repeated runs

- Seeds are recorded for training, the plans and the reuse approvals.
- There is only one training seed. The paper gives no confidence intervals, although the harness computes Wilson intervals (`metrics.js:56-67`).
- E5 has three repetitions. E6, E7, the reuse run and the cross-dataset run were each run once.

### 10.9 Logs and metric provenance

- **Strong for re-scoring:**
  - tracked predictions;
  - `metrics.json` with the full model, decoding, policy-hash and dataset descriptors;
  - raw per-request JSONL for every testbed run.
- **Weak for release:** almost all Section VI evidence is untracked (244 MB).

### 10.10 Plot generation

- **Fig. 3:** can be regenerated from the tracked `training.log` (script untracked).
- **Fig. 13:** can be regenerated from `e6-machines-series.csv` and `mac-samples.csv` (both untracked).
- **Figs. 8–12:** **no generator.**
- **Figs. 1, 2, 4–7:** diagrams and screenshots. Their sources (draw.io files, screenshots) are only in the git-ignored manuscript folders, if at all.

### 10.11 Commands and approximate runtimes

None of these were run in this audit.

| Step | Command (from the repository) | Prerequisites | Approx. runtime |
|---|---|---|---|
| Validate the dataset | `node experiments/dias-finetuning/v2/validate.js` | Node 20+ | < 1 min (ran: 25/25) |
| Unit tests | `cd chaincode/crimerecords && npx mocha --recursive 'test/**/*.test.js'`; `cd backend && npm run test:unit`; `cd policies && npm test` | `npm ci` | < 1 min each (ran: 211, 184, 27) |
| Re-score Table VII | `python3 testbed/analysis/accuracy.py --out <dir>` | Python 3 with matplotlib; untracked script | Minutes |
| Baseline inference | `experiments/runs/20260912_dias_qwen3_baseline/run-baseline.sh` | MLX-LM server serving the base model on :8081 | About 6 h |
| V7 inference | `scripts/dias/evaluate-v7.sh` | V7 weights (not in the repository); MLX | About 5.6 h (V7 `evaluation.log`: 04:41→10:19 UTC) |
| Train V7 | `nohup scripts/dias/train-v7.sh experiments/dias-finetuning/train-v7.yaml experiments/runs/<date>_dias_qwen3_lora_v7 &` | Apple silicon with 64 GB; `.venv-qwen-policy`; **the V6 adapter file at the hard-coded path** | About 19 h |
| Testbed E3–E7 | `testbed/README.md` build steps, then `testbed/scripts/start_e6.sh`, `run_remaining.sh`, `finalize.sh` | Four Lima VMs, Docker Swarm, `~/dias-testbed`, **the missing `prepare-chaincode.sh`** | Several hours (E6 alone 1 h; E7 about 13 min) |
| Reuse run | `testbed/scripts/start_reuse.sh`, then `finalize_reuse.sh` | Testbed as above | About 4.2 h (`RESULTS.md`) |

---

## 11. Potentially unnecessary or obsolete files

Nothing was moved or deleted during this audit.

| Path | Apparent purpose | Evidence it is unused/obsolete | Publication risk | Recommendation | Confidence |
|---|---|---|---|---|---|
| `backend/src/llm/` (7 files) | SEAL-era LLM decision engine | Not imported by `backend/src/server.js` or any runtime module; `backend/test/architectureGuard.unit.test.js` asserts it is unreachable | Medium (reviewers see `policyVersion` and attestation code that the paper does not use) | Move to a future `trashy/` review | High |
| `chaincode/crimerecords/lib/policy/{policyEngine,controlledDecision,llmDecisionProtocol,dynamicPolicy,reasonDecisions}.js`, `chaincode/crimerecords/test/legacy/` | SEAL-era rule engine | Excluded by `network/scripts/deployCC.sh:38-40`; architecture guard | Medium | Document as offline history, or archive — requires human decision | High |
| `experiments/runs/20260915_dias_backend_llm/before/` (187 files) | Pre-redesign code snapshot | A second copy of backend, chaincode, frontend, network and scripts | Medium–High | Archive separately | High |
| `LLMxAI/` (219 files) | SEAL-era LLM-only runtime and datasets | Its README says it has no blockchain; DIAS needs only the V7 `adapter_config.json` and `requirements.txt` from it | High | Archive separately; keep only what V7 needs | Medium |
| `solidity-frontend/` | EVM demonstration | Standalone per its README | Medium | Archive separately | High |
| `benchmarks/caliper/`, `experiments/runs/2026-08-24T*_caliper_*` | SEAL-era Caliper benchmarks | README: "has not been retargeted to DIAS" | Medium | Archive separately | High |
| `paper-tests/`, `paper experiment results/` | SEAL paper experiments | README: "SEAL paper experiments" | Medium | Archive separately | High |
| `experiments/runs/20260912_dias_scope_ablation/`, `experiments/runs/20260916_dias_scope_workload_sweep/`, `results/tables/dias_scope_ablation.csv`, `dias_scope_workload_sweep.csv`, `dias_fingerprint_ablation.csv` | Offline reuse replay | Superseded by `experiments/runs/20260925_reuse_100_users/` (whose `RESULTS.md` explains the old flaw) | **High** — the abstract's 23.75% came from here | Keep, labelled SUPERSEDED | High |
| `results/tables/dias_concurrent_users.csv` | Earlier single-host latency test | Superseded by E5 | Medium | Keep, labelled superseded | High |
| `experiments/runs/20260924_testbed_multivm/raw/{e5-…,e6-…,e7-…}/backend-trace.jsonl` | Copies of one cumulative trace | Byte-identical to `raw/backend-trace.jsonl` (same MD5) | Low (16 MB redundant) | Keep one copy and document the filtering | High |
| `experiments/cross-dataset/orgaccess/{easy,medium,hard}.jsonl` (83 MB) | Raw third-party dataset | Only the derived binary and partial subsets are used | Medium (size; MIT attribution) | Add to `.gitignore`; provide a download script with a pinned revision | High |
| `experiments/runs/20260924_testbed_multivm/raw/e3-ledger-20260925T043602Z/transactions.jsonl` (73 MB) | Raw E3 transactions | Needed for provenance | Medium (size) | Keep through a release archive or Git LFS — requires human decision | Medium |
| `papers/reference_library/` (42 PDFs), `reports/research/**/*.pdf` (7), `LLMxAI/2511.20284v2.pdf` | Third-party papers | Reading material, not code or evidence | High (copyright) | Add to `.gitignore` and remove from the public tree — requires human decision | High |
| `outputs/20260917_google_sheets_experiments/` | Older graph workbook | Not referenced by the current evidence chain (not verified further) | Low–Medium | Requires human decision | Low |
| `_figpreview.svg`, `test-refs.bib`, `SNAPSHOT.md` | Leftovers | `test-refs.bib` holds a single placeholder entry; `SNAPSHOT.md` embeds absolute paths | Low | Requires human decision | Medium |
| `docs/ai-as-network-participant.md`, `docs/llm-on-chain-challenges.md`, `docs/related-work-llm-on-chain.md` | Retired design | Labelled "Historical design (retired 2026-09-15)" | Low | Keep (already labelled) | High |
| `network/` AI organization and `crimechannel` profile | SEAL-era channel | DIAS uses `diaschannel`; `make up` still builds both | Medium | Document, or refactor — requires human decision | Medium |

---

## 12. Public-release risks

### 12.1 Secrets and credentials

- **No live secrets found.** Tracked and untracked (not ignored) files were scanned for:
  - PEM private keys;
  - Hugging Face, OpenAI-style, GitHub and AWS tokens;
  - JWT secrets.
- `.env` is git-ignored and was never committed. Its `JWT_SECRET` is a placeholder.
- `backend/src/config.js:15` has a development fallback JWT secret. It is refused when `NODE_ENV=production`.
- **Demo credentials** are present (values not reproduced here):
  - Fabric CA bootstrap `admin`-style credentials in `network/compose/compose-ca.yaml`, `network/compose/compose-net.yaml` and `network/scripts/registerEnroll.sh` (tracked);
  - the same in `testbed/compose/*.json` and `testbed/scripts/enroll-orgs.sh` (untracked);
  - an enrolment secret in `testbed/scripts/register-users.sh:18` (untracked).
- These are local-demo defaults, but they should be labelled as such.
- Fabric key material (406 files under `network/organizations/`) and `backend/data/` are git-ignored.

### 12.2 Personal or sensitive data

- All domain data is synthetic.
- No student ID or e-mail address was found in text files.
- `CITATION.cff` contains the author's name, as expected.
- Binary documents (for example the git-ignored `.docx` reports) were not scanned.

### 12.3 Large files

- **Tracked:**
  - `data-v2-binary/train.jsonl` 44 MB;
  - subsets 27, 13 and 6.7 MB;
  - `LLMxAI` datasets 22, 15 and 8.9 MB;
  - `data-v1` 15 MB;
  - several PDFs of 5–7 MB.
- **Untracked (244 MB total):**
  - E3 transactions 73 MB;
  - OrgAccess raw 83 MB;
  - container statistics 21 MB;
  - reuse trace 12 MB.

### 12.4 Licensing

- The repository is Apache-2.0.
- 50 third-party paper PDFs are tracked. Their redistribution rights were not verified.
- OrgAccess is MIT-licensed; attribution is needed if the raw data is published.
- The LLMAC set is a reconstruction from a published paper's policy table. Its provenance is documented in `COMPARISON.md` and should also be stated in the repository.
- Check the base model's licence before publishing adapters.

### 12.5 Missing dataset licences

- The synthetic DIAS dataset has no data statement or licence file.
- `experiments/cross-dataset/orgaccess/` has no licence notice.

### 12.6 Absolute local paths

- 235 tracked files and 18 untracked files contain `/Users/venkatrayudu/...`.
  - Tracked: 176 under `experiments/`, 43 under `LLMxAI/`, and the rest in `results/`, `paper-tests/`, `reports/`, `scripts/`, `SNAPSHOT.md` and `paper experiment results/`.
- Examples:
  - `adapter_config.json` (`config` field);
  - `experiments/runs/20260913_dias_qwen3_lora_v7_full/run.json`;
  - the V7 `evaluation.log`;
  - `scripts/dias/train-v7.sh` (V6 adapter path);
  - `SNAPSHOT.md`.

### 12.7 Broken commands

- `scripts/dias/train-v7.sh` fails on a clean checkout (V6 dependency).
- `testbed/scripts/deploy-cc.sh` depends on the missing `prepare-chaincode.sh`.
- `make all` needs `../fabric-samples`.
- The README's instruction to use Ollama for baselines is stale.

### 12.8 Missing dependency locks

- The Python analysis and cross-dataset scripts are not pinned.
- MLX is pinned only in `LLMxAI/experiments/llm_policy_engine/requirements.txt`.

### 12.9 Reviewer-confusing files

- Legacy SEAL-era folders (see §11).
- Two channels, one with an AI organization.
- A README describing the older HEAD contract.
- A duplicate code snapshot.
- Superseded replay experiments whose numbers still appear in the abstract.

### 12.10 Unsupported publication or performance claims

- "securely … with confidentiality" (p5).
- "up to 23.75%" (p1).
- "60.27%" (p5).
- The §IV mechanisms (κ, v_P, h_J / h_M / h_N, note commitment).
- The C3 counterfactual explanation.
- Table I "Yes" ratings for DIAS that silently assume an honest backend.

### 12.11 Manuscript state

- The PDF opens with Section I "Review Comments" (44 items).
- It has no Conclusion.
- Its file name uses the old project name "SEAL".

---

## 13. Prioritized remediation plan

Nothing below has been done. Items marked "researcher decision" change the design or the paper's claims and belong to the author.

### P0 — blocks truthful release

1. **Resolve the Methodology vs implementation contradiction (C-01 to C-05, C-14). Researcher decision.**
   - Option A — implement:
     - a pre-review commitment transaction and the matching check in `SubmitAuditorDecision` (`chaincode/crimerecords/lib/accessContract.js`);
     - `policyVersion` in the request and in `createAuthorization` and `matchAuthorization` (`chaincode/crimerecords/lib/dias/authorization.js`);
     - hash submission and note ordering (`backend/src/routes/access.js`, `backend/src/dias/recommendationWorker.js`);
     - the auditor-side hash check (`frontend/js/modules/auditor-review.js`);
     - tests for each rejection path.
   - Option B — rewrite:
     - rewrite §IV, Algorithm 1, Table II, Fig. 2 and §IV-A so they describe the implemented design;
     - move κ, v_P, h_J, h_M and h_N to future work (§VII already lists κ and v_P).
   - Evidence to close: either unit tests plus a live run, or a manuscript whose §IV matches `accessContract.js` line by line.
2. **Commit and tag the evaluated code and evidence.**
   - Commit the 28 modified files and the 4 untracked backend files.
   - Commit `testbed/`.
   - Commit `experiments/cross-dataset/` without the raw OrgAccess splits.
   - Commit the evidence under `experiments/runs/20260924_*` and `20260925_*`, choosing a size policy for the 73 MB raw file.
   - Commit the untracked `results/tables/dias_testbed_*` files and `results/plots/dias-testbed/`.
   - Commit `reports/iteration/iter_054_*`.
   - Bump `Makefile:28` to 2.3.
   - Update the README sections on agreement, the recommendation on the ledger, the orderers and the testbed.
   - Evidence to close: a tagged commit whose tree reproduces the staged chaincode and backend sources (the same `diff -r` I ran), plus a new manifest that points to that commit.
3. **Fix the abstract's "up to 23.75%" to 21%** (Table VIII). Evidence: `experiments/runs/20260925_reuse_100_users/analysis/RESULTS.md`.
4. **Fix the introduction's "60.27%".** Use 56.0%, or define "balanced accuracy over usable answers" and use one convention in both places. Evidence: `metrics.js:11-14`; `results/tables/dias_testbed_accuracy.csv`.
5. **Rewrite the fault-test sentence and the Table XIII note.** Optionally make `testbed/analysis/analyze_e7.py:71` group by failure time and regenerate. Evidence: the `raw/e7-fault-20260925T043602Z` trace and timeline.
6. **Remove Section I "Review Comments"** from the manuscript. Add a Conclusion if the venue requires one. Use one title and acronym everywhere (C-13).
7. **Narrow the confidentiality claim** (p5) and **name the backend as part of the trusted base** in §IV-A.

### P1 — blocks reproducibility

1. Publish the V7 adapter (sha256 `348f4ca5…`) as a release asset, or document how to obtain it.
2. Make the V6-adapter preflight in `scripts/dias/train-v7.sh` optional, so training runs from a clean checkout.
3. Add `testbed/scripts/prepare-chaincode.sh`, including how `SOURCE_SHA256` is computed. Add the Lima VM definitions under `testbed/vm/`.
4. Record the full diff, or the commit, that the manifest's `tracked_diff_sha256` refers to.
5. Add scripts and data for Figs. 8–12, or replace those figures with the `testbed/analysis` outputs. Commit `v7_validation_loss.py` and `resource_grid.py` together with their input CSVs.
6. Pin the Python dependencies for `testbed/analysis/` and `experiments/cross-dataset/`.
7. Store the token-audit output for the "2,150 tokens" claim.
8. Add a `REPRODUCE.md` covering every experiment, with prerequisites and runtimes (see §10.11).

### P2 — paper/code inconsistency

1. Re-check the grant basis in `AuthorizeRequestedDocumentRead` (`recordContract.js:526-551`), or narrow §IV-G.
2. Either store the auditor note before submitting the decision (`routes/access.js:289-305`), or change §IV-E.
3. Correct §IV-C: C excludes identity and record ID (`verifiedRequest.js:10-11`).
4. Fig. 13(e) and (j): add GPU utilisation and GPU memory for the model node, or caption the RSS limitation (`resource_grid.py:83`; `mac-samples.csv`). Discuss the figure in the text.
5. Fig. 3 text: change "0.002–0.007" to "0.002–0.008".
6. Report the 115-example overlap between the adversarial and balanced sets. Define balanced accuracy, reason accuracy and exact-reference accuracy, including order-sensitivity.
7. Describe the reuse-experiment design:
   - random approvals with p = 0.5;
   - a scripted auditor;
   - the fingerprint fields (`analyze_reuse.py:56-69`);
   - 72 authorizations created;
   - one lost model call.
8. Explain the E3 coupling between W1 and W2 and the R2 client deadline. State the E5 workload source. Disclose the background `wt-dias` load.
9. Report the ablations and the seed pilot, or justify leaving them out (`AGENTS.md`).
10. Remove the "complete-request examples" row from Table VI, or report a result for it.
11. Narrow the C3 counterfactual wording and the §IV-B generation-status wording.
12. State that every experiment used a scripted auditor, and mention the 24 reuse-run grants that followed model false ALLOWs.

### P3 — documentation and cleanup

1. Label the superseded experiments (scope sweeps, `dias_concurrent_users.csv`) as SUPERSEDED in `results/` and `reports/`.
2. Decide what to do with the legacy folders listed in §11. This requires a human decision; nothing was moved.
3. Remove third-party PDFs from the public tree and add `.gitignore` entries.
4. Replace or document the absolute paths in tracked logs and configs.
5. De-duplicate the cumulative backend trace copies.
6. After P0-2, fix the README statements (Ollama baseline, one orderer, agreement trust).
7. Add OrgAccess attribution and the LLMAC reconstruction provenance to the repository.
8. Decide on `test-refs.bib`, `_figpreview.svg` and `SNAPSHOT.md`.
9. Rename the `crime-policy-v2` label in `chaincode/crimerecords/lib/policy/policyV1.js:20`, or document it.

---

## 14. Final verdict

| Dimension | Rating (0–5) | Why |
|---|---|---|
| Paper–code alignment | **2** | §V and §VI match the evaluated code: Table V transactions, Fig. 4 and Fig. 6 line numbers, the deployment, and model serving. But §IV, Algorithm 1, Table II and Fig. 2 describe at least six mechanisms that do not exist (κ, H(M) check, v_P, h_J, h_N, contract-required note). The public commit contradicts Fig. 6 and §V-G. |
| Experiment completeness | **3** | Present: an untuned baseline, a fine-tuned model, five held-out test groups, two external datasets, a live reuse experiment with comparison designs, component and whole-system load tests on a four-VM testbed, CPU and memory monitoring, a fault test, and E5 in three repetitions. Missing from the paper: ablations (they exist in the repository), more than one training seed, any experiment with a human auditor, and repeated runs for E6 and E7. |
| Result traceability | **4** | Every number in Tables VI–XIII and Figs. 8–12 traces to a retained artifact, and every value I recomputed matched. Deductions: two headline numbers (23.75%, 60.27%) and one interpretation (the fault-test failures) are wrong; Figs. 8–12 have no generator; most evidence is untracked. |
| Reproducibility | **2** | Re-scoring and re-analysis are possible from retained files. Re-execution from a clean checkout is blocked: the evaluated code is uncommitted, the V7 weights are unpublished, training depends on an external V6 file, `prepare-chaincode.sh` is missing, the VM setup exists only as prose, and the analysis dependencies are unpinned. |
| Public-release readiness | **1** | No secrets were found and the key material is ignored. But the public commit is not the evaluated system, the manuscript draft contains internal review comments, about 50 third-party PDFs are tracked, 235 tracked files embed local paths, and large legacy components remain. |

## **Verdict: PARTIALLY ALIGNED**
