# Attempt 1 — harness defects, kept as evidence

Result: 11/14 scenarios passed, 62/77 checks. The three non-passing scenarios
were caused by the acceptance harness, not by DIAS:

1. **R2 and R14 (false positive).** The "ledger holds no LLM data" check searched
   the ledger trail JSON for the words `recommendation|justification|provenance|
   attestation|llm-decider`. Every trail contains the field name
   `provenanceSource` ("Hyperledger Fabric world state and key history"), which
   matched `provenance`. A manual inspection of request REQ-91d034e8fe30e5d9 found
   that field to be the only match. The check now matches LLM field names exactly
   (`recommendation…`, `reasonCode`, `policyRefs`, `reviewFlags`,
   `missingEvidence`, `provenance`, `attestation…`, `justification…`) and the
   retired `llm-decider` identity.
2. **R8 (not exercised).** The scenario used only near misses of a cross-district
   request, and the model recommended DENY for all four, so no LLM ALLOW was
   available to override. The scenario now raises a dedicated request the policy
   allows when no near miss received ALLOW.

No DIAS code was changed between attempt 1 and attempt 2.
