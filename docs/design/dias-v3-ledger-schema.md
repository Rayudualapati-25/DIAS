# DIAS v3 — design and ledger schema

- **Status:** frozen for implementation on 2026-10-01 (plan step 2). Changes after this date are listed in the change log at the end.
- **Scope:** the access-request workflow of `diasrecords` 3.0, the backend that drives it and asks the LLM, and the browser screens that display its results.
- **Approval:** the author approved the plan's design defaults and asked for the steps to run without stopping for approval (`experiments/plans/20261001_integrity_v3_plan.md`). Every choice that goes beyond those defaults is marked **[D-nn]** with its reason, so it can be reviewed later.
- **Target design:** the Methodology section of the paper (§IV, Algorithm 1, Table II). Where the code and the paper disagree, this document says which one changes, and why.

## 1. What changes from v2

| Area | v2 (tag `eval-baseline-2026-10-01`) | v3 |
|---|---|---|
| Recommendation on the ledger | Value supplied by the backend together with the auditor decision | Signed pre-review commitment κ, accepted before review |
| Agreement | Derived from the value the backend supplies at decision time | Derived from κ; the decision transaction takes no recommendation value |
| Policy version | Not stored | `policyVersion` and `policyHash` bound to request, κ, decision, authorization and outcome; activation is governed on the ledger |
| Off-chain objects | Not committed | `h_J`, `h_M`, `h_N` committed; canonical, domain-separated SHA-256 |
| Auditor note | Required by the backend only; written after the commit | Staged off-chain first; its hash is required by the contract for NOT_AGREED and NO_RECOMMENDATION |
| Generation status on the ledger | Collapsed to UNAVAILABLE | All five statuses |
| Requester flags | `emergencyFlag` and a constant `approvalTokenPresent` inside the "verified" request | Verified facts and requester claims are separate objects; `approvalTokenPresent` is removed |
| Auditor check | Certificate MSP and role | Certificate plus active ledger profile, district (jurisdiction) and clearance |
| Final document download | Requester identity and status only | Full grant re-check: identity, credential, grant basis, authorization lifecycle and scope, policy binding |
| Pending requests | Never expire | Configurable review deadline; explicit EXPIRED and CANCELLED outcomes |
| Decision log | Full details for every channel identity | Full for reviewers; redacted for others |
| Record history, evidence list, custody | No caller checks | Restricted to the owning station, the record's district, and reviewers |
| Off-chain review store | Plain JSON files | Authenticated encryption (AES-256-GCM), key outside Git |
| Access log | One ledger write after every authenticated API call | Defined logging policy: sensitive reads, and failures of state-changing calls |
| Explanations | Structured part public; free text for requester and auditors | Existing LLM structured part and written reason according to the visibility rules; full object for auditors |
| Counterfactuals | None | Withdrawn by the author on 2026-10-08; existing LLM account only |

## 2. Roles and trust

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Requester | Nothing beyond their signed request | Justification content, emergency claim |
| LLM | Nothing | Any decision; its output is advisory and checked only for format |
| Backend | Holding user keys, the recommendation signing key, the review store key and the Fabric connection; running the configured model on the committed inputs, and signing and committing what it produced (prototype limitation) | Correctness of the recommendation; changing a recommendation after it is committed; choosing the agreement value or the active policy |
| Auditor (AuditMSP district head) | The binding decision for requests in their district | — |
| Fabric MSPs, CAs, endorsement policy | Identity and agreement on contract execution | Correctness of the LLM |
| Record owner | Storing protected content and checking its hash before delivery | — |

The backend remains part of the trusted base, because it holds every demonstration private key: a compromised backend can still sign transactions as any user, including an auditor. Since 2026-10-08 the backend also asks the LLM itself and holds the recommendation signing key (author's decision: there is no separate recommendation service). A compromised backend could therefore commit a recommendation the model did not produce. What v3 still removes is the backend's ability to *change* a recommendation after κ is committed, to *choose* the agreement, or to *choose* the policy unnoticed. It does not remove its ability to impersonate users. Removing the remaining trust needs user-held keys and a signing key held outside the backend, which are outside this revision.

## 3. On-chain and off-chain data

| Object | Location | Contents |
|---|---|---|
| Verified context C | Ledger (request) | Requester facts from the certificate and ledger profile; record facts; action and purpose. Not identity or record identifiers [D-01]. |
| Requester claims K | Ledger (request) | `emergencyDeclared` (self-declared, unverified) |
| Justification J | Off-chain (encrypted) | Requester's text; `h_J` on the ledger |
| Recommendation object M | Off-chain (encrypted) | Recommendation, status, normalized model output or error, provenance; `h_M` on the ledger |
| Commitment κ | Ledger | See §6 |
| Auditor note N | Off-chain (encrypted) | Auditor's text; `h_N` on the ledger |
| Decision, outcome, authorization | Ledger | See §7–§9 |
| Protected record content | Owning agency vault | Content hash on the ledger |

[D-01] The paper (§IV-C) lists the stable identity and record identifier inside C. The code keeps them out of C because they are not policy facts, and binds them instead through the request record and the exact scope σ, which κ and α reference. The security property (an approval cannot reach another user or record) holds either way, so the manuscript wording changes, not the code. Recorded in `reports/v3_methodology_reconciliation.md`.

## 4. Hashing and canonical serialization (`dias-commitment-hash-v1`)

- **Algorithm:** SHA-256. Output: 64 lowercase hexadecimal characters. Any other digest form is rejected.
- **Domain separation:** the hashed bytes are `UTF-8("DIAS/v3/" + domain) || 0x00 || content`. Domains: `context`, `claims`, `justification`, `recommendation`, `note`, `policy`. The same text therefore never yields the same digest as a justification and as a note.
- **Structured content** (C, K, M, the policy bundle): UTF-8 bytes of canonical JSON. The rules follow RFC 8785 for the value types DIAS uses:
  - object keys sorted by UTF-16 code units, no whitespace;
  - strings escaped exactly as ECMAScript `JSON.stringify` escapes them;
  - allowed values: `null`, booleans, safe integers, strings, arrays, plain objects;
  - rejected: non-integer or unsafe numbers, `NaN`, `Infinity`, `undefined`, functions, symbols, non-plain objects, and strings with unpaired surrogates.
- **Text content** (J, N): the exact string as submitted, encoded as UTF-8. No trimming and no Unicode normalization. A string with an unpaired surrogate is rejected because it has no UTF-8 encoding.
- **One implementation per language:** `chaincode/crimerecords/lib/dias/commitments.js` (contract and backend) and `frontend/js/shared/commitments.js` (browser; pure-JavaScript SHA-256, because Web Crypto is unavailable on plain-HTTP testbed origins). Both are tested against the same vectors.

## 5. Policy governance

- **Registry:** each version is stored under `diasPolicyVersion/<policyVersion>` with its `policyHash` (domain `policy` over the canonical bundle), `bundleId`, status (`registered`, `active`, `retired`), registrant and timestamps. The active pointer is `diasActivePolicy/current`.
- **Transactions** (GovernanceContract), each by an AuditMSP district head with an active ledger profile:
  - `RegisterPolicyVersion(policyVersion, policyHash, bundleId)`
  - `ActivatePolicyVersion(policyVersion)`: only a `registered` version can be activated, and only by a different district head than the one who registered it [D-02]. The previous active version becomes `retired`; a retired version is never re-activated. To roll back, register the old content under a new version identifier.
  - `GetActivePolicy()`, `QueryPolicyVersions()`
- **Effect:**
  - a request binds the active policy when it is created;
  - κ must carry the request's policy, and that policy must still be active;
  - a decision is rejected when the active policy changed after the request;
  - a reusable authorization matches only under the policy it was issued under;
  - a grant is released only while its policy is still active.
- **Not active policy:** no request can be created until a policy is active (`DIAS_NO_ACTIVE_POLICY`).

[D-02] Two-person activation is a cheap separation-of-duties control beyond the plan's defaults. It does not protect against the backend, which holds every district head's key in this prototype.

## 6. Pre-review recommendation commitment κ

- **Record:** `diasRecommendationCommitment/<requestId>`, schema `dias-recommendation-commitment-v1`.
- **Fields:**
  - `commitmentId`, `requestId`;
  - `contextHash`, `claimsHash`, `justificationHash`;
  - `policyVersion`, `policyHash`;
  - `recommendation` (ALLOW, DENY or null), `generationStatus`;
  - `modelVersion`, `recommendationHash` (`h_M`);
  - `signerKeyId`, `signature`;
  - `relayedBy`, `committedAtUtc`, `txId`.
- **Generation status:** OK, UNAVAILABLE, INVALID_OUTPUT, POLICY_CONTEXT_UNAVAILABLE or CONTEXT_OVERFLOW. `recommendation` is ALLOW or DENY exactly when the status is OK, and null otherwise.
- **Transaction:** `CommitRecommendation(requestId, commitmentJson)`. Any identity with a role attribute may relay it: its authority comes from the signature, not from the submitter. The contract checks, failing closed with no writes:
  1. the request is v3, awaiting review, and before its review deadline;
  2. the active policy equals the request's policy, and κ names that same policy;
  3. `contextHash`, `claimsHash` and `justificationHash` equal the values stored with the request;
  4. status and recommendation are consistent, digests well formed, `modelVersion` bounded;
  5. the signer key is registered and active, and the signature verifies over the payload in §6.1;
  6. no κ exists yet. An identical resubmission returns the existing κ without writing (safe retry). A different κ is rejected (`DIAS_COMMITMENT_CONFLICT`).
- **Effect:** the request records `recommendationCommitmentId`, and a `RECOMMENDATION_COMMITTED` lifecycle event is appended.

### 6.1 Signed provenance (`dias-recommendation-provenance-v1`)

- **Algorithm:** Ed25519 (RFC 8032) through Node's `crypto`, which is deterministic and needs no network access inside chaincode.
- **Signed bytes:** `UTF-8("DIAS/v3/recommendation-provenance") || 0x00 || canonicalJson(payload)`.
- **Payload fields:**
  - `schemaVersion`, `channel` (from `ctx.stub.getChannelID()`);
  - `requestId`, `contextHash`, `claimsHash`, `justificationHash`;
  - `policyVersion`, `policyHash`;
  - `recommendation`, `generationStatus`, `modelVersion`, `recommendationHash`;
  - `signerKeyId`.
- **Replay protection:** the request, context, claims, justification, policy and channel are all inside the signature. A signed object therefore cannot be replayed onto another request, policy or network.
- **Signer registry:** `diasRecommendationSigner/<keyId>`. `keyId` is the SHA-256 of the DER public key, computed by the contract from the registered PEM.
  - `RegisterRecommendationSigner(publicKeyPem, label)` and `RevokeRecommendationSigner(keyId, reason)`: AuditMSP district head with an active profile.
  - **Rotation:** register the new key, switch the backend to it, then revoke the old key. Commitments signed earlier stay valid evidence of what was committed at the time.
- **Key custody:** the backend holds the private key, in a PEM file outside Git (`DIAS_RECOMMENDER_SIGNING_KEY_FILE`). There is no separate recommendation service (author's decision, 2026-10-08): the backend asks the LLM itself as soon as a request is committed without a reusable authorization, and signs what the model returned.
  - Consequence: the signature names the key that produced a commitment and binds it to the request, policy and channel. It does not protect against the backend itself.
- **What a valid signature proves:** the holder of a registered key produced this exact M (by hash), status and binding. **It does not prove:**
  - that the recommendation is correct;
  - that an LLM generated the text;
  - that the configured model actually ran.

## 7. Auditor decision

- **Transaction:** `SubmitAuditorDecision(requestId, decision, noteHash, validUntilUtc)`. There is no recommendation or agreement parameter.
- **Auditor check (step 3):**
  - certificate: AuditMSP, a district-head role, and `credentialStatus` active;
  - ledger profile: exists, matches the certificate (user, organization, role, rank, station, jurisdiction, clearance), and is active;
  - the auditor's jurisdiction equals the record's jurisdiction [D-03];
  - the auditor's clearance covers the record's sensitivity [D-03];
  - the auditor is not the requester.
- **Request check:**
  - the request is v3 and awaiting review;
  - the review deadline has not passed (else `DIAS_REQUEST_EXPIRED`);
  - the verified context, rebuilt from current state, still hashes to `h_C`;
  - the active policy equals the request's policy (else `DIAS_STALE_POLICY`).
- **Agreement** (paper Eq. 3), from κ:
  - NO_RECOMMENDATION when there is no κ or its status is not OK;
  - AGREED when the recommendation equals the decision (ALLOW for FORCE_ALLOW, DENY for FORCE_DENY);
  - NOT_AGREED otherwise.
- **Note commitment:**
  - `noteHash` is required for NOT_AGREED and NO_RECOMMENDATION;
  - it is optional for AGREED;
  - when present, it must be a well-formed digest.
- **Authorization:** created only for FORCE_ALLOW over a committed κ with status OK and recommendation DENY. Expiry is accepted only then.
- **Writes, in one transaction:**
  - the decision (with the κ reference, `h_M`, the specific generation status, `h_N`, policy);
  - the agreement-derivation event;
  - any authorization;
  - the outcome.

[D-03] The paper requires "an auditor from the responsible oversight organization" (§IV-A). The rank-ladder module already defines a district head by jurisdiction and requires clearance for the record (`lib/policy/authority.js`). v3 applies both rules to decisions and revocations, so a district head from another district, or one without clearance, cannot decide.

## 8. Request lifecycle and expiry

| Status | Reached by | Outcome |
|---|---|---|
| `awaiting-auditor` | `CreateAccessRequest` miss | — |
| `granted` | Exact-scope match, or FORCE_ALLOW | GRANTED |
| `denied` | FORCE_DENY | DENIED |
| `expired` | `ExpirePendingRequest` after the deadline, or after a policy change | EXPIRED (basis `REVIEW_DEADLINE_PASSED` or `POLICY_VERSION_CHANGED`) |
| `cancelled` | `CancelAccessRequest` by the requester while pending | CANCELLED |

- **Deadline:** `reviewDeadlineUtc = request timestamp + pendingReviewTtlSeconds`.
  - The TTL is an on-chain parameter (`SetDiasParameters`, AuditMSP district head).
  - Default 259,200 s (72 h); allowed range 60 s to 30 days.
- **Timestamps:** all rules use the transaction timestamp (`getDateTimestamp`). There are no wall-clock calls, randomness or network requests in chaincode.
- **Atomicity:** a rejected transaction writes nothing, so a late decision cannot also mark the request expired. Instead:
  - `ExpirePendingRequest` (any member identity) records the expiry explicitly;
  - the backend calls it when the ledger reports `DIAS_REQUEST_EXPIRED` or `DIAS_STALE_POLICY`, and from a periodic sweeper.
- **Expiry during generation:** `CommitRecommendation` is rejected after the deadline; the worker records the rejection and the sweeper closes the request.
- **Expiry during review:** the decision is rejected with `DIAS_REQUEST_EXPIRED`, and the screen shows the request as expired.
- **Late decisions** after expiry or cancellation are rejected because the request is no longer awaiting review.

## 9. Reusable authorization and release

- **Authorization (`dias-dynamic-authorization-v3`)** adds `policyVersion`, `policyHash`, `recommendationCommitmentId` and `recommendationHash`.
- **Matching** requires the v3 schema and the exact scope, with the authorization:
  - active and unexpired;
  - holding the same `h_C`;
  - issued under the active policy (`POLICY_CHANGED` otherwise; the authorization's own status is not changed).
- **Lifecycle:** ACTIVE, REVOKED, EXPIRED, SUPERSEDED, as in the paper. Re-issuing under a new policy supersedes the old generation.
- **Release** (`_requireGrantedDecision` → `_requireCurrentGrantBasis`, used by metadata release, `AuthorizeRecordRead`, `CreateFullDocumentRequest` and now `AuthorizeRequestedDocumentRead`):
  - the decision belongs to the caller, is `granted`, and is for `view`;
  - the requester's ledger profile and certificate credential are both active;
  - the decision carries a policy binding equal to the active policy (stricter than the paper, which states it only for reused grants: plan default);
  - for a reused grant: the authorization is active, unexpired, issued under the active policy, and its scope equals the request's scope.
- **Content integrity:** the backend still compares the vault hash with the committed content hash before delivery.

## 10. Visibility

| Object | Own requester | Reviewer¹ | Other members |
|---|---|---|---|
| Request record (`GetRequest`) | yes | AuditMSP district heads | no |
| κ, decision, outcome (audit trail) | yes; what κ says only once an auditor has decided⁴ | yes | no |
| Decision log (`QueryAccessDecisions`) | redacted² | full | redacted² |
| Record history | — | yes | owning station only |
| Evidence list and custody | — | yes | same-district Police, Forensics, Prosecution, Court |
| J (justification) | yes | AuditMSP district heads | no |
| M recommendation value | once an auditor has decided⁴ | AuditMSP district heads | no |
| M structured part³ and written reason | only when the auditor denied the request⁴ | AuditMSP district heads | no |
| M provenance | no | AuditMSP district heads | no |
| N (auditor note) | no | AuditMSP district heads | no |

1. The reviewer set is AuditContract's: AuditMSP, CourtMSP or ProsecutionMSP identities with a district-head or seal-authority role.
2. Redacted entries keep the outcome, basis, decision, recommendation value, agreement, generation status, action, purpose, the requester's organization and the time. They drop identities, record and case identifiers, authorization identifiers and transaction identifiers.
3. The structured part is the reason code, policy references, missing evidence and review flags.
4. Author's rule, 2026-10-08: the officer who made a request reads the LLM's account according to the auditor's decision.
   - **Before a decision:** nothing from the LLM, including the recommendation value in κ. The contract returns a withheld commitment, and the backend returns an empty account.
   - **Denied:** the auditor's decision, the recommendation value, the structured part and the written reason.
   - **Allowed:** the auditor's decision and the recommendation value. The grant itself releases the case-file information; the explanation is not shown.
   - **No auditor decision** (a reused authorization, an expiry, a cancellation): nothing from the LLM.
   - The auditor's note is never shown to the requester.
5. A court or prosecution reviewer receives the check of each off-chain object against its ledger digest, without the text.

**Limits of these controls:**
- These are interface-level controls. Every channel member's peer stores every block, so an organization that reads its own peer's ledger directly sees every request record. Confidentiality against member organizations would need private data collections for those fields.
- The encrypted review store protects copies at rest and in backups. It does not protect against the backend process, which holds the key.

**Review store encryption:**
- AES-256-GCM with a random 96-bit IV per write.
- The additional authenticated data is the request identifier and schema version, so a file moved to another request fails to decrypt.
- Key: `DIAS_REVIEW_STORE_KEY` (base64, 32 bytes) with `DIAS_REVIEW_STORE_KEY_ID`. Older keys go in `DIAS_REVIEW_STORE_PREVIOUS_KEYS` (`id:key` pairs) for rotation. `scripts/dias/review-store-key.js` creates a key. The backend does not start without one.
- Entries written before encryption are still read, and are encrypted when the backend starts.
- **Losing the key loses the off-chain objects.** The ledger still holds their hashes, the recommendation value and the status.

## 11. Off-chain write protocol

- **Recommendation:**
  1. generate M;
  2. store M and the signed κ (state `signed`);
  3. submit κ (state `committed`).
  - **After a crash:** a `signed` entry is resubmitted unchanged, which is idempotent. An uncertain response is resolved by reading κ back from the ledger.
  - **Determinism:** M contains no timestamps or latencies, which are kept outside M. A regeneration with the same deterministic model output therefore has the same `h_M`.
- **Note:**
  1. validate (1–2,000 characters, not only whitespace);
  2. stage `{noteHash, text, decision}` durably;
  3. submit the decision;
  4. mark the note `committed`.
  - An uncertain response is resolved by reading the decision back from the ledger; staged notes are reconciled on start-up.
  - **No atomicity:** the ledger and the off-chain store are not updated atomically. A committed decision whose note was later lost keeps its `h_N`, which proves only that a note with that digest existed at decision time.

## 12. Access logging

- **Classes** (`DIAS_ACCESS_LOG_MODE=security`, the v3 default):
  - sensitive reads, always logged: protected metadata, document release, evidence, record history, explanations, auditor queue and review, decision log, audit trails, authorization records, record search;
  - state-changing calls with their own transaction: logged only when refused or failed, because the successful transaction is already the record;
  - routine reads (`auth.whoami`, own document list, the auditor screen's status check): not logged.
- **Auditor screen status check:** `GET /access/auditor/pending/status?ids=…` tells an open auditor screen whether the recommendations it waits for are ready. It reads only the off-chain review store and returns request ids with a yes or no, never case data. It answers only a district head of the audit organisation, and takes at most 50 request ids per call. The screen asks every 3 seconds, for at most 10 minutes, and only while it shows a recommendation as being prepared; a refused check ends the asking. The queue itself stays a sensitive, always-logged read; it is loaded again only when a recommendation became ready.
- **Comparison mode:** `DIAS_ACCESS_LOG_MODE=all` reproduces v2 (one write per authenticated call).
- **Readers:** the reviewer set (`QueryAccessEvents`).
- **Effect on measurements:** logging adds ledger writes outside the measured request latency. Throughput and resource figures from v2 runs are therefore not comparable with v3 runs.

## 13. Explanation source

- **Author decision, 2026-10-08:** use the existing LLM explanation only. The separate counterfactual layer is withdrawn.
- **Runtime:** the recommendation detail returns the existing LLM account under section 10's visibility controls. There is no hypothetical fact search, reference-oracle call, counterfactual field or policy hint panel. Auditor review loads its existing review response without a second explanation-detail request.
- **Architecture:** the reference policy oracle remains an offline labelling/evaluation tool and must not be reachable from live backend entry points. Existing ledger checks, committed recommendation integrity and auditor authority remain in place.
- **Historical evidence:** iteration 070 and `experiments/runs/20261008_counterfactuals/` preserve the removed implementation's consistency checks. They establish neither an independent support claim nor an end-to-end latency result. Removal checks are recorded in iteration 071 and `experiments/runs/20261008_counterfactual_removal/`.

## 14. Older records and versions

- **Versions:** chaincode `diasrecords` 3.0. Record schema versions:
  - request `dias-access-request-v3`;
  - verified context `dias-verified-context-v3`;
  - claims `dias-requester-claims-v1`;
  - κ `dias-recommendation-commitment-v1`;
  - decision `dias-auditor-decision-v3`;
  - outcome `dias-access-outcome-v3`;
  - authorization `dias-dynamic-authorization-v3`;
  - lifecycle `dias-lifecycle-event-v3`;
  - prompt `dias-recommendation-prompt-v2` (v1 kept for historical datasets).
- **Fresh network:** v3 is deployed on a fresh research network.
- **v2 records, if ever present:**
  - stay readable and keep their schema version;
  - are never reused, because matching requires the v3 schema;
  - can never be decided, because the decision requires a v3 request;
  - are never released, because release requires a policy binding.
  - They do not gain any v3 guarantee.

## 15. Error codes

`DIAS_NO_ACTIVE_POLICY`, `DIAS_STALE_POLICY`, `DIAS_REQUEST_EXPIRED`, `DIAS_COMMITMENT_CONFLICT`, `DIAS_COMMITMENT_MISMATCH`, `DIAS_SIGNATURE_INVALID`, `DIAS_SIGNER_INACTIVE`, `DIAS_NOTE_REQUIRED`, `DIAS_AUDITOR_INACTIVE`, `DIAS_AUDITOR_OUT_OF_DISTRICT`, `DIAS_AUDITOR_CLEARANCE`, `DIAS_LEGACY_RECORD`. The backend maps authority codes to HTTP 403, timing and state conflicts to 409, and other refusals to 422. Each error message starts with its code, so the backend can map it without parsing prose.

## Change log

- 2026-10-01 — first frozen version.
- 2026-10-01 (step 3) — separate code `DIAS_AUDITOR_CLEARANCE` for a clearance failure, and the HTTP mapping of codes.
- 2026-10-02 (step 8) — policy version identifier is `<bundleId>-<version>` (`dias-governance-policy-v1`); its v3 digest is `9c66ce9e…`. The prompt still shows the bundle's original undomained digest `796013dd…`, because the prompt text is model input. Both are functions of the same bundle.
- 2026-10-02 (step 6) — logging classes are listed per action in `backend/src/middleware/accessLogger.js` (`ACTION_CLASS`). An action without a class is treated as sensitive, and a refused or failed call of any class is logged.
- 2026-10-02 (step 10) — implementation details fixed while building κ:
  - the signing key is read from a PEM file named by `DIAS_RECOMMENDER_SIGNING_KEY_FILE` (default `backend/data/dias-recommender-signing-key.pem`, ignored by Git), not from a variable holding the key;
  - the signer registry transactions (§6.1) were built with step 10, because κ cannot be verified without them; the separate service process stays in step 12;
  - `GetAuditorReview` and `QueryPendingAuditorRequests` return `{request, commitment}`, so the review screen reads κ from the ledger;
  - the contract accepts and validates `noteHash` from step 10, but requires it only from step 11; until then the backend enforces the reason.
  - M (`dias-recommendation-object-v1`) replaces unpaired surrogates in model text with U+FFFD before hashing, because canonical JSON cannot encode them.
- 2026-10-02 (step 11) — note protocol details:
  - `GetAuditorReview` returns `{request, commitment, decision}`, so the backend can read a decision back after an uncertain submission;
  - the note is trimmed of surrounding whitespace before it is stored and hashed; the stored text is exactly the hashed text;
  - when a request has no review entry, a note-only entry is created so the note is still durable before its decision;
  - a decision whose outcome is unknown returns HTTP 503 and keeps its note staged; a decision on a request already decided returns 409 and settles the staged note;
  - start-up reconciliation reads with the backend's own identity (`AUTH_ORG`/`AUTH_USER`, an AuditMSP district head by default), the same identity as the expiry sweeper.
- 2026-10-08 (step 12, changed by the author) — the recommendation runs inside the backend; the separate recommendation service process is dropped:
  - the backend asks the LLM as soon as a request is committed without a reusable authorization, signs the result with the recommendation key it holds, and commits κ. A request granted by a reusable authorization never reaches the LLM;
  - `backend/src/recommender-service/` is removed and its code is `backend/src/dias/signedRecommendation.js`. The contract, the signer registry and κ are unchanged, so nothing is redeployed;
  - consequence for the trust model (§2, §6.1): the signature no longer protects against a compromised backend. A recommendation still cannot be changed after κ is committed, and the contract still derives the agreement;
  - the auditor screen checks by itself whether a recommendation it waits for is ready (§12). The check is a routine read and writes nothing to the ledger;
  - the "Access log" screen lists, for every settled request, who requested what, what the LLM recommended, and what the auditor decided together with that recommendation. It reads the existing decision records; what is written to the ledger is unchanged.
- 2026-10-08 (step 13) — privacy controls built as §10 describes, with one change by the author and three details:
  - **changed by the author:** the officer who made a request reads the LLM's account according to the auditor's decision (§10, note 4). The frozen table gave the requester the structured part at any time and never the written reason;
  - the contract withholds κ's content from the requester until an auditor decision exists, in `GetRecommendationCommitment` and in the request audit trail (commitment, summary and lifecycle event);
  - the off-chain text in a reviewer's trail is for AuditMSP district heads only; court and prosecution reviewers receive the verification statuses (§10, note 5);
  - the redacted decision-log entry carries `redacted: true`, and full entries now carry `generationStatus`.
- 2026-10-08 (step 13, after the security review) — the requester rule comes first:
  - whoever made a request is its requester before any reviewer or auditor right applies. The request trail reports `isRequester`, withholds κ's content until an auditor decision exists, and never carries the note digest `h_N` for the requester;
  - a district head is refused `GetAuditorReview` for their own request, and `QueryPendingAuditorRequests` leaves it out;
  - `GetEvidenceDetail` follows the evidence rule of §10 (reviewers and same-district members);
  - a station or district member needs an active certificate credential for record history and evidence;
  - the review store accepts only encrypted entries once it has a key, re-seals entries of an earlier key at start-up, and requires the full 16-byte authentication tag.
