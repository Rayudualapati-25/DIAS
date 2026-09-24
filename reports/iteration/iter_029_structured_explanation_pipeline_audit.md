# Iteration 029: Structured-explanation pipeline audit

Date: 2026-09-06

## 1. Final status

The active SEAL LLM path now produces a controlled structured explanation consistent with every effective `allow`, `deny`, and `escalate` reason in the active vocabulary. Chaincode version 3.7, sequence 9, is committed by all six organizations. A real three-scenario Qwen/Fabric run passed with ALLOW, DENY, and AuditMSP-reviewed ESCALATE.

Final answer: **YES, WITH LIMITATIONS**. These are deterministic policy-path explanations, not causal explanations of Qwen's neural computation. Old ledger records keep their original schemas, and malformed model output remains pending rather than becoming an authorization outcome.

Primary evidence: `experiments/runs/20260906_seal_structured_explanation_final/final-e2e.json`. The read-only post-run network, registration, and service snapshot is `experiments/runs/20260906_seal_structured_explanation_final/live-state-verification.json`.

## 2. Current active explanation pipeline

| File | Function or symbol | Role | Status |
| --- | --- | --- | --- |
| `frontend/js/modules/search-records.js` | detail request handlers | Invokes LLM-assisted access from the interface. | Active |
| `backend/src/routes/access.js` | `POST /llm-request` | Validates canonical action/purpose and sends the query as transient data. | Active |
| `chaincode/crimerecords/lib/accessContract.js` | `CreateAccessRequest` | Commits query/context hashes, privately stores query, emits request event. | Active |
| `backend/src/ai/decisionService.js` | `run`, `decideOneRequest` | AIOrg listener reads ledger context, calls Qwen, signs, and submits. | Active |
| `backend/src/llm/groundedPolicyPrompt.js` | `groundedSystemPrompt` | Adds ordered policy and role-specific RBAC facts. | Active |
| `backend/src/llm/policyPrompt.js` | `buildUserPrompt` | Separates trusted blocks from untrusted intent; defines compact output. | Active |
| `backend/src/llm/policyDecision.js` | `decide`, `validateClassification` | Calls Qwen and rejects malformed, extra, unknown, or inconsistent fields. | Active |
| `chaincode/crimerecords/lib/policy/policyEngine.js` | `evaluate` | Independently evaluates canonical inputs and governed state. | Active |
| `chaincode/crimerecords/lib/policy/reasonDecisions.js` | `REASON_DECISION` | Controlled reason-to-decision map. | Active |
| `chaincode/crimerecords/lib/policy/controlledDecision.js` | `deriveEffectiveClassification` | Retains exact agreement; turns input/policy conflict into ESCALATE. | Active |
| same | `materializeDecision`, `REASON_DETAILS` | Creates effective reason, attributes, counterfactual, and sentence. | Active source of truth |
| `backend/src/llm/policyAttestation.js` | `signAttestation` | Ed25519-signs hashes, complete decision, and inference. | Active |
| `chaincode/crimerecords/lib/policy/llmDecisionProtocol.js` | `validateInference`, `verifyAttestation` | Re-derives the result/explanation, checks hashes/schema/registration/signature. | Active |
| `chaincode/crimerecords/lib/accessContract.js` | `SubmitLLMDecision` | Rebuilds context, validates, and commits decision/explanation/state. | Active |
| `chaincode/crimerecords/lib/auditContract.js` | `VerifyExplanation` | Compares a supplied explanation's canonical hash with ledger commitment. | Active audit operation |
| `backend/src/llm/explain.js`, `template.js` | optional UI renderer | May render later prose; cannot change authorization and is not the signed artifact. | Optional presentation |
| `AccessContract.RequestAccess` | legacy deterministic route | Disabled while an LLM model is active. | Legacy in this deployment |

Flow: `private query + canonical request -> trusted snapshot/hash -> Qwen compact classification -> strict validation -> independent policy evaluation -> effective decision/reason -> deterministic explanation -> output hash + Ed25519 -> Fabric re-derivation/signature verification -> ledger state -> human review when required`.

## 3. Exact schemas and source of truth

Qwen may return exactly:

```json
{"action":"view|export|annotate","purpose":"string","decision":"allow|deny|escalate","reasonCode":"model-allowed controlled reason","policyVersion":"crime-policy-v2","modelVersion":"qwen3-14b-seba-lora-v6"}
```

The signed `decision` object is:

```json
{
  "decision":"allow|deny|escalate",
  "reasonCode":"controlled effective reason",
  "parsedRequest":{"action":"...","purpose":"...","recordId":"...","recordType":"...","caseId":"...","emergencyFlag":false},
  "decisiveAttributes":["..."],
  "counterfactual":"...",
  "explanation":"...",
  "policyVersion":"crime-policy-v2",
  "modelVersion":"qwen3-14b-seba-lora-v6"
}
```

The ledger's nested `explanation` object is:

```json
{"decision":"allow|deny|escalate","reasonCode":"controlled effective reason","decisiveAttributes":["..."],"counterfactual":"...","policyVersion":"crime-policy-v2","modelVersion":"qwen3-14b-seba-lora-v6","text":"controlled sentence"}
```

The final sentence, attributes, and counterfactual are deterministic. They are not copied from Qwen, and Qwen cannot add them to the accepted compact schema. Optional post-ledger UI prose may be LLM-rendered, but is isolated from authorization and attestation.

## 4. Complete reason-code audit

| Reason | Decision | Condition | Decisive attributes | Counterfactual condition | Correct |
| --- | --- | --- | --- | --- | --- |
| `CRED_NOT_ACTIVE` | deny | Credential is not active. | credential status | Active status removes this barrier; later gates still apply. | YES |
| `INVALID_PURPOSE` | deny | Purpose absent/outside vocabulary. | purpose | Allowed purpose removes this barrier; later gates still apply. | YES* |
| `RBAC_NO_PERMISSION` | deny | MSP/role ownership or action/type permission fails. | MSP, role, action, record type | Matching RBAC permission removes barrier. | YES |
| `SEALED_RECORD` | escalate | Sealed and requester outside CourtMSP. | sealed flag, MSP | No seal or CourtMSP removes barrier. | YES |
| `JUVENILE_PROTECTED` | deny | Juvenile flag and role outside exception. | juvenile flag, role | No flag or exception role removes barrier. | YES |
| `VICTIM_DATA_NOT_NECESSARY` | deny | Forensic lab role requests victim-protected raw data. | victim flag, role | Resource without protected raw victim data removes barrier. | YES |
| `CROSS_JURISDICTION` | deny | Subject and record districts differ. | both jurisdictions | Matching record district removes barrier. | YES |
| `NOT_ASSIGNED` | deny | Non-exempt role lacks case assignment. | assignments, case ID | Active assignment removes barrier. | YES |
| `INSUFFICIENT_CLEARANCE` | deny | Clearance below sensitivity. | clearance, sensitivity | Clearance at required level satisfies condition. | YES |
| `POLICY_SATISFIED` | allow | Every applicable ordered gate passes. | all applicable passing-gate facts | Breaking any applicable gate invalidates automatic ALLOW. | YES |
| `MODEL_POLICY_DISAGREEMENT` | escalate | Model decision/reason differs from policy. | model and policy decision/reason | Exact decision/reason agreement removes disagreement review. | YES |
| `MODEL_INPUT_DISAGREEMENT` | escalate | Model action/purpose differs from commitment. | model and committed action/purpose | Exact input agreement removes interpretation review. | YES |

Every controlled sentence expresses the same listed condition and effective decision. `* INVALID_PURPOSE` is defense-in-depth: the two-party API normally rejects an invalid canonical purpose before inference; a model misreading instead becomes `MODEL_INPUT_DISAGREEMENT`.

Archived dataset material contains the obsolete labels `AUDIT_METADATA_ONLY` and `EMERGENCY_CROSS_JURISDICTION`; neither is retained in the active source vocabulary. There are no orphan active mappings, conflicting mappings, or explanation definitions without mappings.

## 5. Problems found and changes made

No critical authorization bypass was found; the guard failed closed.

### Major fixes

1. Removed false `env.purpose` evidence from `VICTIM_DATA_NOT_NECESSARY` in `policyEngine.js` and `controlledDecision.js`.
2. Expanded `POLICY_SATISFIED` to all applicable passing gates and added a non-null counterfactual.
3. Reworded counterfactuals so changing one condition removes that barrier without falsely promising final ALLOW.
4. Restricted raw Qwen output to `MODEL_REASON_CODES`; only deterministic code can create disagreement reasons.
5. Preserved certificate-level revocation when AIOrg reconstructs the requester, while current ledger revocation still has priority.
6. Made the AI listener checkpoint resume from the last block so a later failed event in the same block cannot be skipped.

### Minor fixes

1. Removed the stale optional template reason and corrected juvenile/victim/disagreement UI wording.
2. Distinguished CourtMSP sealed review from AuditMSP disagreement review in optional prose.
3. Updated Methodology and algorithm: Qwen produces a proposal, policy and Fabric independently re-evaluate, input/policy disagreement are distinct, and the explanation is deterministic.

## 6. Explanation flow after the fix

```text
effective D + effective controlled r + trusted C
 -> Xi(D,r,C) = {reasonCode, decisiveAttributes, counterfactual, explanation}
 -> signed {queryHash, contextHash, complete decision, inference}
 -> Fabric rebuilds C, re-evaluates, re-materializes Xi, verifies hashes/signature/registrations
 -> exact-match ledger state
```

For a proposed ALLOW or DENY that disagrees with policy, the object is rebuilt from `ESCALATE + MODEL_POLICY_DISAGREEMENT`; proposed allow/deny explanation material is not retained. Input conflict analogously uses `MODEL_INPUT_DISAGREEMENT`.

## 7. Test results

The automated explanation suite contains all ten required tests: ALLOW; DENY; normal ESCALATE; disagreement from proposed ALLOW; disagreement from proposed DENY; decision/reason mismatch; tampered text; tampered attributes; tampered counterfactual; and unknown reason. It also exhaustively checks every model reason and both system escalation reasons.

| Suite | Result |
| --- | --- |
| Chaincode | 172 passing; 90.90% statements, 83.89% branches, 89.92% functions, 92.35% lines |
| Backend unit | 75 passing |
| Frontend | 7 passing |
| Final live Qwen + six-org Fabric acceptance | exactly 3/3 passing |
| Paper | Tectonic build succeeded and produced `seal_paper.pdf` (warnings remain) |

The last broader backend run before the certificate fix had 87 passing and three integration failures. The revoked-certificate failure was fixed and proved by unit test and a real ledger DENY. Two non-explanation cases remain outside this audit: AuditMSP is intentionally outside the private request-query collection, and an older evidence-detail fixture still assumes a five-peer majority. They are not reported as passing.

### Frozen precision, baseline, and ablation evidence

These measurements predate the final three-scenario acceptance run and were not rerun or backfilled during this audit. The first three rows use the same 200-case test dataset and seed. The last two rows use the same 100-case validation subset and seed, so only those paired ablation rows should be compared directly.

| Arm | n | Schema valid | Decision accuracy | Joint accuracy | False ALLOWs | Guard referrals | Rejected | Adversarial joint accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V4 short-prompt baseline | 200 | 178 | 0.670 | 0.535 | 14 | 71 | 22 | 0.500 |
| V4 grounded prompt | 200 | 175 | 0.735 | 0.585 | 10 | 57 | 25 | 0.560 |
| V6 grounded selected adapter | 200 | 198 | 0.890 | 0.770 | 0 | 43 | 2 | 0.700 |
| V6 full trusted context | 100 | 100 | 0.870 | 0.800 | 0 | 20 | 0 | 0.800 |
| V6 without trusted subject | 100 | 100 | 0.840 | 0.350 | 0 | 64 | 0 | 0.333 |

The table is saved as `results/tables/seal-precision-comparison.csv`. Its source artifacts are the five JSON result files in `experiments/runs/20260906_seal_precision_e2e/`. The measured V6 result is better than the retained V4 baseline on joint accuracy and false ALLOWs, while the paired ablation shows that trusted subject context materially reduces referral and reason-classification failure. This does not establish general-world accuracy or causality beyond these frozen datasets.

### Exactly three final end-to-end scenarios

| Test | Qwen | Policy | Effective | Ledger state | Attestation | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Allow | ALLOW / `POLICY_SATISFIED` | same; full agreement | ALLOW / same reason | `granted` | signature, hash, registration valid | PASS |
| Deny | DENY / `CRED_NOT_ACTIVE` | same; full agreement | DENY / same reason | `denied` | signature, hash, registration valid | PASS |
| Escalate | advisory ALLOW, interpreted `export/prosecution` | canonical `view/investigation` is ALLOW; input mismatch | ESCALATE / `MODEL_INPUT_DISAGREEMENT` | pending, then AuditMSP-approved | signature, hash, registration valid | PASS |

ALLOW released identity-bound metadata, completed owner PDF upload and requester release. DENY returned HTTP 422 for metadata. ESCALATE returned no metadata before review, was approved by `AuditMSP/sp.north`, and then released requester-bound metadata.

## 8. Attestation and ledger coverage

| Data | Signed | Checked before commit |
| --- | --- | --- |
| effective decision | YES | schema, mapping, independent re-derivation/hash |
| effective reason | YES | enum, mapping, independent re-derivation |
| explanation text | YES | deterministic re-materialization/hash |
| decisive attributes | YES | deterministic re-materialization/hash |
| counterfactual | YES | deterministic re-materialization/hash |
| canonical parsed request | YES | commitment and trusted record match |
| query/context hashes | YES | signature and freshness equality |
| model/policy/adapter identity | YES | active registration and schema checks |

Later `AuditContract.VerifyExplanation` checks canonical explanation hash equality. Full policy/explanation reproduction occurs earlier in `SubmitLLMDecision`. The signature proves integrity and registered-operator attribution, not faithful execution of every neural operation.

## 9. Remaining limitations

- Explanations describe deterministic policy paths, not neural causality or Qwen hidden reasoning.
- `decisiveAttributes` are represented-rule facts (and all applicable gates for ALLOW), not a minimal causal set.
- Counterfactuals remove a barrier or invalidate ALLOW; they do not promise a final decision flip because later gates may fail.
- `INVALID_PURPOSE` is normally precluded by API validation.
- Old ledger decisions are not rewritten.
- Enforcement is post-generation strict validation, not token-level constrained decoding. Malformed output cannot authorize, but remains pending.
- Purpose is interpreted from private text and remains a requester assertion; real-world motive is not proven.
- Debug attempts exposed sensitivity to unusual synthetic identifier/phrase forms. The guard prevented unsafe acceptance. The accepted run uses the repository's normal opaque `REC-...` format; robustness remains reportable.
- The local research deployment warns that `.env` and a production JWT secret are absent.

## 10. Paper claim mapping

| Claim | Status | Safe scope |
| --- | --- | --- |
| Every outcome has a structured explanation. | SUPPORTED | Every newly committed active LLM decision; malformed generations are not outcomes. |
| It contains a controlled reason. | SUPPORTED | Closed active vocabulary. |
| It identifies decisive attributes. | SUPPORTED | Say deterministic policy-path attributes, not causal model features. |
| It contains a counterfactual. | SUPPORTED | Rule-condition counterfactual, not generic advice or guaranteed flip. |
| It corresponds to effective decision. | SUPPORTED | Fabric re-materializes the exact effective artifact. |
| It is cryptographically bound. | SUPPORTED | Complete explanation is within signed decision and output hash. |
| It is verified during ledger governance. | SUPPORTED | Re-derived at submission; hash-verifiable later. Not proof of neural execution/causal truth. |
| It is generated by the LLM. | MISLEADING | Qwen emits compact advisory classification; SEAL deterministically materializes explanation. |

Safe paper sentence:

> SEAL materializes a structured policy-path explanation from the validated effective decision, controlled reason, and trusted authorization context. The explanation is included in the AI operator's signed artifact and independently re-materialized by Fabric before commitment; it does not expose or prove the language model's internal reasoning.

## Reproduction appendix

For the currently running ledger, start any stopped application process in its own terminal with `make model`, `make backend`, and `make ai`. Run the exact acceptance workflow with a new output path so evidence is never overwritten:

```bash
node experiments/run-seal-final-e2e.js \
  --output experiments/runs/<new-run-id>/final-e2e.json
```

For a clean local rebuild, first copy `.env.example` to `.env`, replace the placeholder JWT secret, and confirm the configured adapter path/hash. Then run:

```bash
make doctor
make install
make all CC_VERSION=3.7
```

`make all` now creates or verifies the local Ed25519 AI signing key before model registration. It recreates local network state; preserve any old checkpoint/evidence before using it. Start `make model`, `make backend`, and `make ai` in separate terminals, then use the new-path acceptance command above.

## Self-improvement loop

**Worked:** deterministic materialization, fail-closed disagreement, full-field attestation, and Fabric reproduction resisted all tested tampering; real ALLOW/DENY/ESCALATE completed through AuditMSP review and protected release.

**Weak:** Qwen showed phrase/identifier sensitivity, and the prior listener checkpoint had a block edge case.

**Next experiment:** freeze a paraphrase and identifier-perturbation set for every reason; compare V6 with the retained V4 baseline and trusted-context ablations using schema rate, joint reason accuracy, false allows, and guard referrals without weakening the guard.
