# Remove the counterfactual explanation layer

Author instruction, 2026-10-08: retain only the existing LLM explanation and remove explanations produced from ledger facts. This supersedes step 14 and its runtime oracle exception.

1. Preserve the prior implementation commit and all experiment evidence. Record the baseline and current unrelated changes.
2. Restore the oracle runtime prohibition first and retain its failing test against the current implementation.
3. Remove the generator, API computation/field, feature flag, frontend panels and extra auditor detail request. Remove feature-specific tests and experiment entry points whose implementation is retired; historical reproduction uses commit dd099b7. Preserve existing LLM/detail/authorization behavior.
4. Update the plan, design and traceability to mark counterfactual explanations withdrawn. Keep historical results labelled as such.
5. Run the backend and frontend suites plus syntax checks. Check dependency and frontend request paths, compare the live LLM detail before and after, restart only the backend and verify the real website.
6. Record checks, limits and the whole-component removal as an ablation in a new run, table and iteration report. No new model, new Fabric request/decision/grant, testbed rerun or end-to-end latency claim. Commit only this removal.

## Completion

The runtime oracle guard first failed against the feature and passes after removal. Backend: 319 passed. Frontend: 77 passed, syntax passed. Eleven live API checks passed, including exact preservation of the original LLM account and decision. The auditor decision-log page displays the LLM reason and no counterfactual panel. Prior evidence and removed source snapshots are retained. See iteration 071 for scope, limitations and reproduction.
