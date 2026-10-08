# Iteration 073 — step 15 integration scripts

Date: 2026-10-08. Author order: proceed only after the Android connection gate.
That gate passed in iteration 072. Plan:
`experiments/plans/20261008_mobile_connection_then_step15.md`.
Evidence: `experiments/runs/20261008_step15/`; comparison table:
`results/tables/20261008_step15_verification.csv`.

## What changed

1. Updated acceptance for request justification digests, signed recommendation
   commitment, off-chain integrity and derived-agreement lifecycle. Privacy
   checks allow committed values/hashes and reject explanation/note payload.
   A bounded current-host smoke explicitly denies its synthetic request and
   verifies no reusable authorization was created. The full runner retains
   NOT EXERCISED for missing model-dependent prerequisites. A failed stale-facts
   scenario restores its sealed fixture; the model-offline backend skips normal
   expiry/recovery workers and is stopped if startup fails.
2. Replaced testbed plaintext review-file reads with authenticated batched
   preparation-status polling (maximum 50 IDs), followed by an authorized review
   read. Pending and signed states wait through ledger commitment. Late or
   failed responses do not report readiness. Decisions require verified
   committed recommendation objects; mismatches stop the workflow. Testbed
   preflight waits through commitment, rather than treating model generation as
   completed review. Cleanup fails if requests remain pending.
3. Routed records to independent Audit district heads, and direct Gateway
   utilities to the configured network identity directory. Ledger-only E3 uses
   current request/note digests and explicitly omits the LLM/commitment path;
   full workflows include that additional transaction. Removed review-store
   mounts/legacy flags from load generators. Privileged replay uses existing
   encryption keys and refuses comparisons across model/prompt/policy changes.
4. Added deterministic production chaincode staging with a source digest and
   retention of previous staging directories. Backend staging includes current
   setup/reuse scripts and has a stage-only mode. Seed now registers and activates
   the policy with two different Audit heads and registers the existing signer's
   public key. Compose mounts the private signing-key directory read-only.
5. Replaced ledger inspection with read-only observed channel membership,
   heights, definition, block, cases and decisions. A shared identity directory
   can contain the older AI organization's peer; inspection filters actual DIAS
   members. No AI organization was added to DIAS. No identities were regenerated
   or copied to Android.
6. Updated source deployment label to 3.0 and npm metadata to 3.0.0. **The current
   Mac deployment remains 2.5, sequence 3.** No deployment/reset happened. New
   manifests require observed definition and passing testbed model/adapter
   evidence, fail on unavailable VM commands and retain existing output. Fresh
   finalization requires explicit baseline/proposed evaluation directories;
   E4 uses prompt v2. Historical report/manuscript generators are retained but
   no longer called by v3 finalization because their descriptions refer to the
   September system. Updated setup documentation and preserved all old results.

The original LLM explanation remains the only application explanation. No
counterfactuals or runtime reference-policy oracle were introduced. The oracle
in testbed scripts is offline analysis of recorded verified inputs.

## Verification

| Check | Result | Evidence in this run |
| --- | --- | --- |
| Legacy workflow versus new checks | baseline 0/4 pass; updated 7/7 pass | `baseline-workflow-tests.log`, `script-tests-complete.log` |
| Legacy acceptance versus new checks | baseline 1/2 pass; updated 3/3 pass | `baseline-acceptance-tests.log`, `script-tests-complete.log` |
| All focused script and reuse-plan checks | 25 pass, no failures/skips | `script-tests-complete.log` |
| Manifest retention/observed metadata/adapter guards | 6 pass | `manifest-tests-verified.log` |
| Package regression | 341 chaincode, 319 backend, 27 policy, 77 frontend, 104 dataset; all 868 pass | `regression-tests.log` |
| Syntax | shell, JavaScript and Python pass | `syntax-checks-completed.log` |
| Chaincode source staging twice | identical SHA-256, production dependencies installed; prior staging retained | `prepare-chaincode.log`, `prepare-chaincode-repeat.log` |
| Backend source staging | passed; image build not run | `backend-staging-final.log` |
| Read-only active ledger inspection | passed: five channel members, observed heights/definition and decision state | `ledger-inspection-final/`, `ledger-inspection-final.log` |
| Bounded current-host workflow | 4 scenarios, 17/17 checks pass; request denied and no reusable grant | `live-smoke-final/acceptance.json` |
| Repository publication size check | fails on retained pre-existing 69.8 MiB September raw transaction log | `repository-check.log` |

The first live smoke passed 11/13 checks but failed its privacy checker because
it classified `offChainVerification.justification` metadata as ledger data.
The checker now excludes both backend-added off-chain sections and still
rejects plaintext inside actual ledger fields; its regression test verifies
that distinction. The corrected and strengthened live runs are retained beside
that failure. An initial inspection tried an organization absent from DIAS;
its partial evidence is retained, and final inspection uses observed membership.

Three bounded live runs raised synthetic `insp.rathore` annotate requests and
closed them with FORCE_DENY. Normal authenticated reads appended normal access
logs. Case/record contents, existing grants, keys, model and network were
preserved. These runs exercised mechanics using the already running **untuned**
Qwen3-14B model; they do not validate V7 quality or LLM explanation correctness.
No end-to-end latency improvement or research performance result is claimed.

The source-staging tree is disposable deployment cache, retained locally and
ignored from Git; its source digest and execution logs are versioned. Older
mobile/host edits remain outside the step 15 source commit. The worktree backend
count includes their six mobile unit checks. A full exported staged-index source snapshot, excluding those mobile edits,
passed 862 package checks (backend 313) and all 25 script checks using the already
installed dependencies: `clean-index-full-tests.log` and
`clean-index-script-tests.log`. This verifies source isolation, not a new
dependency installation. The first limited export missed a required network
script; that failing harness log is retained as `clean-index-tests.log`. No
source change was needed to correct the export.

## Worked, weak and next

Worked: both transport gate paths, current schemas in scripts, encrypted review
handling, verified commitments, read-only network observations and bounded live
closure. Weak or not run: four-VM backend image build, policy/key seed, deployment,
full R1–R14 acceptance on fresh v3 fixtures, current-model baseline/proposed
accuracy and load/fault/stability experiments. Python analysis dependencies are
still step 19 work. Preserving the old raw log leaves the publication size check
failing; it was not deleted to make a check pass.

Next is step 16: build/deploy the prepared v3 source on the isolated research
network, configure and verify the actual served model and keys, run full
acceptance and the required negative/release checks. Then step 17 reruns affected
experiments and ablations. The current portal/emulator remains on its preserved
Mac host. Commands and required environment inputs are in `testbed/README.md`.
