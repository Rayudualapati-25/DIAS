# DIAS pre-training readiness plan

Date: 2026-09-11
Status: in progress. Full LoRA training is out of scope for this phase.

## Authority

- The researcher's pre-training readiness requirements (2026-09-11) define the
  intended DIAS architecture.
- Conflicts with earlier documented decisions are reported, then resolved in
  favour of those requirements:
  1. **Dynamic authorization scope.** The 2026-09-09 plan
     (`reports/iteration/iter_030_dias_pivot_plan.md`) matched the same user and
     the same governed record properties, excluding `recordId` and `caseId`.
     New scope: stable user + exact record + action + purpose + unchanged
     governed conditions + optional expiry + revocation.
  2. **ESCALATE.** The 2026-09-09 plan kept ESCALATE for compatibility with the
     SEAL-era model. New contract: binary ALLOW/DENY; model and system failures
     are generation statuses, never recommendations.
  3. **Runtime rule-engine check.** The SEAL-era disagreement check was kept in
     DIAS "as evidence" and enforced by chaincode. It is removed from the live
     path; deterministic policy logic survives only as an offline reference
     oracle for dataset labels, tests, and evaluation.
  4. **Hidden action and purpose.** The SEAL canonical-input design withheld
     them from the model. They are now supplied as verified structured fields.
- Research-policy choices are not decided in this phase; they are listed in
  `docs/policies/policy-open-questions.md` for the researcher.

## Environment constraints

- The running Fabric network, backend (:3001), and AI listener belong to the
  `wt-dias` worktree. They are left untouched.
- Live validation deploys this repository's chaincode under a separate name,
  `diasrecords`, on `crimechannel`. The `crimerecords` chaincode and its state
  are not modified.
- The v6 MLX server on :8080 (`crime-records-network`) is left untouched. The
  untuned baseline uses a separate server on :8081.
- Legacy modules whose hashes are recorded in retained manifests stay
  byte-identical; the DIAS runtime stops importing them instead.

## Phases

1. Inspection and architecture drift report.
2. Canonical governance policy bundle, reference oracle, policy consistency audit.
3. LLM contract: policy context provider, prompt, response schema, recommender,
   failure statuses.
4. Chaincode: request lifecycle events, exact dynamic authorization,
   recommendation protocol without policy evaluation, request audit trail,
   legacy direct-decision paths disabled.
5. Backend, API, UI, and CLI: AI listener, auditor review fields, audit-trail
   endpoint and command.
6. Automated tests, including an architecture guard.
7. Dataset v2: generator, validator, leakage audit, review pack, token lengths.
8. Live Fabric validation of scenarios A-G on `diasrecords`.
9. Untuned Qwen3-14B baseline on the data-v2 test split.
10. Training configuration v2 and bounded pipeline smoke test.
11. Documentation, reports, readiness checklist, and handoff.

## Stop conditions

- Do not run the full LoRA training.
- Do not register or activate a newly trained model.
- Do not modify `wt-dias`, the `crimerecords` chaincode state, or the v6 server.
- Declare `READY_FOR_FULL_TRAINING` only if every critical checklist item passes.
