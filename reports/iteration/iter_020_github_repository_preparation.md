# Iteration 020 — GitHub Repository Preparation

**Date:** 2026-08-26  
**Scope:** Public repository hygiene, reproducibility, CI, and security defaults.  
**Paper status:** Frozen; no manuscript, figure, result, or measurement was edited.

## What worked

- Initialized the repository on `main` and defined a 30.0 MiB publication
  surface containing source, documentation, retained evidence, and the frozen
  Overleaf source package.
- Excluded Fabric MSP/private-key material, agency-vault data, local databases,
  dependency folders, coverage state, and paper verification builds without
  deleting them from the workstation.
- Added Apache-2.0 licensing, citation metadata, contribution/security guides,
  issue and pull-request templates, Dependabot, and a publication-boundary
  checker.
- Pinned Fabric peer/orderer images to 2.5.16 and Fabric CA to 1.5.22 while
  preserving environment overrides and the caller's Docker context.
- Hardened production JWT configuration, CORS origin handling, and dynamically
  registered Fabric CA enrollment secrets.
- Added offline GitHub Actions jobs for repository checks, chaincode coverage,
  backend unit/security tests, and Caliper validation.

## Verification evidence

| Check | Observed result |
| --- | --- |
| `python3 scripts/check-repository.py` | 1023 files; 30.0 MiB; passed |
| `make check` | publication boundary, both Compose files, and shell syntax passed |
| Chaincode `npm test` | 92 passing; 94.15% statements; 87.37% branches |
| Backend `npm run test:unit` | 25 passing |
| Caliper `npm run check` | installation, 14 configurations, helpers, scripts, and plot axes passed |
| Backend production audit | 0 vulnerabilities |
| Chaincode production audit | 0 vulnerabilities |

## What remains weak

- The full backend API and smoke suites require the live seeded Fabric network;
  they were not rerun during this repository-only pass.
- The pinned Caliper 0.7.1 tree has 7 high, 2 moderate, and 5 low transitive
  advisories. The containment decision is recorded in
  `reports/security/npm-audit-2026-08-26.md`.
- GitHub branch protection and the first hosted Actions run cannot be configured
  until a remote repository exists.

## Next refinement

1. Create the remote repository without auto-generating replacement files.
2. Push `main`, confirm all four CI jobs, and enable required status checks.
3. Run the live integration/smoke suite on a disposable seeded network before a
   tagged release.
4. Evaluate a compatible Caliper dependency update in a separate experiment;
   do not alter historical result artifacts.
