# DIAS V7 Completion — Phase 0 Preflight Audit

**Date (UTC):** 2026-09-12
**Repository:** `/Users/venkatrayudu/Workspace/XAI workspace/DIAS`
**Purpose:** Record the exact state of the workspace *before* the V7 completion work begins, so every later change is attributable and every existing artifact is recoverable.

## 1. Repository state

- Branch at audit time: `main`
- HEAD: `9a3dddf31d4dd2855faf8143186578c5f893af63` — *Create standalone DIAS project snapshot*
- Working tree: **44 dirty entries** (4 modified contracts, 8 deleted legacy tests, 1 modified test, 1 modified deploy script, 30 untracked paths)
- `git diff --check`: clean (no whitespace errors)
- Diff volume: 1,567 insertions / 3,551 deletions across 14 tracked files

The uncommitted work is the DIAS binary-architecture rewrite (chaincode `lib/dias/`, backend `src/dias/`, `policies/`, the new chaincode test suites, and the legacy tests relocated to `chaincode/crimerecords/test/legacy/`). **None of it was committed before this audit**, so a checkpoint commit is the first action taken.

## 2. Protected paths (read-only for this work)

| Path | Status |
| --- | --- |
| `/Users/venkatrayudu/Workspace/XAI workspace/crime-records-network` | untouched — holds the live V6 adapter and the running service's model |
| `/Users/venkatrayudu/Workspace/XAI workspace/wt-dias` | untouched — prior worktree |

All commands in this work run with the DIAS repository as the working directory. No write path in the plan resolves into either protected tree.

## 3. V6 preservation

The V6 service is **running and must stay running**:

- Process: PID `54194`, `mlx_lm.server --model mlx-community/Qwen3-14B-4bit --adapter-path .../crime-records-network/LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v6-best --host 127.0.0.1 --port 8080 --max-tokens 192 --chat-template-args {"enable_thinking":false}`
- Listening on `127.0.0.1:8080`

V6 adapter SHA-256 (authoritative copy, `crime-records-network`):

| File | SHA-256 |
| --- | --- |
| `qwen3-14b-seba-lora-v6-best/adapters.safetensors` | `5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe` |
| `qwen3-14b-seba-lora-v6-best/adapter_config.json` | `a6637b2e657de148a46dc669a9c2cdbc6787dfce9d162319e702d03234af2b8d` |
| `qwen3-14b-seba-lora-v6-best/selection.json` | `3ab6697d2fc74c40dbbc406c84e54ba395f4e4af22ec21568597e484e2cdb0db` |
| `qwen3-14b-seba-lora-v6/0000150_adapters.safetensors` | `5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe` |
| `qwen3-14b-seba-lora-v6/0000300_adapters.safetensors` | `6b582f2aabe5ad6982fb922dbd80aa963888f2e79e74456ef84cf5f75867e88a` |
| `qwen3-14b-seba-lora-v6/adapters.safetensors` | `6b582f2aabe5ad6982fb922dbd80aa963888f2e79e74456ef84cf5f75867e88a` |

Note: `v6-best/adapters.safetensors` is byte-identical to the iteration-150 checkpoint, i.e. V6 selection chose checkpoint 150, not the final 300. The DIAS repository holds its own copy of `v6-best/adapters.safetensors` with the same hash, so V6 is recoverable from two independent locations. Full hash listing: `v6-hash.txt`.

## 4. Running services and infrastructure

- **Fabric network is up** (2 days uptime): orderer, 6 peers (police, forensics, prosecution, court, audit, ai), 6 CouchDB instances, 6 CAs, all Fabric 2.5.16 / CouchDB 3.4.2 / Fabric-CA 1.5.22.
- **Deployed chaincode:** `crimerecords_3.7` — the SEAL-era build. Six chaincode containers are running it.
- **Port 8080:** V6 MLX server (do not disturb).
- **Port 8081:** free — reserved for the untuned Qwen3-14B baseline server.
- **Port 3001:** free — no standalone DIAS backend is listening, which is why the two live API hooks in the backend suite failed in the external audit.

## 5. Hardware and toolchain

- Apple M3 Max, 16 cores, 64 GiB RAM, arm64, Darwin 25.6.0
- Node v22.20.0, npm 10.9.3, Docker 29.6.2, Python 3.13.5
- `.venv-qwen-policy`: Python 3.13.7, `mlx` 0.32.2, `mlx-lm` 0.31.3, `transformers` 5.17.0
- Disk free on data volume: **408 GiB of 926 GiB (55% used)** — ample for V7 training, checkpoints and evaluation artifacts.

## 6. Integration gap confirmed (not assumed)

Method names called by the backend versus methods exposed by the rewritten chaincode:

| Backend call site | Method called | Exists in new chaincode? |
| --- | --- | --- |
| `backend/src/ai/decisionService.js` | `GetAccessRequestForDecision` | **No** |
| `backend/src/ai/decisionService.js` | `SubmitLLMDecision` | **No** |
| `backend/src/routes/access.js` | `RequestAccess` | **No** |
| `backend/src/routes/access.js` | `QueryDynamicAccessRules` | **No** |
| `backend/src/routes/access.js` | `GetDynamicAccessRuleHistory` | **No** |
| `backend/src/routes/access.js` | `RevokeDynamicAccessRule` | **No** |
| `backend/src/routes/access.js` | `SubmitAuditorDecision` | Yes (signature changed) |

The backend AI listener also still imports `src/llm/policyDecision.js`, the SEAL-era deterministic runtime guard. `backend/src/dias/` (451 lines across 4 modules) is unit-tested but **not wired into any runtime path**. This is the first defect to repair in Phase 1.

## 7. Decisions taken at preflight

1. Work continues on a dedicated branch, `dias-v7-completion`, created from the current dirty `main` **without discarding anything**.
2. A checkpoint commit preserves the uncommitted architecture rewrite before any integration edit. Model weights, caches and secrets are excluded per `.gitignore`.
3. No `git reset`, `git checkout --`, `git clean` or equivalent destructive command is used at any point.
4. The live V6 service and the deployed `crimerecords_3.7` chaincode are left running. The redesigned chaincode will be deployed under the separate name `diasrecords`.

## 8. Artifacts in this directory

| File | Contents |
| --- | --- |
| `git-status.txt` | full `git status` at audit time |
| `diff-stat.txt` | `git diff --stat` plus `git diff --check` |
| `environment.json` | machine, toolchain, venv package versions, V6 service facts |
| `running-services.txt` | listening ports, MLX processes, Docker containers |
| `v6-hash.txt` | SHA-256 of every V6 adapter file in all three trees |
| `disk-space.txt` | `df -h` output |
| `preflight-summary.md` | this document |
