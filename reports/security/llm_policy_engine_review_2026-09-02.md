# LLM policy-engine security review — 2026-09-02

## Scope

Read-only Codex review of the Qwen3 policy path, followed by targeted fixes and
full local unit verification. This report is implementation evidence, not a
production security certification.

## Findings and disposition

| Severity | Finding | Disposition |
|---|---|---|
| High | The legacy deterministic API and chaincode path could grant access while the LLM path was deployed. | Fixed. `ACCESS_POLICY_MODE` exposes either `llm-only` or `legacy-baseline`, never both. `AccessContract.RequestAccess` also rejects legacy evaluation whenever an active LLM model registration exists. |
| High | Any non-empty string was treated as an emergency approval token. | Fixed for the LLM runtime. An authorized supervisory/judicial role must register a one-use SHA-256 token commitment on Fabric. The approval is bound to the governed requester enrollment, record, and a maximum 24-hour expiry. The bearer token is never stored, and an attested emergency allow consumes it. |
| Medium | Access-decision history by record was visible to every authenticated member. | Reduced. Chaincode now returns those decisions only to their requester or an oversight/approval role. |
| Medium | Record metadata remains searchable by authenticated department members. | Open, documented limitation. Raw payloads still require an identity-bound grant. A real deployment needs a separately justified metadata-discovery policy. |
| Medium | Web login is a custodial demonstration selector, not proof that the person controls the Fabric private key. | Open, documented limitation. The experiment must not describe this authentication UI as production-grade identity proof. |

## Positive controls verified

- Subject and resource attributes used by Qwen come from the authenticated
  Fabric identity and governed ledger state, not from user query claims.
- Inference fails closed on unavailable adapters, hash mismatch, malformed
  JSON, unknown fields, inconsistent decision/reason pairs, or attestation
  failure.
- Fabric rechecks the context hash, active model version, adapter hash, output
  hash, policy version, and Ed25519 signature before storing the exact model
  decision.
- `RecordLLMAccessDecision` validates provenance and structure but does not run
  the deterministic policy oracle or replace the Qwen authorization outcome.

## Verification evidence

- Backend unit suite: 38 passing.
- Chaincode suite: 101 passing.
- Chaincode coverage: 91.11% statements, 83.67% branches, 96.87% functions,
  92.10% lines.
- Production dependency audit observed no production dependency advisory in
  either backend or chaincode during the review. Development-only test tooling
  advisories remain outside the runtime threat boundary and should still be
  updated during maintenance.

## Remaining boundary

Permissioned Fabric provides governed identity context, provenance,
tamper-evident retention, and approval state. It does not prove that Qwen's
learned decision is semantically correct. Model-policy conformance therefore
remains an empirical claim bounded by the retained held-out evaluations.
