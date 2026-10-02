# v3 label invariance (offline)

- **Question:** v3 removes the self-declared emergency flag and the approval flag from the verified facts (plan step 5). Does that change any policy label in the published dataset?
- **Kind:** offline, deterministic check. It uses the reference policy oracle only: no model, no network, no ledger.
- **Command:** `node experiments/v3/label-invariance.js --out experiments/runs/20261002_v3_label_invariance`
- **Code:** commit of this run's folder on branch `feat/dias-v3-integrity`. Node v22.20.0. Policy `dias-governance-policy-v1`; the digest is in `label-invariance.json`.

## Result

| Measure | Count |
|---|---|
| Dataset cases (all `*.cases.jsonl`) | 8,013 |
| Oracle verdict identical with v1 facts and v3 facts | 8,013 |
| Verdict changed | 0 |
| Stored label reproduced from the v3 facts | 8,013 |
| Cases with `emergencyFlag = true` | 2,040 |
| Cases with `approvalTokenPresent = true` | 2,037 |

Per-set counts and the (empty) list of differences are in `label-invariance.json`.

## Interpretation

- The written policy never used either flag. Moving the emergency flag into the requester claims and dropping the approval flag therefore leaves every expected answer unchanged.
- **What this does not show:** whether the fine-tuned model behaves the same.
  - Prompt v2 shows the facts without the flags and adds a claims block, so V7 sees inputs it was not trained on.
  - V7 must be re-evaluated with `evaluate.js --prompt v2`. **NOT RUN**: it needs the MLX model server on the author's Mac, about 6 h per model.
