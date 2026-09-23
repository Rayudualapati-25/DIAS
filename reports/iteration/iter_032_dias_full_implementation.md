# Iteration 032 — Complete DIAS functional implementation

Date: 2026-09-10

## Objective

Complete the pivot to DIAS: make Qwen advisory, give the auditor final authority
on every dynamic-policy miss, create a reusable rule only for
`Qwen DENY -> auditor FORCE_ALLOW`, auto-grant later exact matches without Qwen
or an auditor, retain complete Fabric evidence, and preserve functional
identity-bound data sharing.

## Outcome

The complete vertical slice is implemented on
`feature/dias-dynamic-access-policy`.

- Every miss creates a requester-signed request, an AIOrg-signed advisory
  recommendation, and an AuditMSP-signed final decision.
- The retired direct-LLM transaction rejects all callers and cannot create a
  grant or denial.
- Only the denial-override transition creates a versioned dynamic rule.
- A fresh exact request recomputes 21 governed fields and, on a current active
  match, writes a new identity-bound `ALLOW` with Qwen and the auditor skipped.
- Rules are visible, attributed, historically queryable, and revocable. The
  latest blockchain state controls lookup.
- Protected metadata and the full PDF workflow require a final `ALLOW`; another
  Fabric identity cannot reuse the decision.
- The auditor popup displays the username, full request model, private query and
  hash verification, Qwen evidence, exact fingerprint, and both force actions.
- Audit reconstruction now joins requests, recommendations, auditor decisions,
  final decisions, releases, and related rule histories.

## Verification evidence

The consolidated record is
`experiments/runs/20260910_dias_full_verification/verification.json`; the table
is `results/tables/dias_full_verification.csv`.

| Check | Result |
|---|---:|
| Chaincode full suite | 211 passed, 0 failed |
| Chaincode coverage | 91.14% statements, 82.90% branches, 92.12% functions, 92.53% lines |
| Backend full suite | 111 passed, 0 failed |
| Live API subset | 16 passed, 0 failed |
| Frontend tests | 11 passed, 0 failed; syntax check passed |
| Workflow comparison assertions | 27 scenarios passed |
| Clean six-org live DIAS acceptance | 9 stages passed |
| Repository/Compose/shell checks | passed |
| Browser QA | requester + auditor journey at 375, 768, and 1440 widths; no console warning/error or horizontal document overflow |

The live trace is
`experiments/runs/20260910_dias_live_fabric/verification.json`. It proves a
live Qwen `DENY`, auditor `FORCE_ALLOW`, rule creation, protected metadata
release, same-properties automatic grant with `llmInvoked=false`, a one-field
purpose miss, force denial without a rule, audit reconstruction, revocation,
and post-revocation fallback to Qwen/auditor.

## Baseline, proposed path, and ablations

The deterministic designed replay contains 27 requests: one seed override, five
exact repeats, and 21 one-field near misses. Results are in
`experiments/runs/20260910_dias_workflow_comparison/metrics.json`.

| Variant | Qwen calls | Auditor reviews | Correct automatic grants | False automatic grants |
|---|---:|---:|---:|---:|
| Baseline: no dynamic policy | 27 | 27 | 0 | 0 |
| DIAS exact rule | 22 | 22 | 5 | 0 |
| Rule creation disabled | 27 | 27 | 0 | 0 |
| Lookup disabled | 27 | 27 | 0 | 0 |

On this deliberately replay-heavy set, DIAS avoids 5 of 27 Qwen/auditor calls
(18.52%). This is a workflow count, not observed latency or model accuracy and
must not be generalized to operational traffic.

Each of the 21 fingerprint-dimension omission ablations produced one unsafe
false automatic match in the constructed corresponding near miss. This result
supports retaining every current field for this test design; it does not prove
the fingerprint is complete for real criminal-justice policy.

## What worked

- The live network confirmed the end-to-end authority split and protected data
  release, not just mocked contract behavior.
- Exact matching safely distinguished all constructed one-field near misses.
- The UI's native dialog exposed a coherent review and keyboard focus behavior
  at mobile, tablet, and desktop breakpoints.
- Existing model registration, attestation, private-query, user governance,
  vault, custody, and integrity mechanisms were reused rather than replaced.

## What failed or remains weak

- Live attempt 1 timed out before the worktree listener was restarted with the
  retained adapter path. The pending request remained recoverable and the runner
  was made resumable. Evidence is retained as `attempt-1-failed.json`.
- Live attempt 2 reached an exact repeat immediately after rule creation while
  the four endorsing peers observed different world-state heights. Fabric
  rejected the pre-submit proposal payload mismatch. The API now retries only
  this specific pre-submit convergence error with bounded exponential backoff;
  unrelated failures are not retried. Evidence is `attempt-2-failed.json`.
- Browser QA did not measure Core Web Vitals or run an automated WCAG contrast
  engine. It did verify labels, accessible controls, keyboard focus, console
  output, responsive views, and document overflow.
- The dynamic rule is an auditor-created exception. This prototype contains no
  second auditor, expiry, usage limit, risk ceiling, or non-overridable denial.
- Usernames and record IDs are visible to channel members by explicit research
  requirement. Production confidentiality is not established.
- The Qwen listener still depends on a large ignored local adapter artifact;
  a clean checkout must supply and activate those bytes separately.

## Interpretation

The evidence supports the narrow claim that the implemented DIAS workflow is
functional on the local six-organization network and can eliminate repeated
model/human workflow calls for exact constructed replays. It does not support
claims of improved decision accuracy, reduced end-to-end latency, legal
compliance, production robustness, or real-world safety.

## Next experiment

Future work should evaluate rule expiry and two-auditor approval against the
current single-auditor design, using a larger traffic distribution with repeat
rates not chosen to favor caching. It should measure end-to-end latency and
unsafe reuse under realistic attribute changes before any performance or safety
claim is drafted.
