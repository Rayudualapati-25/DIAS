# Iteration 065 — justification commitment h_J and browser hashing

- **Date:** 2026-10-02
- **Plan step:** 9. The hashing module was committed before step 5; `h_M` and `h_N` follow with steps 10 and 11.
- **Requirement:** M04

## What changed

- **Contract:** `CreateAccessRequest` now requires `justificationHash` (64 lowercase hex characters).
  - It stores the hash with the request and in the submission event.
  - The justification text never reaches the ledger.
- **Backend:**
  - `parseAccessRequest` computes `h_J` over the exact text received (domain `justification`); a text with an unpaired surrogate is refused;
  - the review store keeps `h_J`;
  - the worker refuses to prompt the model with a justification that no longer matches `h_J` (`justification_hash_mismatch`).
- **Browser:** `frontend/js/shared/commitments.js` implements the same rule. Its SHA-256 is plain JavaScript, because Web Crypto is missing on the testbed's plain-HTTP origin.
  - After a submission, the request screen recomputes `h_J` from the text the requester sent and confirms it matches the ledger, or warns that it does not.

## Tests

- **Contract:** 2 new tests, both failing before the change: the digest is stored and the text is not; a missing or malformed digest is refused.
  - **Replaced expectation:** "writes the LLM recommendation value but none of its reasoning or provenance" asserted that the word "justification" never appears on the ledger.
  - Under v3, the ledger holds `justificationHash` by design. The test now asserts that the digest is present and that the text, the reason code and clause lists are absent.
- **Backend:** route test for the computed digest; worker test for a changed justification.
  - One worker fixture had committed a different justification from the one it stored. The new check caught it; the fixture now matches.
- **Browser:** 4 tests.
  - The standard SHA-256 vectors (including a 1,000-byte input);
  - every shared vector, including the shell-computed digests;
  - agreement with the contract implementation on generated text and objects;
  - change detection and malformed digests.
  - Plus the fingerprint view test.
- **Suites:** chaincode 290 passing (92.98%); backend 234 passing; frontend 45/45.

## What is weak

- `h_J` proves that the text the backend stored is the text it committed. It does not prove the backend committed what the requester typed. The browser check covers that only for the requester's own screen, and only while the backend's response is honest about the ledger value.

## Next

Step 10: the pre-review recommendation commitment κ.
