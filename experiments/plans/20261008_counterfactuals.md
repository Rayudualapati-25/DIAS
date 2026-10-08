# Step 14 — verified counterfactual explanations

## Scope

Continue the unfinished generator tests on `feat/dias-v3-integrity`. Preserve
the two completed commits and all unrelated mobile/host work. Follow design
section 13: explain only, never replace a model recommendation or grant access.

## Implementation

1. Record the missing-generator failure and the existing backend baseline.
2. Implement an immutable, deterministic generator. Enumerate permitted changes
   to action, purpose, assignment, credential status, clearance, sensitivity and
   protection flags; at most two distinct facts per set. Keep only sets that the
   reference oracle confirms would satisfy all clauses. Remove redundant sets.
3. Bind runtime explanations to the ledger request's verified-context digest
   and policy version/hash. Read facts from the caller-authorized ledger trail,
   not submitted parameters or mutable stored text. Suppress incompatible or
   incomplete facts. `DIAS_COUNTERFACTUALS=off` removes this component.
4. Use the existing visibility rule: a requester sees hints only after an auditor
   denial; an auditor reviewing another person's request may read them. A
   requester who is also an auditor still follows the requester rule.
5. Add plain-language requester and audit detail panels, separate from the LLM
   text. A policy ALLOW is not an explanation of the auditor's denial. Label
   required authority; legal changes are hypothetical and not promised feasible.
6. Narrow the architecture guard to permit only this module to import the oracle.
   Recommendation, signing, worker and decision logic must remain independent.

## Evidence

- Full backend baseline excluding only the unfinished missing-module tests.
- Generator, authorization, binding, feature-toggle and UI tests, first failing.
- Full backend/frontend/policy suites after implementation; unchanged contract
  suite for compatibility.
- Deterministic offline baseline versus verified generator; ablate pair search,
  verification filtering and authority labels separately. Measure fidelity,
  minimality, coverage and declared limits, not explanation quality or novelty.
- Live read-only checks against existing decided requests and website panel.
  Restart only the backend if needed; preserve model and Fabric state.
- Retain all configs, failures, outputs and source digests under
  `experiments/runs/20261008_counterfactuals`, table under `results/tables`, and
  report under `reports/iteration/iter_070_counterfactuals.md`.

## Limits and next work

The bundle is a synthetic research policy. A verified hypothetical result does
not establish legal feasibility or predict an auditor decision. No new model,
testbed rerun, mobile feature, chaincode deployment or paper number is introduced.
Step 15 integration scripts follow this completed step.

## Completion

The baseline passed 319 backend checks excluding the unfinished module. The
completed work passed 341 backend, 82 frontend, 27 policy, 341 contract and 104
dataset checks. The 4,096-case offline grid retained 2,935 sufficient minimal
sets, with coverage 820/3,979 denied cases. Eleven live read checks passed on
existing decisions; the auditor decision-log panel was verified in the browser.
Failed missing-module, architecture and incorrect victim-role fixture attempts
are retained. Full facts, limitations and reproducibility are in iteration 070.
