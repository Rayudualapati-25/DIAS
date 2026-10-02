# Iteration 062 — access-log policy defined and measured

- **Date:** 2026-10-02
- **Plan step:** 6
- **Requirement:** I04

## What changed

- **Classes:** every API route now has a named action, and every action a logging class (`ACTION_CLASS` in `backend/src/middleware/accessLogger.js`):
  - sensitive reads: always logged;
  - calls that submit their own transaction: logged only when refused or failed;
  - routine reads: logged only when refused or failed.
- **Fallback:** an unclassified action is treated as sensitive.
- **Modes:** `DIAS_ACCESS_LOG_MODE`:
  - `security` (default);
  - `all` (v2 behavior, for comparison runs);
  - anything else stops the server at start-up.
- **New action names:** user, case, department, custody, decision-log and access-log-verify routes. Before, these were logged under a generic path.
- **Target fields:** only identifier-shaped body values are copied into the new targets.

## Tests

- `backend/test/accessLogger.unit.test.js`: 7 new tests, which failed before the change.
  - Route names, identifier-only targets, class of every action, security-mode rules, all-mode rules, mode parsing.
  - A coverage test checks that every mounted route maps to a classified action.
- Backend suite: 224 passing.

## Evidence

`experiments/runs/20261002_v3_access_log_policy/`, replaying the HTTP calls recorded in the two testbed traces through the classifier.

- **Validation:**
  - every recorded log write pairs with its call;
  - four calls without a write are the auditor reads made during the orderer failover.
- **Result:**
  - access-log writes fall from 5,610 to 2,939 (multi-VM runs) and from 6,490 to 2,072 (reuse run);
  - v2 access-log writes were 67.7% and 59.5% of all ledger transactions;
  - each one waited about 2 s for its block.
- **Overlap:** the reuse trace turned out to be cumulative (it contains the multi-VM trace). The replay cuts it at the end of the multi-VM trace.

## What is weak

- The replay counts writes; it does not re-measure throughput. A live run with each mode is NOT RUN, because it needs the testbed.
- The call mix comes from scripted clients.

## Next

Step 7: pending-request expiry, cancellation and late decisions.
