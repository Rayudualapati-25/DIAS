# Iteration 031 — DIAS dynamic-policy chaincode core

Date: 2026-09-09

## Objective

Implement and verify the smallest on-chain core for exact dynamic-policy
matching before changing the Qwen recommendation and auditor-final workflow.

## Outcome

Step 2 is implemented in the isolated `feature/dias-dynamic-access-policy`
worktree.

- A versioned canonical fingerprint binds the visible username, governed user
  attributes, request action/purpose, assignment status, and security-relevant
  record properties.
- `recordId`, `caseId`, raw query text, content hashes, and off-chain references
  are excluded from reuse matching as approved in the Step 1 plan.
- A valid active exact match creates a fresh request and identity-bound `ALLOW`
  decision with `decisionAuthority: dynamic-policy`, `llmInvoked: false`, and
  `auditorRequired: false`.
- A miss retains the private-query workflow and is marked
  `processingPath: llm-auditor`.
- Dynamic rules are queryable with history and revocable only by an AuditMSP
  district authority.
- The LLM context now contains all governed subject and record fields used by
  the fingerprint, while the certificate distinguished name and raw case-file
  content remain excluded.

Fabric supports one chaincode event per transaction. Multi-stage transactions
therefore emit their final event and carry a bounded `lifecycleStages` array;
the full request, decision, and rule evidence is stored as ledger state.

## Verification evidence

The recorded run is
`experiments/runs/20260909_dias_step2_chaincode/run.json`; the comparison table
is `results/tables/dias_step2_chaincode_verification.csv`.

- Focused DIAS suite: 8 passing, 0 failing.
- Full chaincode suite: 207 passing, 0 failing.
- Global coverage: 90.79% statements, 82.32% branches, 90.96% functions, and
  92.13% lines.
- `git diff --check`: passed.

These are implementation verification results, not experimental evidence of
latency improvement or research superiority.

## What worked

- Exact matching grants another record with identical governed properties
  without transient query data, demonstrating that no model work is needed.
- Changing one fingerprint field causes a miss.
- Rule revocation changes the latest world state to `revoked` while retaining
  the prior `active` value in Fabric history.
- Existing chaincode behavior remains green after expanding the governed LLM
  context.

## What failed or was weak

- The first full regression run exposed an accidental undefined variable in
  requester-context reconstruction; it was removed and the affected AI flow
  was rerun successfully.
- Expanding the LLM context initially broke one exact-shape assertion. The test
  was updated to verify the newly required visible and governed attributes.
- The qualifying auditor transition is not connected yet. Tests currently seed
  a rule built by the validated rule factory; a runtime rule cannot be minted
  until Step 3.
- `npm ci` reported six findings in the pinned dependency tree (four moderate,
  two high). No automatic dependency upgrade was applied during this scoped
  implementation step.
- No live Fabric deployment, backend integration, user interface, experiment,
  baseline, or ablation has been run yet.

## Next refinement

Step 3 will make every valid Qwen result advisory, put it into the auditor
queue, add explicit `FORCE_ALLOW` and `FORCE_DENY` final decisions, and create a
dynamic rule only for `LLM DENY -> auditor FORCE_ALLOW`. The decision-matrix
tests must prove that Qwen alone cannot grant or deny access.
