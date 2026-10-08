# Step 13 contract redeploy and live verification — 2026-10-08

## Scope and constraints

- The author asked for the contract to be redeployed and for every test that is needed to confirm the system works as intended.
- Redeploy `diasrecords` on `diaschannel` with the step 13 visibility rules. Nothing else on the network changes: no `make up`, no `make down`, no reseeding, no new identities, and `crimechannel` is not touched.
- The ledger is kept. The upgrade is a new chaincode definition (next sequence) over the same state.
- Identities are the ones the running network already uses (`seal-live-run-20261003/network`), reached through a temporary symlink layout as on 2026-10-06. No certificate or key is copied.
- Synthetic demo identities and records only.

## Steps

1. Record the committed definition, the installed packages and the channel height before the change.
2. Apply the findings of the security review to the contract before deploying, so that one deployment is enough.
3. Deploy with `network/scripts/deployCC.sh diaschannel diasrecords 2.4 auto` (`ORG_SET=dias`).
   - Version label 2.4: 2.2 is the label on this channel and 2.3 is the label of the code evaluated on the testbed. The final v3 label is set in plan step 15.
4. Confirm the committed definition (version, sequence, five approvals) and that every peer answers a query from the new contract.
5. Run the automated suites: chaincode, backend, frontend, policies, dataset.
6. Run the live checks:
   - `experiments/check-step13-live.js`: what the requesting officer reads before and after a denial, who is refused, the reduced and full decision log, record history and evidence, the reuse path without the LLM, and the encrypted store;
   - `experiments/check-dias-host.js`: the v3 workflow from request to authorized metadata.
7. Check the screens in the browser: request access (denied and allowed), auditor review, decision log, access log.

## Evidence

`experiments/runs/20261008_step13_redeploy/`: definition before and after, the deploy log, suite logs, the live check results, and a summary. Failed attempts are kept.

## Limits

- One machine. Nothing is run on the four-VM testbed.
- The model is the untuned base model that the host serves. No accuracy claim is made.
- The live checks write requests, decisions and one dynamic authorization (revoked again) for demo identities.
