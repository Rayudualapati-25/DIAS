# Portal workflow review — 2026-10-12

## Requested behavior

Authenticated users discover case-file entries, submit an access request, and
receive access only from an auditor decision or an exact matching reusable
authorization. A reusable authorization must bypass the model and new review.
Otherwise the backend automatically invokes the LLM, commits its signed
recommendation, and makes it available to the authorized auditor. The requester
sees the final decision after commitment. Requests, recommendations, decisions,
outcomes and authorization checks/reuse must be reconstructable on Fabric.

The author clarified that Search itself submits the scoped request and starts
the recommendation workflow. The same form collects operation, purpose and
reason. A search identifying several files requires selecting one target;
it must not submit undisclosed requests for every match. Evidence identifiers
resolve to their parent record, which is the existing authorization scope.
Discovery does not by itself release protected file contents.

## Review and validation

1. Inventory runtime entry points and distinguish legacy/offline utilities.
2. Review identity, discovery, submission, recommendation, review, outcome,
   reusable authorization, release, logging and native mobile paths.
3. Capture existing source state and run baseline package tests.
4. Write regression tests for defects, then implement the smallest fixes.
5. Compare baseline and changed behavior using deterministic workflow fixtures;
   exercise normal recommendation, automatic reuse, denial, unavailable model,
   unauthorized review, decision visibility, and blockchain log failure.
6. Run changed package suites and syntax checks. Run bounded host checks only
   if existing services/identities are available; retain all evidence and state
   limitations. A development-host upgrade may add the reviewed read APIs after
   offline verification; preserve its channel, records, identities and prior
   definition. Do not reset a network or train/activate a model. Four-VM research
   deployment and evaluation remain steps 16–17.
7. Record findings, fixes, remaining gaps and a comparison table in iteration
   reports/results. Preserve older mobile edits and previous evidence.

No accuracy, latency or four-VM performance claim follows from these checks.
This task reviews/fixes the existing workflow; it does not introduce a model.

## Recorded outcome

Completed the bounded portal workflow review and fixes. Iteration 074 records
baseline 868 checks, changed worktree 890 checks, isolated staged source 884
checks, 25 script checks and 21 live checks, all passing in final runs. Failed
verification attempts remain retained. The existing Mac definition was upgraded
to 3.0/sequence 4 without reset. Native Android workflow parity and four-VM
research experiments remain pending; no quality or latency result is claimed.

Report: `reports/iteration/iter_074_portal_workflow_review.md`.
Comparison: `results/tables/20261012_portal_workflow_review.csv`.
