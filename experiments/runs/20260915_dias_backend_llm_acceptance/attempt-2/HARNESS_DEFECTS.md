# Attempt 2 — one harness assumption, kept as evidence

Result: 13/14 scenarios passed, 80/81 checks.

The only failing check was in R9: "renewed authorization with an expiry" expected
the renewed authorization to be generation 2. Attempt 1 had already created
generations 1 and 2 for the same exact scope (insp.singh · REC-FIR-001 ·
CASE-2026-001 · view · investigation) on this ledger, so attempt 2's first
authorization was generation 3 and the renewal was generation 4 — the chaincode
incremented the generation correctly. The rest of R9 passed: the repeat before
expiry was granted automatically and the repeat after expiry returned to review
as EXPIRED.

The check now expects the renewal to be exactly one generation after the revoked
authorization. No DIAS code was changed between attempt 2 and attempt 3.
