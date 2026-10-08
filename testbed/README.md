# DIAS multi-machine testbed (four VMs + the Mac)

This folder builds DIAS on four Linux virtual machines on one Mac, runs the
experiments of `experiments/plans/20260924_multi_vm_experiments_plan.md`, and
analyses them. Nothing here touches the single-host network in `network/` or
the wt-dias CA databases: the testbed has its own VMs, Docker engines,
certificates, CAs, ledger and backend.

## The machines

| Machine | Runs |
|---|---|
| M1 (VM, 3 vCPU, 6 GB) | orderer1, Police peer + CouchDB, Police CA, orderer CA |
| M2 (VM, 3 vCPU, 6 GB) | orderer2, Forensics and Prosecution peers + CouchDBs and CAs |
| M3 (VM, 3 vCPU, 6 GB) | orderer3, Court and Audit peers + CouchDBs and CAs |
| M4 (VM, 3 vCPU, 6 GB) | DIAS backend, load generators, Prometheus |
| M5 (the Mac) | MLX model server with the V7 adapter (Apple GPU) |

- VMs: Lima 2.1.4, `template:docker-rootful`, Ubuntu 26.04 (arm64), Docker 29.8.1.
- VM-to-VM network: Lima `user-v2` (no admin rights needed); VMs reach the Mac
  at `host.lima.internal` (192.168.104.2).
- Docker Swarm joins the four Docker engines; every container is attached to
  the overlay network `diasnet` and reaches the others by host name.
- Every VM runs cAdvisor (CPU and memory of each container) and node-exporter
  (whole VM); Prometheus on M4 scrapes them and all Fabric operations
  endpoints every 5 s. The Mac is sampled by `monitor/mac_sampler.py`.
- Fabric 2.5.16, CA 1.5.22, CouchDB 3.4.2; three Raft orderers; block settings
  identical to the single-host network (2 s batch timeout, 10 messages).
- Current source label: `diasrecords` 3.0 (npm package 3.0.0). The contract
  commits the signed recommendation before review, then derives agreement when
  the auditor decides. Justification, recommendation and note digests bind the
  encrypted off-chain objects. Earlier research results used older contracts.
  The Mac portal still runs 2.5, sequence 3; step 15 does not redeploy it.

## Build (in order)

```bash
# 1. four VMs, one at a time
for m in m1 m2 m3 m4; do
  limactl start --name=dias-$m --cpus=3 --memory=6 --disk=40 --network=lima:user-v2 \
    --mount-only "$HOME/dias-testbed:w" --tty=false template:docker-rootful
  docker context create lima-dias-$m --docker "host=unix://$HOME/.lima/dias-$m/sock/docker.sock"
done
# 2. Swarm + overlay (M1 is the manager)
docker --context lima-dias-m1 swarm init --advertise-addr <m1-ip> --listen-addr <m1-ip>:2377
docker --context lima-dias-m<n> swarm join --advertise-addr <mn-ip> --token <token> <m1-ip>:2377
docker --context lima-dias-m1 network create --driver overlay --attachable \
  --opt com.docker.network.driver.mtu=1400 --subnet 10.20.0.0/16 diasnet
# 3. compose files, CAs, identities, nodes
python3 testbed/scripts/render_compose.py && rsync -a testbed/{config,compose,scripts,monitor} ~/dias-testbed/
# start the CAs, copy each CA's ca-cert.pem to ~/dias-testbed/organizations/fabric-ca/<ca>/, then:
docker --context lima-dias-m1 run --rm --network diasnet -v ~/dias-testbed:/testbed \
  hyperledger/fabric-ca:1.5.22 bash /testbed/scripts/enroll-orgs.sh
# start everything on M1-M3 (docker compose -f ~/dias-testbed/compose/mN.json up -d), then:
docker --context lima-dias-m1 run --rm --network diasnet -v ~/dias-testbed:/testbed \
  hyperledger/fabric-tools:2.5.16 bash /testbed/scripts/channel.sh
testbed/scripts/prepare-chaincode.sh
# A fresh channel uses sequence 1. An upgrade requires the next sequence from
# querycommitted and a new version label; never overwrite an earlier package.
docker --context lima-dias-m4 run --rm --network diasnet -v ~/dias-testbed:/testbed \
  hyperledger/fabric-tools:2.5.16 bash /testbed/scripts/deploy-cc.sh
# 4. users (20 base + 100 load users), backend image, ledger seed
node testbed/load/plan.js            # users + pre-registered request plans
docker --context lima-dias-m4 run --rm --network diasnet -v ~/dias-testbed:/testbed \
  hyperledger/fabric-ca:1.5.22 bash /testbed/scripts/register-users.sh
# Configure ~/dias-testbed/backend.env and the existing operator-managed keys
# as described below before seeding or starting the backend.
testbed/scripts/build-backend.sh
docker --context lima-dias-m4 compose -f ~/dias-testbed/compose/m4.json up -d prometheus cadvisor-m4 node-exporter-m4
docker --context lima-dias-m4 compose -f ~/dias-testbed/compose/m4.json run --rm --no-deps \
  -e DIAS_TRACE_FILE= dias-backend node testbed/seed/seed-ledger.js
# 5. model server on the Mac (V7), backend on M4, smoke test
HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/mlx_lm.server --model mlx-community/Qwen3-14B-4bit \
  --adapter-path LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7 \
  --host 127.0.0.1 --port 8081 --max-tokens 512 --chat-template-args '{"enable_thinking":false}'
docker --context lima-dias-m4 compose -f ~/dias-testbed/compose/m4.json up -d dias-backend
V7_SHA="$(shasum -a 256 LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7/adapters.safetensors | cut -d' ' -f1)"
SMOKE="smoke-$(date -u +%Y%m%dT%H%M%SZ)"
docker --context lima-dias-m4 run --rm --network diasnet -v ~/dias-testbed/results:/results \
  dias-backend:testbed node testbed/load/smoke.js \
  --expected-adapter-hash "$V7_SHA" --out "/results/${SMOKE}/smoke.json"
```

## Step 15 setup and verification

The Android connection gate passed before these scripts were updated. Script
tests, source staging, read-only ledger inspection and one bounded Mac API
workflow passed; four-VM build, deployment and research reruns remain pending.
See [iteration 073](../reports/iteration/iter_073_step15_integration.md).

The backend needs an existing Ed25519 signing key at
`~/dias-testbed/keys/recommender.pem`, mounted read-only at
`/run/dias-keys/recommender.pem`. On a **fresh** testbed, generate it with
`node scripts/dias/recommender-key.js --out ~/dias-testbed/keys/recommender.pem`
and create the review encryption settings with
`node scripts/dias/review-store-key.js --append ~/dias-testbed/backend.env`.
On an existing testbed retain those keys, earlier decryption keys and review
data. Never replace keys to fix a connection failure.

Configure the private `backend.env` with `CHANNEL=diaschannel`,
`CHAINCODE=diasrecords`, a private `JWT_SECRET`, `DIAS_MODEL_URL` pointing to the
Mac endpoint reachable **from M4**, `DIAS_REVIEW_STORE_DIR=/data/dias-reviews`,
`DIAS_RECOMMENDER_SIGNING_KEY_FILE=/run/dias-keys/recommender.pem`, the review
key settings, and `DIAS_TRACE_FILE=/data/trace/backend-trace.jsonl`. For V7 also
set `DIAS_MODEL_ID`, `DIAS_ADAPTER_ID` and `DIAS_ADAPTER_HASH` to the actual
served model and adapter digest. Defaults describe the untuned model. A Mac
loopback health check alone does not establish VM reachability: the smoke run
must return verified recommendations with the expected adapter digest.

The ledger seed now registers the policy with `sp.north`, activates it with
the different Audit identity `cfo.north`, and registers only the signer's public
key. Load generators use authenticated, batched status polling, wait through
signing and commitment, and open encrypted reviews through the backend once.
They no longer mount the review database or accept `--review-dir`. Replay is a
separate privileged process with the existing encryption settings and keys;
it refuses comparison across different model, policy or prompt provenance.

E3 is an explicit ledger-only baseline. It submits current request/note digests,
does not call an LLM or produce a recommendation commitment, and closes requests
with `NO_RECOMMENDATION`. E5–E7 include the recommendation commitment. Compare
their stages with this distinction recorded, rather than treating the write
sets as identical.

For evidence collection, supply fresh `querycommitted --output json` from the
testbed channel and the passing four-workflow smoke JSON. Set `RUNDIR` to a new
run directory and `CHAINCODE_DEFINITION` and `MODEL_EVIDENCE` to those files
before `finalize.sh`. Also supply `BASELINE_RUN` and `PROPOSED_RUN` from fresh
prompt-v2 evaluations; the finalizer requires them to avoid silently using the
September prompt-v1 predictions. The manifest records the observed version/sequence and
model provenance; it no longer invents them from a fixed label. Archived
September results must remain unchanged. A full R1–R14 acceptance run and the
step 16 checks are required before step 17 research experiments. The finalizer
retains structured summaries and figures. Historical report/manuscript
generators remain available for archived reproduction and are not called by
the v3 finalizer; the manuscript is separate step 18 work.

## Experiments

| Id | What | Script |
|---|---|---|
| E1/E2 | Recommendation quality and adversarial test, recomputed from raw predictions | `analysis/accuracy.py` |
| E3 | Ledger alone: each contract function at 10/25/50/75/100 in flight | `load/run-ledger.js`, `analysis/analyze_e3.py` |
| E4 | LLM alone: the 600 test cases, one at a time, on the served model | `experiments/dias-finetuning/v2/eval/evaluate.js`, `analysis/analyze_e4.py` |
| E5 | Whole system at 10/25/50/75/100 simultaneous users, 3 repetitions | `load/run-burst.js`, `analysis/analyze_e5.py` |
| E6 | One hour, 100 users, random arrivals (6/min) | `load/run-steady.js`, `analysis/analyze_e6.py` |
| E7 | Raft leader orderer, then a peer, stopped during a 12-minute run | `scripts/run_fault_test.py`, `analysis/analyze_e7.py` |

Every request of E5, E6 and E7 is fixed in advance by a seeded plan
(`load/generated/`), with the written policy's answer for it; the load
generators check the ledger's committed facts against the plan. The automated
auditor follows the model's recommendation as soon as it is ready, so the times
contain no human review time.

## Limits to state in the paper

- The four VMs and the model server share one Apple M3 Max (16 cores, 64 GB);
  the network between VMs is virtual (Lima user-v2), not a physical LAN.
- One model server and one recommendation worker: the LLM sets the workflow
  throughput.
- All data (users, cases, records, requests) is synthetic.
- The shared single-host network of the wt-dias project kept running in the
  background (about 0.2 of one CPU core); it was not stopped.
