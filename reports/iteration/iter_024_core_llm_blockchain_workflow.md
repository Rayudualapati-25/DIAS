# Iteration 024 — Core LLM decision and case-file workflow

## Objective

Connect the moved fine-tuned Qwen folder to the existing permissioned Fabric application and deliver the complete interface flow: enter a case-file number, receive an on-chain `ALLOW`, `DENY`, or `ESCALATE`, show metadata after approval, send uncertainty to `AuditMSP`, and request/upload/view a complete off-chain PDF.

## Architecture implemented

The Qwen model runs in the local MLX inference service, not inside Fabric chaincode and not as a Fabric peer. The backend builds the request from authenticated Fabric identity and ledger state, invokes Qwen, applies the safety guard, signs the result, and submits it to Fabric. Chaincode checks the registered model, adapter digest, attestation, fresh context, and decision schema before recording the decision.

The existing five organizations remain unchanged: `PoliceMSP`, `ForensicsMSP`, `ProsecutionMSP`, `CourtMSP`, and `AuditMSP`. An `AuditMSP` auditor or ombudsman is the only role allowed to resolve an escalated model decision.

## Implemented user flow

1. A signed-in user opens **Search case files**, enters a case-file number, and clicks **Get details**.
2. The backend reads trusted role, organization, clearance, credential status, assignment, and record attributes from Fabric.
3. The fine-tuned Qwen3-14B-4bit model returns the structured decision.
4. If the model and policy safety evaluator disagree, the result becomes `ESCALATE` rather than an unsafe automatic grant.
5. Fabric records the result, model version, inference hashes, signature, subject identity commitment, and transaction ID.
6. `ALLOW`, or an auditor-approved `ESCALATE`, releases metadata only to the exact requester identity. The metadata response excludes the off-chain storage reference.
7. The requester can send a **Request full PDF** transaction.
8. A filing-role user at the owning police station sees the request in **PDF requests** and uploads a PDF to the station vault.
9. Fabric stores the PDF hash and release history. Only the original requester can open the PDF.

## Model and file checks

- Adapter directory exists at `LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v4-best` (49 MiB).
- Adapter SHA-256 is `bdb012513c123311821a8f2a7c10c290dd6dfa52dd51632954484aac2efc873b`, matching the configured and registered digest.
- The cached `mlx-community/Qwen3-14B-4bit` base model exists (7.8 GiB).
- Training/evaluation data, adapter configuration, retained checkpoints, V4 evaluation artifacts, and the model-serving script are present under `LLMxAI/`.
- The live MLX `/v1/models` response contains `mlx-community/Qwen3-14B-4bit`.
- Fabric reports `crimerecords` version 2.5, sequence 3, approved by all five MSPs.

## Evidence

- Plan: `experiments/plans/20260903_core_llm_blockchain_workflow.md`
- Configuration: `experiments/runs/20260903_core_llm_blockchain_workflow/config.json`
- Guard baseline/proposed/ablation: `experiments/runs/20260903_core_llm_blockchain_workflow/guard-ablation.json`
- Live Fabric/PDF verification: `experiments/runs/20260903_core_llm_blockchain_workflow/live-verification.json`
- Browser verification: `experiments/runs/20260903_core_llm_blockchain_workflow/ui-verification.json`
- Comparison table: `results/tables/core-llm-blockchain-workflow/guard-ablation.csv`
- Screenshots: `results/plots/core-llm-blockchain-workflow/`
- Original retained V4 evaluation: `LLMxAI/experiments/runs/20260902_qwen3_policy_engine_eval_v4/proposed_full360.json`

## Results

| Check | Result |
|---|---:|
| Chaincode tests | 107 passed |
| Backend unit + live Fabric tests | 60 passed |
| Frontend JavaScript syntax checks | passed |
| Live approved escalation resolved by `AuditMSP` | passed |
| Approved requester metadata response | HTTP 200 |
| Off-chain reference exposed in metadata | no |
| Requester PDF response | HTTP 200, `application/pdf` |
| PDF bytes match ledger SHA-256 | yes |
| Wrong-identity PDF attempt | HTTP 422 |
| Desktop/mobile page overflow | none observed |
| Unlabelled browser form controls | 0 observed |

### Safety-guard ablation on the retained 360-case V4 predictions

| Arm | Decision accuracy | Joint decision + reason | False allows among expected non-allows | Sent to Audit |
|---|---:|---:|---:|---:|
| Guard disabled | 91.39% | 88.06% | 22/300 (7.33%) | 0 |
| Guard enabled | 90.83% | 88.06% | 0/300 (0.00%) | 43 |

This is a post-hoc replay against policy-oracle labels with zero dataset oracle mismatches. It demonstrates the safety tradeoff of the implemented guard; it is not a new model-training result and does not prove safety for every possible request.

The retained subject-attribute ablation contains 60 cases. Removing trusted subject attributes reduced decision accuracy from 93.33% in the comparable retained V4 60-case run to 66.67%, and joint accuracy from 90.00% to 46.67%. This supports keeping identity attributes sourced from Fabric rather than accepting them from requester text.

## What worked

- The browser invoked Qwen and displayed its model/version and inference time before metadata was released.
- `ALLOW`, `DENY`, and `ESCALATE` paths were written to the live Fabric ledger.
- A real `MODEL_POLICY_DISAGREEMENT` was safely routed to the auditor interface and approved by an `AuditMSP` identity.
- The complete PDF request, owner upload, integrity check, and requester-only read path passed live.
- Auditor and PDF actions remain visible at desktop and 375 px viewport sizes.

## What failed or remains weak

- The fine-tuned model is not perfect: its retained 360-case decision accuracy is 91.39%, and the unguarded retained run contains 22 false allows among 300 expected non-allow cases.
- The guard deliberately sends 43/360 retained cases to human review and slightly reduces raw decision accuracy. This is an explicit security/usability tradeoff.
- A separate small local model only rewrites the already-recorded decision into plain language. One earlier live wording guessed the wrong record type; the prompt and validator now reject unsupported record-type guesses and fall back to deterministic wording.
- The current local login keeps private keys on the development backend. Production deployment still needs client-held key authentication and hardened secrets.

## Next refinement

Retrain and reevaluate hard negatives for `RBAC_NO_PERMISSION`, `NOT_ASSIGNED`, and `INSUFFICIENT_CLEARANCE`; repeat the full held-out suite; then measure Audit queue load and end-to-end latency under concurrent users. The project must continue to report the guard and human-review tradeoff rather than describing the model as production-ready.
