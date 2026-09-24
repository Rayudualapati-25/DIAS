# Security Policy

## Research prototype status

DIAS is not production software and has not received a formal security audit. The repository uses synthetic data for demonstration and research evaluation.

## Sensitive material

Do not commit:

- Fabric CA material, MSP folders, private keys, wallets, or generated certificates.
- Local agency-vault files, the off-chain review store (`backend/data/dias-reviews/`), or database files.
- `.env` files, API keys, tokens, or machine-specific connection profiles.
- Real crime, victim, witness, suspect, court, or police operational data.

The `.gitignore` file blocks the common generated paths, but contributors remain responsible for checking every change before publication.

Run `make repo-check` before every commit. Production startup requires an
explicit `JWT_SECRET`, and browser access is limited to the single origin in
`CORS_ORIGIN`. The predictable CA enrollment passwords in the network seed
scripts are disposable local-demo fixtures; never reuse them or expose the
sample CAs outside an isolated synthetic environment.

## Dependency status

Backend and chaincode production dependency audits currently pass. The pinned
Caliper 0.7.1 benchmark toolchain has known transitive advisories and must stay
isolated from untrusted traffic. CI reports those advisories and rejects any
critical finding. The evidence, affected chains, and mitigation decision are
recorded in `reports/security/npm-audit-2026-08-26.md`.

## Reporting issues

For a public GitHub repository, use a private security advisory when the issue could expose secrets, bypass access policy, leak protected records, or weaken audit integrity. For normal prototype bugs, open a regular issue with reproduction steps and avoid including sensitive data.

## Supported scope

Security fixes are accepted for the current prototype code, local demo network, benchmark scripts, and paper artifact provenance. Production deployment hardening is future work unless a dedicated deployment plan and threat model are added.
