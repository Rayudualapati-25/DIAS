# Iteration 064 — governed policy versions and policy binding

- **Date:** 2026-10-02
- **Plan step:** 8. The canonical hashing it uses was committed earlier (step 9 foundation).
- **Requirements:** M05, M06, M17, M20, and the policy part of M15

## What changed

- **Registry:** `lib/dias/policyRegistry.js` and four GovernanceContract transactions:
  - `RegisterPolicyVersion(policyVersion, policyHash, bundleId)`;
  - `ActivatePolicyVersion` — a different active district head from the registrant (D-02); the previous version is retired for good;
  - `GetActivePolicy`, `QueryPolicyVersions`.
  - The ledger holds the version and the v3 digest, never the policy text.
- **Binding:** requests bind the active policy when they are created. No request is accepted while no policy is active (`DIAS_NO_ACTIVE_POLICY`).
  - The decision, the outcome, the access-decision index and the authorization carry `{policyVersion, policyHash}`.
- **Decisions:** refused under a retired policy (`DIAS_STALE_POLICY`) or on a request of an older schema (`DIAS_LEGACY_RECORD`).
  - `ExpirePendingRequest` may close such a request at once (basis `POLICY_VERSION_CHANGED`).
- **Authorizations:** schema `dias-dynamic-authorization-v3`.
  - Under another active policy, matching reports `POLICY_CHANGED` and leaves the authorization's own status unchanged (paper §IV-F).
  - Re-issuing under the new policy supersedes the old generation.
  - Older-schema authorizations never match.
- **Release** (every path through `_requireCurrentGrantBasis`) needs a policy binding equal to the active policy, for reviewed and reused grants alike.
- **Backend:**
  - `policyRegistration.js` and `scripts/dias/register-policy.js` register and activate the repository policy with two identities; safe to rerun; a conflicting digest is an error;
  - `make seed-policy` is part of `dias-seed`;
  - a decision refused for a stale policy closes the request.

## Tests

- **Written first:** `diasPolicyBinding.test.js`, 13 tests. Covers:
  - registry, two-person rule, no re-activation, duplicate and malformed input, authority;
  - no active policy; binding on every record;
  - stale decision and expiry; reuse and reissue after a change;
  - release of reviewed and reused grants after a change; records without a binding;
  - the test world's digest equals the repository policy's digest.
- **Fixture updates (behavior unchanged):**
  - `diasAuthorization.test.js` passes the now-required policy to the pure functions, plus 3 new policy cases;
  - `recordContract.test.js`: hand-built grants carry a policy binding and their state holds an active policy.
- **Suites:** chaincode 287 passing (92.8% statements); backend 233 passing (registration and stale-policy tests).

## What is weak

- Activation needs two district heads, but the backend holds both keys in this prototype. The control binds the ledger state, not two people.
- `make seed-policy` and the testbed seed were changed but NOT RUN, because they write to a network.

## Next

Steps 9–12: commit `h_J` with the request, add the pre-review commitment κ, enforce the note commitment, and sign the recommendation provenance.
