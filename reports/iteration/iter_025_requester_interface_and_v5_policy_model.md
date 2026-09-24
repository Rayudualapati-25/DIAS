# Iteration 025 — Requester Interface and the V5 Policy Model

## Objective

Deliver the requester journey end to end — sign in, select a case file, let the
fine-tuned model decide, then either read the metadata or ask the owning station
for the full PDF — and address the one open item behind it: the V4 model's
accuracy on the held-out policy suite.

## Part 1 — Requester interface

### What the screen does now

`Search case files` runs the eight steps the interface was specified around:

1. Sign in with an enrolled Fabric identity.
2. Open **Search case files**.
3. Type a case-file number and press **Search**.
4. The request goes straight to the fine-tuned Qwen model. Nothing about the
   record is read or displayed first.
5. On ALLOW the decision card offers two options side by side:
   **Get detail** releases the ledger-gated metadata, and **Request detail**
   asks the owning station to upload the complete PDF.
6. On DENY the reason code, decisive attributes, counterfactual and a
   plain-language restatement are shown; metadata stays hidden.
7. On ESCALATE the request waits in the AuditMSP queue until an auditor or
   ombudsman resolves it on-chain.
8. Every step is written to the Fabric access log under its own action name.

### Changes

| File | Change |
|---|---|
| `frontend/js/modules/search-records.js` | Rewritten around the decision. Metadata is no longer shown automatically on ALLOW; it is one of two explicit options. Auditor-approved requests say so. |
| `frontend/js/shared/recent-requests.js` | New. Session-scoped list of this identity's requests so a pending escalation can be reopened; the ledger remains the source of truth for status. |
| `frontend/js/modules/escalations.js` | Queue now shows request time and a short decision id, so two requests from the same officer for the same record are distinguishable. |
| `frontend/js/shared/vocab.js` | Human labels for the new access-log actions. |
| `backend/src/middleware/accessLogger.js` | Fixed classification: LLM requests were logged as a generic `api.access.llm-request` with no record, and `/records/document-requests/mine` was logged as reading a record called "document-requests". |
| `backend/package.json` | `npm start` loads a root `.env` when one exists. |

The free-text query is never written to the access log — only which record was
asked about.

### Verified live

Against the running five-organization network and the real MLX-served model:

| Scenario | Result |
|---|---|
| `insp.sharma` → `REC-FIR-001` | ALLOW / `POLICY_SATISFIED`, committed on-chain; Get detail released metadata; Request detail created the PDF request |
| `const.verma` → `REC-FIR-001` | DENY / `NOT_ASSIGNED` with counterfactual |
| `insp.singh` → `REC-FIR-001` | ESCALATE / `CROSS_JURISDICTION` → AuditMSP queue → approved by `aud.qureshi` → file opened for the requester |
| `analyst.rao` → `REC-JUVENILE-001` | Safety guard fired (`MODEL_POLICY_DISAGREEMENT`) → auditor rejected → metadata refused with a clear ledger error |

The access log, read as auditor, shows "asked Qwen for an access decision",
"opened case-file metadata" and "requested the full case file".

## Part 2 — Chaincode

`llmDecisionProtocol.js` pinned a single `MODEL_VERSION`, so no new model
generation could ever be registered or attest a decision. It now carries a
`SUPPORTED_MODEL_VERSIONS` list, and which generation is *allowed* to decide
stays a governance choice recorded on the ledger by `ActivateLLMPolicyModel`.
A new check rejects an inference whose `modelVersion` disagrees with the
decision it accompanies.

Deployed as chaincode version **2.6, sequence 4**, approved by all five
organizations. The ALLOW path was re-verified against the upgraded chaincode.

`scripts/activate-llm-model.js` (new) registers an adapter digest, its
generation and the Ed25519 attestation key, and is idempotent.

## Part 3 — Why V4 was weak

The retained V4 run on its own 360-case held-out suite:

| Metric | V4 |
|---|---|
| Decision accuracy | 91.39% |
| Joint decision + reason | 88.06% |
| Adversarial joint | 76.67% |
| False allows (raw model) | 22/300 (7.33%) |
| **False allows (with the deployed safety guard)** | **0** |
| Routed to an AuditMSP reviewer by the guard | 43/360 (11.94%) |

The deployed pipeline is not exposed to the 7.33% figure. A false allow always
carries a wrong reason code, and the guard converts every reason-code
disagreement into an escalation, so all 22 are caught. The real cost is
reviewer workload, and the metric worth improving is the share of requests the
system can settle on its own.

The V4 dataset generator explains the errors:

- Requesters were drawn from eight hardcoded access patterns, so only 10 of the
  14 roles ever appeared and **CourtMSP requesters were entirely absent**
  (train split: Police 2967, Forensics 1188, Prosecution 645, Audit 240,
  Court 0).
- The record's owning organization was never part of the model input.
- Each scenario was built by switching on *one* condition, so only 18.0% of
  training rows had two or more rules firing at once. Rule *order* was barely
  taught — and 14 of the 22 false allows were `RBAC_NO_PERMISSION` answered as
  `POLICY_SATISFIED`.

## Part 4 — V5 dataset

`generate_dataset_v5.js` (new; the V3/V4 generator is untouched so retained runs
stay reproducible) samples structured-random scenarios across the full
role × record-type × action × purpose space, labels them with the deterministic
oracle, and then stratifies to decision-balanced quotas with round-robin role
coverage.

| | V4 | V5 |
|---|---:|---:|
| Train / valid / test | 5040 / 630 / 360 | 7200 / 720 / 360 |
| Distinct requester roles | 10 | **14** |
| Train rows with ≥2 rules firing | 18.0% | **42.2%** |
| Test rows with ≥2 rules firing | 26.1% | **55.3%** (up to 5 at once) |
| Prompt-injection phrasings | 5 | 12 train + **3 unseen at test** |

Test-time injections the model has never seen make the adversarial number a
measure of generalisation rather than recall. The independent dataset audit
passes with zero oracle mismatches, zero cross-split template leakage and no
reused record or case identifiers.

Because the V5 suite is materially harder, a V5-on-V5 number is not comparable
to the retained V4-on-V4 number. The evaluation therefore holds the suite fixed
and varies the model.

## Part 5 — V5 training

Single epoch, 1800 iterations, 75.6 minutes on the M-series host; validation
loss 3.319 → 0.023; checkpoints every 300 iterations. Run retained at
`LLMxAI/experiments/runs/20260904_qwen3_policy_engine_train_v5`.

## Part 6 — V5 result: not promoted, and what it revealed

### The decision criterion, fixed in advance

Before any V5 number existed, promotion required all of the following on V4's own
360-case suite: joint accuracy at least V4's 88.06%, zero false allows with the
deployed safety guard, and no increase in the 43/360 requests routed to a
reviewer.

### Result

Checkpoint selection on the held-out validation suite chose step 900 of 1800.
Evaluated on **V4's own suite**, so the only thing that changes is the model:

| Metric | V4 (retained) | V5 |
|---|---:|---:|
| Decision accuracy | **91.39%** | 60.83% |
| Joint decision + reason | **88.06%** | 53.06% |
| Adversarial joint | **76.67%** | 47.50% |
| False allows (raw model) | 22/300 | 82/300 |
| Output-contract validity | 100% | 100% |
| Median latency | 2306 ms | 2349 ms |

V5 fails every clause. **V4 remains the registered on-chain model**; nothing was
activated. The V5 adapter is retained as an experimental artifact. The more
important finding came from running the same comparison the other way round —
holding the model fixed and hardening the suite — which is below.

### Why it regressed

V5 did not degrade uniformly. It stopped emitting three reason codes almost
entirely. Across 360 cases with 30 of each code as ground truth, V5 predicted
`INSUFFICIENT_CLEARANCE` once, `AUDIT_METADATA_ONLY` once and `NOT_ASSIGNED`
twice, while over-predicting `POLICY_SATISFIED` 105 times.

Class frequency does not explain it. V4 and V5 have nearly identical training
shares (4.8% for most codes, 11.1% for the escalation codes), and
`INSUFFICIENT_CLEARANCE` held 11.1% of V5's training data yet was predicted once
in 360.

The explanation is the **decoy ratio** — how often a condition is present but is
*not* the answer because an earlier rule fired first:

| Condition | V4 answer / decoy | V5 answer / decoy |
|---|---:|---:|
| `NOT_ASSIGNED` | 240 / 274 = **1.1×** | 342 / 1359 = **4.0×** |
| `INSUFFICIENT_CLEARANCE` | 560 / 277 = **0.5×** | 800 / 1552 = **1.9×** |
| `RBAC_NO_PERMISSION` | 240 / 0 = 0.0× | 343 / 337 = 1.0× |
| `CROSS_JURISDICTION` | 560 / 840 = 1.5× | 800 / 1201 = 1.5× |

The two codes V5 abandoned hardest are exactly the two whose decoy ratio rose
most. Sampling scenarios uniformly means a late rule is rarely the *first* to
fire, so the model learns that seeing an attribute violated usually implies some
*other* rule is the answer, and stops emitting that code at all. A rank-8,
16-layer, single-epoch LoRA has no spare capacity to hold the ordering instead.

A second, independent defect compounds it. The supervised target is a JSON object
whose `policyVersion` and `modelVersion` fields take exactly one value across all
7,200 examples, yet consume **42.7%** of the target characters, while
`reasonCode` — the only field that determines access — is **10.4%**. Nearly half
the gradient goes into reproducing two constants. This is why validation loss
reached 0.023, essentially perfect next-token prediction, while the decision was
still wrong 44% of the time. V4 shares this defect; it only bites once the task
is hard enough to need the capacity.

### Both models fail the harder suite — and the guard holds in every case

Holding the model fixed and varying the suite is the more revealing experiment.
V4 loses 45.8 points of joint accuracy on multi-condition requests:

| Arm | Decision | Joint | Adversarial | False allow (raw) |
|---|---:|---:|---:|---:|
| V4 on V4 suite (retained) | **91.39%** | **88.06%** | 76.67% | 22/300 |
| V5 on V4 suite | 60.83% | 53.06% | 47.50% | 82/300 |
| V4 on V5 suite | 57.22% | **42.22%** | 48.33% | 45/300 |
| V5 on V5 suite | 60.83% | 46.94% | 40.83% | 100/300 |

So V5 is much worse on predominantly single-condition requests, and slightly
*better* than V4 on multi-condition ones (46.94% against 42.22%). Neither model
has learned the rule ladder; both are matching single attributes, which the V4
suite rewards and the V5 suite exposes. V4's worst rules on the harder suite are
`RBAC_NO_PERMISSION` at 3.3% and `INSUFFICIENT_CLEARANCE` at 6.7%.

Replaying the deployed safety guard over all four arms gives the number that
actually matters for operation:

| Arm | Auto-decided | Routed to an auditor | Unsafe allows after the guard |
|---|---:|---:|---:|
| V4 on V4 suite | 88.1% | 11.9% | **0** |
| V5 on V4 suite | 53.1% | 46.9% | **0** |
| V4 on V5 suite | 42.2% | 57.5% | **0** |
| V5 on V5 suite | 46.9% | 53.1% | **0** |

Two conclusions follow, and they point in opposite directions.

**The architecture is sound.** Not one unsafe allow survives the guard in any
condition, including the arms where the raw model is wrong a third of the time.
A false allow always carries a wrong reason code, and the guard converts every
reason-code disagreement into an escalation. Safety does not depend on model
accuracy — which is the property the design was built for.

**The model is the bottleneck, and its headline number is suite-dependent.**
On realistic multi-condition traffic the registered V4 model settles only
**42.2%** of requests by itself and refers **57.5%** to a human reviewer. The
91.39% figure describes accuracy on mostly single-condition requests and should
be reported that way, with the multi-condition number beside it.

One V4 output on the harder suite failed the schema outright — it invented the
reason code `COURT-ORDER_SEALED` — and the backend fails closed on that, writing
no decision and returning 503. The guard-replay script assumed every row had a
usable prediction and crashed on it; that has been fixed to count rejected
outputs separately, and the retained V4 figures are unchanged.

### The trusted-attribute grounding still works

Blanking the trusted subject block and re-running the V5 balanced-60 suite halves
joint accuracy, 45.00% → 23.33%. The model is genuinely reading the
ledger-supplied identity attributes rather than inferring an answer from the
free-text query — the property the whole design depends on. V4 showed the same
effect (90.00% → 46.67%). Whatever is wrong with V5, it is not that the trusted
context is being ignored.

### Caveat on the checkpoint choice

Selection used a 120-case validation suite, where the standard error on a 65%
score is about 4.4 points. Steps 900, 1500 and 1800 scored 65.0/65.0/61.7 on
decision accuracy, so the choice among them is within noise, and the sweep did
not converge the way V4's did (56.7 → 95.0, best at the final step). Evaluating
step 1800 on V4's suite is a cheap follow-up, though it is unlikely to close a
30-point gap; the abandoned-class analysis below points at the dataset, not the
checkpoint.

### Recommended next iteration

The target is no longer "beat V4". Both generations fail the rule ladder, so the
goal is a model that holds ordering across multi-condition requests and thereby
lowers the 57.5% referral rate on realistic traffic. Four changes, in order of
expected value:

1. **Mix the two dataset styles.** V4 teaches each rule in isolation (decoy ratio
   ≈ 0) but never teaches ordering; V5 teaches ordering but drowns each rule's
   isolated signal. Keep V4-style single-condition cases for every rule, add
   V5-style multi-condition cases, and cap the per-condition decoy ratio near
   1.0×. The generator already computes everything needed to enforce that.
2. **Stop supervising constants.** Drop `policyVersion` and `modelVersion` from
   the generated target — the runtime stamps them and the chaincode validates
   them anyway — or mask the loss to the `reasonCode` span. Either concentrates
   roughly four times more gradient on the field that decides access. This alone
   may explain much of the gap, and it is a one-line change to the generator plus
   a matching relaxation in `validateClassification`.
3. **Raise capacity** if the harder mixture is kept: LoRA rank 8 → 16 or 32,
   layers 16 → 24, and more than one epoch. V5's selection curve oscillated
   rather than converging, the signature of under-fitting.
4. **Keep selecting checkpoints by accuracy, not loss.** Loss would have chosen
   step 1200 or 1500; accuracy chose 900. On this task loss is not a usable proxy.

Each step is one command — generator, training, selection, evaluation — and the
V5 pipeline is retained and reproducible end to end.

### What to change in the paper

Two claims need adjusting regardless of what the next model does.

- Report V4 as **91.39% decision / 88.06% joint on predominantly single-condition
  requests**, with the multi-condition figures (57.22% / 42.22%) beside them.
  The single number on its own overstates what the model does on realistic traffic.
- Report the false-allow result as a property of the **pipeline**, not the model:
  zero unsafe allows survive the guard in all four arms, at a cost of 11.9% to
  57.5% of requests being referred to a human depending on request difficulty.
  That is a stronger and more defensible claim than the raw 7.33% figure.

## Reproduction

```bash
LLM_POLICY_MODEL_VERSION=qwen3-14b-seba-lora-v5 SEBA_DATA_DIR=data_v5 \
  node LLMxAI/experiments/llm_policy_engine/generate_dataset_v5.js
LLM_POLICY_MODEL_VERSION=qwen3-14b-seba-lora-v5 SEBA_DATA_DIR=data_v5 \
  SEBA_AUDIT_OUTPUT=LLMxAI/experiments/runs/20260904_qwen3_policy_dataset_audit_v5/report.json \
  node LLMxAI/experiments/llm_policy_engine/audit_dataset.js
.venv-qwen-policy/bin/python LLMxAI/experiments/llm_policy_engine/run_training.py \
  --config experiments/llm_policy_engine/train_config_v5.yaml \
  --run-dir experiments/runs/20260904_qwen3_policy_engine_train_v5
bash LLMxAI/experiments/llm_policy_engine/evaluate_v5.sh
```

## System state

| | |
|---|---|
| Backend | `http://localhost:3001` (serves the API and the dashboard) |
| Registered policy model | `qwen3-14b-seba-lora-v4`, adapter `bdb012513c12…` — **unchanged** |
| Chaincode | `crimerecords` version 2.6, sequence 4, approved by all five organizations |
| Model server | `mlx_lm.server` on `127.0.0.1:8080` |
| Explanation helper | Ollama `llama3.2:3b` on `:11434` (wording only; never decides) |

Nothing about the runtime changed as a result of the V5 experiment. If a future
generation does pass the criterion, promoting it is:

```bash
LLM_POLICY_MODEL_VERSION=qwen3-14b-seba-lora-v5 \
LLM_POLICY_ADAPTER_HASH=<sha256 of the promoted adapter> \
  node scripts/activate-llm-model.js
```

and reverting is the same command with the V4 version and digest.

## Tests

| Suite | Result |
|---|---|
| Chaincode | 110 passing, 91.72% statements / 85.02% branches |
| Backend unit | 52 passing |
| Frontend | 7 passing (new `node --test` suite) plus a syntax check over every module |
| LLMxAI | 26 passing |

## Retained artifacts

- `LLMxAI/experiments/llm_policy_engine/data_v5/` — dataset and manifest
- `LLMxAI/experiments/runs/20260904_qwen3_policy_dataset_audit_v5/report.json` — audit, status `passed`
- `LLMxAI/experiments/runs/20260904_qwen3_policy_engine_train_v5/` — training log and run metadata
- `LLMxAI/experiments/runs/20260904_qwen3_policy_engine_select_v5/` — per-checkpoint validation runs
- `LLMxAI/experiments/runs/20260904_qwen3_policy_engine_eval_v5/` — four evaluation
  arms plus the subject ablation and a derived balanced-60 subset
- `LLMxAI/.../adapters/qwen3-14b-seba-lora-v5-best/` — promoted checkpoint, `38aac463915f…`
