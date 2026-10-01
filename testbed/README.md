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
- Contract `diasrecords` 2.3: the working-copy contract that commits the LLM
  recommendation value (ALLOW/DENY/UNAVAILABLE) with the auditor decision and
  derives the agreement on-chain; justification and reason text stay off-chain.

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
docker --context lima-dias-m4 run --rm --network diasnet -v ~/dias-testbed:/testbed \
  hyperledger/fabric-tools:2.5.16 bash /testbed/scripts/deploy-cc.sh
# 4. users (20 base + 100 load users), backend image, ledger seed
node testbed/load/plan.js            # users + pre-registered request plans
docker --context lima-dias-m4 run --rm --network diasnet -v ~/dias-testbed:/testbed \
  hyperledger/fabric-ca:1.5.22 bash /testbed/scripts/register-users.sh
testbed/scripts/build-backend.sh
docker --context lima-dias-m4 compose -f ~/dias-testbed/compose/m4.json up -d prometheus cadvisor-m4 node-exporter-m4
docker --context lima-dias-m4 compose -f ~/dias-testbed/compose/m4.json run --rm --no-deps \
  -e DIAS_TRACE_FILE= dias-backend node testbed/seed/seed-ledger.js
# 5. model server on the Mac (V7), backend on M4, smoke test
HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/mlx_lm.server --model mlx-community/Qwen3-14B-4bit \
  --adapter-path LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7 \
  --host 127.0.0.1 --port 8081 --max-tokens 512 --chat-template-args '{"enable_thinking":false}'
docker --context lima-dias-m4 compose -f ~/dias-testbed/compose/m4.json up -d dias-backend
docker --context lima-dias-m4 run --rm --network diasnet -v dias-backend-data:/data:ro \
  dias-backend:testbed node testbed/load/smoke.js
```

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
