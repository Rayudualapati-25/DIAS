# DIAS: Dynamic and Explainable Access Control for Blockchain-enabled Inter-organizational Data Sharing

DIAS is a research prototype for sharing case files between five criminal-justice
organizations (police, forensics, prosecution, court and an audit office) on a
permissioned Hyperledger Fabric network. When an officer asks for a case file, a
language model gives advice (ALLOW or DENY), but an auditor makes the final
decision. Every request, the advice and the decision are recorded on the ledger.

All data in this repository is synthetic. It is a research prototype, not a
police system.

Authors: Alapati Venkat Rayudu and Tirthankar Sengupta, Department of Computer
Science and Engineering, SRM University-AP (see `CITATION.cff`).

## How a request works

1. An officer asks for a case file: which file, what operation (view, export or
   annotate), for what purpose, and a short reason.
2. The chaincode records the request with the officer's verified attributes
   (role, station, district, clearance, case assignments). In the same
   transaction it checks whether an active *reusable authorization* exists for
   exactly this officer, file, operation and purpose.
   - If one exists, the request is granted at once. No model and no auditor are needed.
3. Otherwise the backend sends the request and the written policy to the model
   (Qwen3-14B, 4-bit, served locally). The model answers ALLOW or DENY with a
   reason code and the policy clauses it used.
4. The backend signs this recommendation and commits its hash to the ledger
   *before* the auditor sees it, so it cannot be changed afterwards.
5. An auditor (a district head of the audit organization) reviews the request
   and the advice and records FORCE_ALLOW or FORCE_DENY. The chaincode itself
   works out whether the auditor agreed with the committed advice.
6. If the auditor grants a request that the model advised to deny, the chaincode
   creates a reusable authorization for exactly that scope. It can be revoked
   at any time and can have an expiry date.
7. The officer sees the outcome. After a denial the officer can also read the
   model's explanation; before the decision nothing from the model is shown.

```text
officer (web portal or phone)
  -> backend (Node.js, Fabric Gateway, signs as the logged-in officer)
     -> chaincode: record request + check reusable authorization (same transaction)
        match    -> GRANTED, done
        no match -> backend asks the LLM -> signed advice, hash committed on the ledger
                 -> auditor decides (web portal or phone) -> decision, agreement and outcome
                    committed in one transaction
  -> access log on the ledger: who asked for which file, the advice, the decision
```

## Who can see what

- Every officer with an active credential can read the access log: who asked for
  which case file, what the model recommended and what the auditor decided.
- While a request is still waiting, its advice is shown only to reviewers (audit,
  court and prosecution heads), never to the officer who made the request.
- Officers outside the reviewers do not get transaction ids or the hashes used
  by the authorization check.
- The requester's free-text reason, the model's explanation and the auditor's
  note stay off the ledger, in an encrypted store in the backend
  (AES-256-GCM). Only their hashes go on the ledger.
- The log of searches and reads (who opened what) is for reviewers only.

## Components

| Folder | What it is |
| --- | --- |
| `chaincode/crimerecords` | Fabric chaincode `diasrecords` 3.1 (Node.js): access requests, auditor decisions, reusable authorizations, records, users, audit trail |
| `backend` | Node.js/Express API on port 3001: sign-in, Fabric Gateway, the model call, signing, encrypted review store, access logging |
| `frontend` | Web portal (plain JavaScript modules) served by the backend |
| `mobile/android` | Android app (Kotlin): sign-in, request access, auditor decisions, access log, case summaries |
| `policies` | The written governance policy and a reference implementation used to check the model offline |
| `docs` | The policy as readable text (generated from the bundle by `policies/tools/render-policy-spec.js`) and its open questions |
| `network` | Fabric network configuration and scripts (five organizations on `diaschannel`) |
| `experiments` | Experiment scripts, the fine-tuning data and evaluation, and all run outputs (`experiments/runs`) |
| `testbed` | Four-VM testbed setup and its analysis scripts |
| `results` | Result tables (CSV) and figures |

## Requirements

- macOS on Apple Silicon (the model runs with MLX), Docker or Colima
- Node.js 22, Python 3.11+
- Hyperledger Fabric 2.5 binaries and images in `../fabric-samples`
- `.venv-qwen-policy` with `mlx-lm` for the model server
- Android Studio (for the phone app)

## Running the prototype

```bash
cp .env.example .env      # set JWT_SECRET and the review store key
make install
make all                  # Fabric network, identities, diaschannel, chaincode, seed data
make dias-model           # Qwen3-14B on port 8081 (DIAS_ADAPTER=<folder> for the fine-tuned V7)
make dias-backend         # API and web portal on http://localhost:3001
```

Open `http://localhost:3001` and sign in as a seeded officer such as
`insp.sharma` (requests access) or `sp.north` (auditor). The demo sign-in picks
a Fabric identity held by the server; there are no passwords.

The phone app: open `mobile/android` in Android Studio and run it on an
emulator. It reaches the Mac at `http://10.0.2.2:3001`.

## Tests

```bash
make test                                   # chaincode, backend, policies, frontend, dataset
node --test experiments/e2e/*.test.js       # experiment scripts
cd mobile/android && ./gradlew :app:testDebugUnitTest
```

The Android screen tests run on an emulator with
`adb shell am instrument -w org.dias.mobile.dev.test/androidx.test.runner.AndroidJUnitRunner`.

## Dataset

The model was trained and tested on a synthetic dataset: no real case or officer
data is used. Every label comes from a rule program, not from a person or a model.

- **Rules.** The written governance policy has 11 clauses: active credential,
  allowed purpose, role permission (two clauses), sealed record, juvenile record,
  victim data, jurisdiction, case assignment, clearance, and a default ALLOW. The
  first DENY clause that applies decides. The source is
  `policies/dias-governance-policy-v1.json`; the readable version is
  `docs/policies/governance-policy-specification.md`.
- **Labels.** `policies/reference-oracle/referencePolicyOracle.js` applies these
  clauses to each generated request and gives ALLOW or DENY, a reason code and the
  clauses used. Auditor decisions are never used as labels.
- **Generator.** `experiments/dias-finetuning/v2/generate.js` builds the requests
  (officer, record and request facts plus a free-text reason) from a fixed seed
  (20260912), so `make dias-data` writes the same files again. `make dias-data-check`
  runs 25 checks, for example that every label matches the oracle and that no case
  family appears in more than one split.
- **Files.** `experiments/dias-finetuning/data-v2-binary/`: 8,013 cases in total,
  5,254 for training, 400 for validation and six test sets. `manifest.json` lists
  every set with its hash and composition.
- **The 600 test cases** are `test-decision-balanced.jsonl`: 300 ALLOW and 300 DENY.
  They cover clean ALLOWs (161), single violations (103), several violations (88),
  near misses at a rule boundary (133) and reasons that try to mislead the model,
  either with an instruction or with a false claim (115).
- **Not yet done.** `human-review-sample.csv` holds 161 cases selected for manual
  checking. Nobody has reviewed them yet, so the dataset must not be described as
  human-checked.

## Experiments of 14 October 2026

All runs are in `experiments/runs/20261014_mac_mobile_setups/` (raw rows, logs,
CPU/memory samples, run summaries). The result tables are in `results/tables/`
(files starting with `20261014_setups_`) and the figures in
`results/plots/dias-setups/`.

### Setup

- One Mac (Apple Silicon, 64 GB) running the whole Fabric network (five
  organizations, 2 s block timeout, 10 transactions per block), the backend and
  the model server.
- Two models: the untuned Qwen3-14B (4-bit) and our fine-tuned V7 adapter, both
  with the same prompt. Every test was run once with each model on the same
  planned requests.
- Two Android emulators with identical settings: one for the officer and one for
  the auditor. (An older emulator was not used: it added about 0.5 s to every new
  network connection, see `phones/idle-probe-*.json`.)
- "Mac" means the calls the web portal makes, sent from a script. "Phone" means
  the real app screen on the emulator, driven by an instrumented test. Officer and
  auditor can each be on the Mac or the phone, which gives four combinations:
  Mac only, phone only, and two mixed ones.
- The auditor is a script that follows the committed advice, so there is no
  human thinking time in any number.

### What was measured

1. **Step times** – 96 requests per model, one at a time, 24 in each combination,
   same mix of files, operations and purposes in each. Before every timed ledger
   write the script waits until the backend has finished writing its own log
   events, so writes do not share a block by accident.
2. **Reusable authorization** – 12 requests that the policy denies. The auditor
   overrides the model's DENY, the same request is sent 3 more times, then a
   near miss (other purpose), then the authorization is revoked and the request
   is sent once more.
3. **Bursts** – 5, 10, 25 and 100 requests sent at the same moment, for Mac only,
   phone only and mixed.
4. **One hour with 100 officers** – 100 new officers were registered on the
   network (copies of the existing officer profiles). They sent 200 requests at
   random moments over one hour, read their outcomes, and every 30 s one of them
   read the access log. CPU and memory of every part were sampled every 5 s.
5. **Model quality** – 600 balanced test cases (`test-decision-balanced`),
   compared with the written policy.

Every request in every test was checked on the ledger afterwards (decision,
auditor, outcome, agreement with the committed advice, one transaction).

### Results

Correctness: all 96 + 96 step requests, 144 reuse requests, 480 burst requests
(5/10/25), 600 burst requests (100), and 400 hour requests were decided and
verified on the ledger. One run failed and was repeated (see below).

**Time from request to confirmed decision (median of 96 requests per model; for
the untuned model, of the 93 requests that got usable advice)**

| Setup | Untuned | V7 |
| --- | --- | --- |
| Mac only | 13.19 s | 14.15 s |
| Phone only | 13.32 s | 14.37 s |
| Officer Mac, auditor phone | 13.20 s | 14.29 s |
| Officer phone, auditor Mac | 13.28 s | 14.02 s |

- The setups do not differ significantly: phone only minus Mac only is +0.12 s
  (95% CI −0.34 to +0.38 s) for the untuned model and +0.23 s (−0.34 to +0.60 s)
  for V7.
- The phone makes the auditor's own steps about 0.06 s slower (untuned: +62 ms,
  95% CI 51–70 ms) and the officer's request about 0.01 s slower.
- Most of the time is the model (about 6.9 s untuned, 7.8 s V7) and three ledger
  writes of about 2.1 s each. V7 is 0.94 s slower per request (95% CI
  0.64–1.13 s) even though it writes fewer tokens.

**Reusable authorization**

| | Untuned | V7 |
| --- | --- | --- |
| First request (model + auditor) | 14.06 s | 14.16 s |
| Repeated request (granted at once) | 2.10 s | 2.10 s |
| Time saved | 85.1 % | 85.2 % |
| Repeats granted at once | 36 / 36 | 36 / 36 |
| Near misses or revoked scopes granted | 0 / 24 | 0 / 24 |

**Many requests at once (time until the last one was decided, mean of 2 runs)**

| Requests | Untuned | V7 |
| --- | --- | --- |
| 5 | 50–51 s | 56–58 s |
| 10 | 95–97 s | 104–107 s |
| 25 | 228–251 s | 252–282 s |
| 100 (one run per setup) | 890–998 s | 959–1085 s |

The model handles one request at a time (about 9–11 s each), so the system
decides between 5.3 and 6.7 requests per minute in every setup. After the advice is ready
the auditor's decision is committed about 2.2–2.6 s later. With 100 requests at
once, 95 % of the requests themselves were committed within 1.2 s (blocks fill up
at 10 transactions).

**One hour, 100 officers, 200 requests**

| | Untuned | V7 |
| --- | --- | --- |
| Verified | 200 / 200 | 200 / 200 |
| Request to decision, median | 13.4 s | 15.0 s |
| 95th percentile | 40.7 s | 44.9 s |
| Access log read (100 entries), median | 0.29 s | 0.39 s |

In the busiest 10 minutes (50 requests) the median rose to 22.6 s (untuned) and
23.8 s (V7) because of the model queue. Average CPU over the hour (one core = 100 %): Fabric peers about
16–17 %, CouchDB 11–13 %, chaincode 1 %, orderer under 1 %, backend about 1 %. The
model server used about 8.1 GiB of memory; its GPU use was not sampled.

**Model quality (600 test cases)**

| | Untuned | V7 |
| --- | --- | --- |
| Valid answers | 541 | 600 |
| Accuracy (of valid answers) | 65.1 % (95% CI 61.0–69.0) | 97.3 % (95.7–98.4) |
| Macro F1 | 0.623 | 0.973 |
| Wrongly ALLOW (of 270 or 300 DENY cases) | 21 | 7 |
| Wrongly DENY | 168 | 9 |

In the live step test V7's advice matched the written policy for 92 of 96
requests (untuned: 87 of 93 with usable advice), but V7 recommended ALLOW where
the policy says DENY 4 times (untuned 2). The auditor makes the final decision
in every case.

### The failed run

The first try of the untuned bursts of 100 failed: the script asked the backend
for the status of 100 requests in one call, but the backend allows at most 50, so
no request was decided during the burst. The script closed the leftovers and the
campaign stopped. The run is kept in
`experiments/runs/20261014_mac_mobile_setups/untuned/bursts100-failed-status-limit/`
with a `FAILURE.txt`. After fixing the script (status in groups of 50) the bursts
were run again from the start; only the repeated run is used above.

### Running the experiments again

```bash
node experiments/e2e/setup-plan.js 20261014 plan.json          # the plan of the step/reuse/load tests
node experiments/e2e/setup-steps.js --plan plan.json --out OUT --staging backend/data/dias-reviews/<store>/access-events
node experiments/e2e/setup-reuse.js --plan plan.json --out OUT --staging ...
node experiments/e2e/setup-load.js  --plan plan.json --out OUT --staging ...
node experiments/e2e/plan100.js 2026101400 plan-100.json        # the 100-user plan
node experiments/e2e/setup-hour.js  --plan plan-100.json --out OUT --staging ...
node experiments/e2e/setup-analyze.js --run RUN --plan plan.json --tables results/tables --date DATE --label MODEL
python3 experiments/e2e/setup_figures.py RUNS results/plots/dias-setups
```

`run-campaign.sh` and `run-campaign-100.sh` in the run folder show the exact
order used, including the model switches.

## Earlier evidence

Earlier runs are kept under `experiments/runs/` with their raw data, for example
the four-VM testbed (`20260924_testbed_multivm`), the cross-dataset test
(`20260924_cross_dataset`), the 100-user reuse test (`20260925_reuse_100_users`)
and the model training and evaluation runs from September 2026.

## Limitations

- Everything runs on one Mac: one Fabric network with one orderer, the backend
  and the model. This says nothing about fault tolerance or several sites. (An
  earlier four-VM test is in `experiments/runs/20260924_testbed_multivm/`.)
- The phones are emulators on the same Mac, not real phones on a real network.
  In the 100-user tests the officers are scripts that send the portal's or the
  app's calls; only the auditor uses a real app screen.
- The auditor in the experiments is a script. Real auditors would take longer.
- The model answers one request at a time, which limits the system to about 5–7
  decisions per minute on this machine.
- V7 still gives some unsafe ALLOW advice (7 of 300 DENY test cases); the human
  auditor is the safeguard.
- Demo sign-in selects a server-held Fabric identity; there are no user-held keys.
- Member organizations can read every block from their own peers; the
  visibility rules control what the API and the contract return, not what a
  peer stores.
- The data and the governance policy are synthetic.

## License

Apache License 2.0, see `LICENSE`.
