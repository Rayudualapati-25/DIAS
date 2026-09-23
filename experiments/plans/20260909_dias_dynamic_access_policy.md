# DIAS dynamic access policy implementation plan

Date: 2026-09-09

## Objective

Pivot the existing SEAL prototype into **DIAS: Dynamic and Explainable Access
Control for Blockchain-enabled Inter-organizational Data Sharing**.

The fine-tuned Qwen model remains an off-chain recommendation service. It never
grants or refuses a first-time access request. An authorized auditor makes the
final decision. When Qwen recommends `DENY` and the auditor records
`FORCE_ALLOW`, Fabric creates an exact, auditable dynamic-policy rule. A later
request matching that rule is granted without Qwen inference or auditor review.

Hyperledger Fabric remains the source of truth for requests, model
recommendations, auditor decisions, dynamic-policy changes, automatic matches,
record releases, and audit reconstruction.

## Confirmed requirements

1. Qwen is advisory and runs off-chain.
2. Every request that does not match an active dynamic rule is sent to Qwen and
   then to one authorized auditor for a final decision.
3. The auditor may force-allow or force-deny any request. There are no
   non-overridable denial reasons in the prototype.
4. A rule is created only for `LLM DENY -> auditor FORCE_ALLOW`.
5. `LLM ALLOW -> FORCE_ALLOW`, `LLM ALLOW -> FORCE_DENY`, and
   `LLM DENY -> FORCE_DENY` do not create a dynamic rule.
6. A matching active rule grants access without Qwen or auditor involvement.
7. Every stage is committed to Fabric and must be reconstructable by an
   authorized auditor.
8. The existing identity-bound metadata and off-chain PDF-sharing workflow is
   retained after a final grant.
9. The auditor interface must show the complete governed request model and the
   Qwen recommendation before presenting `FORCE ALLOW` and `FORCE DENY`.
10. Usernames and requested record identifiers are deliberately visible in the
    research ledger records, as requested. Raw case-file contents remain
    off-chain.

## Exact-match contract

The implementation will build a canonical `requestFingerprint` from governed
Fabric state. It will not use free-text similarity, embeddings, or approximate
matching.

### Subject fields

- `username` / Fabric enrollment ID
- `mspId` and organization
- `role`
- `station`
- `jurisdiction`
- `clearance`
- `credentialStatus`
- case-assignment value relevant to the requested record

### Request fields

- `action`
- `purpose`

The natural-language justification is logged by hash and retained in the
existing private collection. It is not part of the match because equivalent
wording must not change authorization.

### Record-property fields

- `recordType`
- `sensitivityLevel`
- `jurisdiction`
- `owningAgency`
- `owningStation`
- `sealed`
- `juvenileFlag`
- `witnessFlag`
- `victimProtectionFlag`

### Working assumption requiring Step 1 approval

`recordId` and `caseId` are excluded from the reusable fingerprint. Therefore,
the same user may match a different record only when every governed subject,
request, assignment, and record-property field above is identical. The new
request's record ID is still written into its own request, decision, and audit
events.

The canonical object will be serialized deterministically and hashed with
SHA-256. Chaincode will compare the hash and retain the complete canonical
object for human audit. A change to any included attribute produces a miss and
returns the request to Qwen and the auditor.

## Ledger state model

### Access request

Extend the current `accessRequest` asset with:

- visible `requesterUsername`;
- canonical request fingerprint and fingerprint hash;
- `processingPath`: `dynamic-policy` or `llm-auditor`;
- lifecycle status covering request creation, model recommendation, auditor
  review, and final resolution;
- the final decision reference.

### LLM recommendation

Retain the registered-model, adapter, context, output, and attestation evidence,
but store the result explicitly as an advisory `llmRecommendation`. Recording
it must never create a grant or final denial. Every valid recommendation becomes
pending auditor review.

### Auditor decision

Record a separate final decision containing:

- `FORCE_ALLOW` or `FORCE_DENY`;
- auditor username, role, MSP, identity hash, timestamp, note, and transaction;
- referenced request and LLM recommendation;
- whether a dynamic rule was created.

### Dynamic access rule

Create an immutable-origin, status-bearing asset containing:

- `ruleId` and `ruleVersion`;
- complete canonical fingerprint and SHA-256 fingerprint hash;
- source request, recommendation, and auditor-decision IDs;
- creating auditor identity and timestamp;
- `status`: `active` or `revoked`;
- optional revocation identity, reason, timestamp, and transaction.

Only an authorized auditor may create a rule through the qualifying
`DENY -> FORCE_ALLOW` transition or revoke an active rule. A later rule with the
same fingerprint supersedes earlier state through the latest Fabric world state;
history remains available from the blockchain.

### Dynamic-policy automatic decision

On an active exact match, chaincode creates a new access request and a new final
`ALLOW` decision with:

- `decisionAuthority: dynamic-policy`;
- `llmInvoked: false`;
- `auditorRequired: false`;
- matched rule ID/version and originating override references;
- current record ID and full current fingerprint;
- timestamp and transaction ID.

The requester does not reuse an old grant. Every access attempt receives a new
identity-bound decision and a new ledger trace.

## Required Fabric lifecycle stages

- `AccessRequestCreated`
- `DynamicPolicyMatched`
- `DynamicPolicyMissed`
- `LLMRecommendationRecorded`
- `AuditorForceAllowed`
- `AuditorForceDenied`
- `DynamicPolicyRuleCreated`
- `DynamicPolicyRuleRevoked`
- `AccessDecisionFinalized`

Fabric permits only one chaincode event per transaction. A transaction that
completes multiple stages therefore emits the final event name and includes all
completed names in a bounded `lifecycleStages` array. For example, a miss emits
`AccessRequestCreated` with `DynamicPolicyMissed` in that array, while an
automatic grant emits `AccessDecisionFinalized` with `DynamicPolicyMatched` in
the array. Complete assets remain queryable in Fabric state.

## Decision matrix

| Dynamic match | LLM recommendation | Auditor decision | Final outcome | Rule change |
| --- | --- | --- | --- | --- |
| Active exact match | Not invoked | Not required | `ALLOW` | none |
| Miss | `ALLOW` | `FORCE_ALLOW` | `ALLOW` | none |
| Miss | `ALLOW` | `FORCE_DENY` | `DENY` | none |
| Miss | `DENY` | `FORCE_DENY` | `DENY` | none |
| Miss | `DENY` | `FORCE_ALLOW` | `ALLOW` | create active exact rule |
| Miss | `ESCALATE` | `FORCE_ALLOW` | `ALLOW` | none |
| Miss | `ESCALATE` | `FORCE_DENY` | `DENY` | none |

`ESCALATE` is retained for compatibility with the current Qwen vocabulary, but
it is advisory and does not mint a rule. If the model is later constrained to
binary recommendations, these two rows can be removed without changing the
dynamic-policy contract.

## Implementation steps and review gates

### Step 1 — Architecture and implementation contract

- Freeze this plan and its assumptions.
- Record the repository reuse/gap analysis.
- Make no runtime behavior changes.

Acceptance: the user confirms the fingerprint scope, decision matrix, and
implementation sequence.

### Step 2 — Chaincode dynamic-policy core, test first

- Add failing unit tests for fingerprint stability and mismatch behavior.
- Add the dynamic-rule schema/factory, exact lookup, query, and revocation.
- Change request creation so an active match writes a fresh automatic grant and
  does not emit work for the AI listener.
- Add unit tests for authorization, rule provenance, history, and all match
  fields.

Acceptance: chaincode unit tests prove hit, miss, changed-user attribute,
changed-record property, invalid rule provenance, unauthorized
query/revocation, and latest-state behavior. There is deliberately no standalone
rule-creation transaction; Step 3 connects the factory only to the qualifying
auditor decision so callers cannot create rules out of workflow.

### Step 3 — Advisory LLM and auditor-final chaincode flow

- Convert submitted Qwen results into non-final recommendations.
- Put every valid recommendation into the auditor queue.
- Replace escalation-only resolution with explicit force-allow/force-deny.
- Mint a rule only for the qualifying denial override.
- Preserve model attestation, policy comparison, and structured explanation as
  evidence without allowing them to finalize authorization.

Acceptance: tests cover the full decision matrix and prove that Qwen cannot
grant or deny access.

### Step 4 — Backend integration

- Return an immediate decision for dynamic-policy hits.
- Wait for a recommendation, then return a pending-auditor response on misses.
- Expose pending recommendations, force decisions, active rules, rule history,
  and revocation through validated routes.
- Make the AI listener ignore requests already finalized by dynamic policy.

Acceptance: backend unit tests cover both paths and reject unauthorized auditor
operations.

### Step 5 — Requester and auditor interfaces

- Show `dynamic policy -> LLM -> auditor` progress on the requester screen.
- Build the auditor decision view/modal with the complete subject, request,
  record, Qwen recommendation, explanation, and provenance.
- Provide `FORCE ALLOW` and `FORCE DENY` actions.
- Clearly label automatic grants as `LLM skipped: active dynamic policy match`.
- Add an auditor view of active/revoked dynamic rules.

Acceptance: frontend tests plus desktop/mobile verification of first-time allow,
first-time deny, force-allowed denial, and automatic replay.

### Step 6 — Data-sharing and audit reconstruction

- Ensure only final `ALLOW` decisions, including dynamic matches, unlock record
  metadata and the existing PDF workflow.
- Extend the audit trail and access log with recommendation, force-decision,
  rule-change, match, and LLM-skipped evidence.
- Display usernames and record IDs as required.

Acceptance: a force-allowed requester can obtain metadata/PDF; another identity
cannot reuse the decision; an auditor can reconstruct every stage.

### Step 7 — Deterministic synthetic scenarios and required comparisons

- Retain the existing Qwen training data and generator unchanged.
- Add a separate workflow dataset for auditor outcomes and repeated requests.
- Include exact repeats and one-field near misses for every fingerprint field.
- Run the repository-required baseline, proposed path, and ablations after the
  functional system is complete.

Minimum comparison:

- baseline: LLM invoked for every request, no learned dynamic rule;
- proposed: audited dynamic rule and exact-match bypass;
- ablation A: rule creation disabled;
- ablation B: dynamic lookup disabled;
- ablation C: remove one fingerprint dimension at a time in offline replay only.

Acceptance: deterministic seeds, configs, logs, metrics, and tables are retained
under the repository-required artifact directories. No result is claimed before
the runs exist.

### Step 8 — Live Fabric acceptance and documentation

- Deploy to a clean six-organization local Fabric network.
- Demonstrate miss -> Qwen DENY -> FORCE_ALLOW -> rule creation -> matching
  second request -> automatic grant without Qwen/auditor.
- Demonstrate a near miss returning to Qwen and the auditor.
- Demonstrate force-deny without rule creation and rule revocation.
- Update architecture, walkthrough, iteration report, and only evidence-backed
  paper material.

Acceptance: all automated suites pass, the live trace is retained, and known
limitations are recorded.

## Smallest functional vertical slice

The first runnable milestone spans Steps 2–6 and supports one deterministic
scenario:

1. `const.verma` requests a medium, unsealed FIR for investigation.
2. No dynamic rule exists, so Qwen recommends `DENY / NOT_ASSIGNED`.
3. The auditor force-allows the request.
4. Fabric creates the exact dynamic rule and grants the first request.
5. The same user requests another record with the same governed properties.
6. Fabric creates a fresh automatic grant without emitting an LLM work event.
7. Changing one property, such as sensitivity, causes a miss and auditor review.

The concrete scenario is provisional until the workflow data is implemented;
no result is claimed by this plan.

## Risks and controls

- **Over-broad reuse:** exact canonical fields and one-field near-miss tests.
- **Stale authority:** current Fabric attributes are recomputed for every
  request, and an attribute change causes a miss.
- **Auditor mistake or abuse:** full visible provenance, attributed decisions,
  and revocable rules; the prototype still treats the auditor as authoritative.
- **Concurrent duplicate overrides:** deterministic composite keys and Fabric
  endorsement/MVCC behavior.
- **Listener race:** a dynamic hit is finalized in the request transaction and
  does not emit `AccessRequestCreated` for Qwen.
- **Approximate matching:** prohibited from the authorization path.
- **Model disagreement:** retained as evidence for the auditor, never as final
  authority.
- **Sensitive raw content:** remains in the existing agency vault; Fabric holds
  metadata, hashes, and governance events.

## Evidence discipline

Each subsequent step must update `reports/iteration/`, retain meaningful run
records under `experiments/runs/`, and place comparison artifacts under
`results/`. Negative results and incomplete checks must be reported explicitly.
Paper claims remain out of scope until the corresponding evidence exists.

## Execution status — 2026-09-10

- [x] Step 1 — architecture and implementation contract
- [x] Step 2 — chaincode dynamic-policy core
- [x] Step 3 — advisory Qwen and auditor-final chaincode flow
- [x] Step 4 — backend integration
- [x] Step 5 — requester and auditor interfaces
- [x] Step 6 — data-sharing and audit reconstruction
- [x] Step 7 — deterministic baseline, proposed comparison, and ablations
- [x] Step 8 — clean-network live acceptance, regression checks, and documentation

Completion evidence is consolidated in
`experiments/runs/20260910_dias_full_verification/verification.json` and
`reports/iteration/iter_032_dias_full_implementation.md`. The two failed live
attempts are retained beside the passing trace rather than discarded.
