# Iteration 034 — DIAS design review before training

Date: 2026-09-11

## Status

- Full Qwen training is **on hold**. Only a 30-step smoke test ran, and it was stopped.
- The v6 adapter and the running v6 model server are unchanged.
- `experiments/dias-finetuning/train-v1.yaml` and
  `experiments/plans/20260911_dias_qwen3_lora_training.md` are marked ON HOLD.
- This review changed no runtime code and no dataset files.
- The two pasted design notes mentioned in the request were not available to
  this review; statements about them come from the researcher's message.

## Target architecture (researcher)

Request → trusted attributes → dynamic-authorization check → hit: automatic
access + ledger log → miss: full structured request + governance policy to
Qwen → Qwen ALLOW/DENY + explanation + policy references → ledger logs the
recommendation → auditor FORCE ALLOW / FORCE DENY → ledger logs the final
decision → LLM DENY + FORCE ALLOW creates or updates a dynamic authorization →
enforce access.

## 1. Architecture: facts found in the code

### A1. The rule engine checks Qwen's answer at runtime

- The AI service runs the deterministic rule engine on every Qwen answer
  (`backend/src/llm/policyDecision.js:255`).
- If Qwen's decision or reason differs from the rule engine, or Qwen misreads
  the action or purpose, the answer is rewritten to ESCALATE with
  `MODEL_POLICY_DISAGREEMENT` or `MODEL_INPUT_DISAGREEMENT`
  (`chaincode/crimerecords/lib/policy/controlledDecision.js:144-167`).
- The chaincode repeats the same check
  (`chaincode/crimerecords/lib/policy/llmDecisionProtocol.js:142`) and stores
  the rule engine's answer next to Qwen's (`accessContract.js:756-761`).
- The recorded validated decision and explanation come from the rewritten
  answer (`accessContract.js:717-738`, `policyDecision.js:258`).
- Still Qwen's own: the verdict badge on the auditor screen
  (`frontend/js/shared/dias.js:47`) and the DENY that triggers rule creation
  (`accessContract.js:735`, `accessContract.js:860`).
- History: the check came from the earlier SEAL design. The DIAS plan kept it as
  "retained as evidence for the auditor, never as final"
  (`experiments/plans/20260909_dias_dynamic_access_policy.md:321`).
  It was documented, but it still makes the rule engine the runtime reference
  for what counts as a correct recommendation.

### A2. Qwen outputs ALLOW / DENY / ESCALATE

- ESCALATE comes from one model reason (`SEALED_RECORD`) and the two system-only
  disagreement codes.
- The DIAS plan kept ESCALATE only for compatibility with the current Qwen
  vocabulary and states that binary output can be adopted without changing the
  dynamic-policy contract (`experiments/plans/20260909_dias_dynamic_access_policy.md:183`).
- In data-v1, 1,000 of 3,000 training labels are ESCALATE (all sealed records).

### A3. Action and purpose are hidden from Qwen

- `CANONICAL_REQUEST_FIELDS` in `backend/src/llm/policyPrompt.js` removes
  `action` and `purpose` from the request context before prompting.
- The chaincode already validates both fields against fixed vocabularies before
  Qwen runs (`accessContract.js:76-79`).
- Every data-v1 query template states the action and purpose word for word
  (`PHRASES` in `experiments/dias-finetuning/generate.js`), so hiding them
  tests little on this data but can fail on real free text.

### A4. Dynamic-rule scope is "same user + same record properties"

- The 21-field fingerprint includes the username and excludes `recordId` and
  `caseId` (`buildRequestFingerprint` in
  `chaincode/crimerecords/lib/policy/dynamicPolicy.js`).
- A rule can therefore grant the same user a different record whose governed
  properties are identical.
- This was a deliberate choice in the 2026-09-09 plan, listed there as an open
  assumption (`reports/iteration/iter_030_dias_pivot_plan.md`).
- Exact-record scope would add `recordId` (and `caseId`) to the fingerprint and
  require re-running the retained workflow comparison, whose counts assume the
  current scope.

## 2. Policy specification: choices that need a decision

- **P1.** Rule 5b blocks victim-protected data only for lab analyst and lab
  director. Lab assistant, senior analyst, and chief forensic officer are not
  blocked.
- **P2.** Purpose is not tied to role. In data-v1 training, police +
  `defense-preparation` is ALLOW in 99 examples and court + `forensic-analysis`
  in 30.
- **P3.** Every Court organization role, including court clerk and magistrate,
  passes the seal rule, while only judge and district judge are seal
  authorities in the escalation path. Non-court requesters get ESCALATE, which
  has no place in an ALLOW/DENY output.
- **P4.** `INVALID_PURPOSE` cannot occur live: the chaincode rejects any purpose
  outside the six allowed values before Qwen runs. data-v1 still contains 246
  such examples (125 train, 21 valid, 100 test) using `curiosity`, `media`, and
  `personal-interest`.
- **P5.** The emergency flag and approval token are shown to Qwen but never
  change a decision. Every data-v1 example has both set to false.
- **P6.** Witness flag, rank, station, owning agency, and owning station are
  never used by any rule.
- **P7.** Only the first failing rule is reported. If the output should list
  policy references, the policy must say how several failing rules are
  reported.

## 3. Dataset audit (data-v1)

Method: `experiments/runs/20260911_dias_design_review/audit-dataset-v1.js`,
results in `dataset_audit.json` in the same folder.

- **Label source.** Every label is produced by the rule engine
  (`experiments/dias-finetuning/generate.js:269`). No label was reviewed by a
  person. The audit reproduced 4,500 of 4,500 labels.
- **One cause per example.** Each example is an allowed base case with exactly
  one condition broken. 0 of 4,500 examples break two rules, so rule order is
  never trained or tested.
- **Shortcuts that can replace the rule** (`baseInput` and `applyTargetReason`
  in `generate.js`):
  - A district mismatch is always written as `outside-<record district>`; two
    real, different district names never appear.
  - A not-assigned user always has `CASE-OTHER-<same case id>`.
  - Every user has clearance `high` except insufficient-clearance cases, which
    are always `low`; `medium` users never appear.
  - Every username contains the role and the split name (4,500 of 4,500), for
    example `inspector.train.02073`.
  - Record ID number ranges map one-to-one to reason codes within each split
    (for example, training IDs 1-125 are all credential-not-active).
- **Coverage.** Victim-protected examples use only 2 roles. 25% of examples
  append one of a few fixed attack sentences (3 train, 2 valid, 2 test).
- **Sound.** Query templates and attack sentences never repeat across splits
  (0 overlap), and no identical feature set has conflicting labels. 37 abstract
  feature combinations (identities removed) occur in both train and test.
- **Manual review sample.** `dataset_review_sample.csv`: 60 rows (6 per reason;
  40 train, 20 test; 25 with attack text) with empty reviewer columns. It checks
  the current labels; a new sample is required after any regeneration.

## 4. Decisions for the researcher (recommendations in brackets)

1. Output vocabulary: ALLOW / DENY only, or keep ESCALATE?
   [ALLOW / DENY; treat invalid output and service failure as system states,
   not model labels.]
2. Runtime rule engine: remove it from the live decision path and keep it only
   as the offline label generator and evaluation reference? [Yes.]
3. Qwen input: provide the structured action and purpose; remove usernames and
   IDs that carry role or split names? [Yes to both.]
4. Qwen output: reason code + policy references with a template explanation, or
   a model-written explanation? [Reason code + policy references first; a
   free-text explanation needs its own evaluation.]
5. Policy: confirm or change P1-P7.
6. Dynamic-rule scope: exact record, or same user + same record properties?
   [Exact record for the first paper.]
7. Labels: rule-engine labels plus stratified human review, or full review?
8. Baseline: untuned Qwen3-14B with the same MLX 4-bit weights, prompt, and
   policy and no adapter; keep v6 only as an extra reference? [Yes.]

## 5. Order after the decisions

1. Update the policy specification and runtime design as decided.
2. Regenerate the dataset with real district pairs, mixed clearances,
   multi-rule cases, and neutral identifiers; run schema, duplicate, and
   leakage checks.
3. Manually review a stratified sample of the new data.
4. Evaluate untuned Qwen3-14B on the test split.
5. Train the LoRA adapter.
6. Compare base + policy with fine-tuned + the same policy, changing only the
   adapter.

## What worked

- The smoke test showed the training pipeline, memory use (11.1 GB), and
  sequence lengths are workable.
- The dataset is internally consistent and its splits do not share templates.

## Weak or failed

- The runtime design and model contract differ from the researcher's target
  (A1-A4).
- The dataset teaches single-cause, pattern-marked cases and includes a class
  that cannot occur live.

## Next

Wait for the researcher's decisions in Section 4 before changing code, data, or
training.
