# Plan: redo the Experiments and Results on several machines (2026-09-24)

Status: completed on 2026-09-25. The retained multi-VM run, raw evidence,
analysis, figures, manifest, and results draft are in
`experiments/runs/20260924_testbed_multivm/`. The outcome and limitations are
recorded in `reports/iteration/iter_054_dias_multi_vm_remaining_experiments.md`.

This plan answers the author's seven points of 2026-09-24. It builds on
`20260923_professor_review_results_plan.md` (the professor's notes, the
existing results and the reuse-sweep fixes) and does not repeat it.

Inputs:
- The professor's notes (IMG_2618–IMG_2622, printed draft pages 9–11).
- `Proof reading/sections/Results.tex` (current Results section).
- The code: `network/compose/`, `backend/src/`, `experiments/dias/run-concurrent-users.js`,
  `benchmarks/caliper/`.
- Local PDFs in `papers/reference_library/` and a web search (sources at the end).

---

## 0. The author's seven points, as experiment requirements

1. Run DIAS as several machines on this Mac, not one Docker host, and record CPU
   and memory for every machine and every container while the tests run.
2. Time every component of the system, not only the whole workflow.
3. Graphs must show fixed values (real units and counts), not custom percentages.
4. Accuracy must be computed from the raw predictions and explained in plain
   words: what it means, why the test was run, and why the paper reports it.
5. User levels: 10, 25, 50, 75 and 100 (100 is the headline level).
6. Report latency and throughput for the whole system and for each component.
7. First find papers that did these experiments: which paper, which experiment,
   why, and whether it matches points 1–6 (section 1).

---

## 1. What the papers did, why, and which of the author's points they match

### 1.1 The professor's group (follow these first)

1. **InterSnap** (IEEE Trans. Services Computing, arXiv 2511.16560; the
   "auditable snapshot" paper in his note)
   - Did:
     - Testbed: 4 lab PCs (Intel i5-4570, 8 GB, Ubuntu 18.04), 3 AWS EC2
       instances and 1 private-cloud VM, joined into one Docker Swarm overlay
       network; Fabric 2.4 with 512 KB blocks.
     - A subsection "Test bed Set up and Data Preparation".
     - Latency and throughput (snapshots per minute) at ledger heights 1K–20K;
       time against payload size.
     - Overhead against Fabric's own snapshot feature (about 0.2 s).
     - A one-hour "resilience test" of all parts together: about 900
       transactions, 99.33% success per component, fewer than 10 failures
       (network timeouts, data errors).
     - Fig. 14: CPU and memory of every machine (CPU 30–65% with brief spikes
       to 95%; memory 30–70%).
     - Every graph is closed with its trend: "does not deviate much",
       "steady", "near-linear".
   - Why: to show the system works across separate machines and networks, adds
     little overhead, and runs for an hour without resource strain.
   - Matches: point 1 (exactly, per machine), point 6 (latency + throughput),
     point 3 (fixed ledger heights). It shows CPU/memory per machine, not per
     container.

2. **ReAcct** (IEEE BRAINS 2025, same group)
   - Did:
     - Lab i5 PCs (8 GB, Ubuntu 22.04) and VirtualBox VMs (4 vCPU, 8 GB).
     - Each operation timed on its own: saving private data, signature
       generation, signature verification, hash generation and validation,
       IPFS save and query.
     - Users from 10 to 500; minimum, average and maximum time; box plots.
     - Every trend described as linear.
     - Its extra cost on top of the base framework (Cacti): under 6 s.
   - Why: to show each building block scales with users, and the add-on cost
     is small.
   - Matches: point 2 (component times), point 5 (users starting at 10),
     point 6 (latency). No CPU/memory graph.

3. **AVChain** (ACM Distributed Ledger Technologies, May 2026, same group)
   - Did:
     - Each role on its own server: a GPU server (simulator + clients), a
       Fabric + IPFS server, a second IPFS server, and a web server that was
       left out of the measurements.
     - Fig. 10 "Components of query execution time": Fabric query time, IPFS
       retrieval time and decompression time for each data type.
     - Concurrency plotted on a log-scale axis.
   - Why: to show which part of a query costs the most time.
   - Matches: point 2 (the component graph the professor asked for), point 1
     (separate servers).

4. **SBTLF** (IEEE Trans. Privacy 2024, same group)
   - Did:
     - A subsection "Model Architecture and Dataset Preparation".
     - "Some of the parameters are kept fixed while varying the rest."
     - A memory-consumption figure against the number of clients.
     - States openly that all nodes ran on the same machine.
   - Why: to isolate the effect of one parameter at a time, and to be honest
     about the setup.
   - Matches: point 3 (fixed values), the dataset-preparation note, and the
     honesty wording for point 1.

### 1.2 The closest systems to DIAS (LLM, access control, Fabric)

5. **Jan et al., agentic AI monitored by Fabric** (ICCA 2025, arXiv 2512.20985)
   - Did:
     - Time per component: perception 180–250 ms, LLM reasoning 900–1200 ms,
       blockchain verification 350–450 ms, execution 120–200 ms; total 1.82 s
       over 50 trials, 95% interval [1.78, 1.86] s.
     - With and without blockchain: 1.42 s vs 1.82 s (+0.40 s); throughput
       about 55 vs 45 per second (−18%).
     - Counted unsafe actions blocked: 14 with blockchain, 0 without.
     - Fabric with three peers and one orderer; hardware not reported.
   - Why: to show what the blockchain costs and what safety it buys.
   - Matches: points 2 and 6 (the closest template: LLM + Fabric, per-component
     latency and throughput), point 4 (a plain safety count). Weak on point 1.

6. **LACE** (Cheng et al. 2025, arXiv 2505.23835; cited as Cheng2025)
   - Did:
     - Research questions first (RQ1–RQ4); every experiment answers one.
     - 1,000 labelled allow/deny requests over 500 policies.
     - Six LLMs compared with accuracy, precision, recall, F1, Cohen's kappa
       and latency.
     - Scalability: policy library 50–500, concurrent requests 1–10.
     - Component split under load: LLM decision time grows from about 3.3 s
       (1 request) to 18.8 s (10 requests) and is over 85% of the total, so
       the paper names it the bottleneck; policy matching and decision
       checking stay small.
     - One Apple M1 Pro laptop.
   - Why: to answer "how accurate", "how fast" and "how does it scale" with
     one experiment each.
   - Matches: point 2 and 6 (component split under load), point 4 (metrics
     tied to questions), point 5 (partly: only 1–10). Not point 1.

7. **LLMAC** (Zisad 2026, arXiv 2602.09392; cited as Zisad2026)
   - Did:
     - Mistral-7B fine-tuned with LoRA on synthetic records (10,000
       generated, 10% used for training).
     - 98.5% accuracy, 99.1% precision, 94.8% recall, 96.8% macro-F1.
     - Compared with RBAC, ABAC and DAC rules (14.5%, 58.5%, 27.5%).
     - A table of accuracy per action.
     - Explains the scores in words: "a balanced ability to approve
       legitimate requests and block unauthorized ones".
   - Why: to show the tuned model beats rule-based models, and what that
     means for users.
   - Matches: point 4 (accuracy in plain words), the dataset description.
     No system tests.

8. **Manavi et al.** (ICCCN 2026, arXiv 2606.13798; cited as Manavi2026)
   - Did:
     - Classifier: accuracy, precision, recall, F1, AUROC, AUPRC, and
       confusion matrices for validation and test (the "CM" in the notes).
     - A testbed table: 3 organizations × 2 peers, CouchDB, TLS, Raft, 1 s
       batch timeout, 50 messages per block.
     - Confirmation latency split into endorsement, ordering and
       validation/commit.
     - Peer CPU and peak memory as the request rate rises from 2 to 12 per
       second.
     - Three baselines on the same workload.
   - Why: to show the ML part is accurate and the on-chain part adds little
     overhead.
   - Matches: point 2 (Fabric stages), point 4 (confusion matrix), point 1
     (partly: CPU/memory per peer on one testbed), point 3 (fixed Fabric
     settings in a table).

9. **ICBAC** (arXiv 2602.08014, 2026)
   - Did:
     - One Intel i7, 16 GB machine; Fabric 2.5 with 4 peers, 3 orderers and
       2 CAs.
     - Read and write latency and throughput for each contract function at
       nine load levels, 10 to 1,000 concurrent requests.
     - Three older schemes re-implemented on the same Fabric settings.
     - Two-sample t-tests (11 of 12 comparisons not significant).
     - No CPU or memory monitoring.
   - Why: to show the access-control contracts scale like older schemes.
   - Matches: point 5 (levels from 10 upward), points 2 and 6 (per
     function). Not point 1.

### 1.3 Measurement standards (how to define and report the numbers)

10. **Fabric** (Androulaki et al., EuroSys 2018; cited as Androulaki2018)
    - Did: nodes on separate VMs (16 vCPU, 8 GB) with clocks synchronized by
      NTP; one factor at a time (block size, then CPUs 4–32); stage timing of
      block validation to find the bottleneck; throughput reported just below
      saturation.
    - Why: to find which stage limits throughput.
    - Matches: points 1, 2, 3 and 6.

11. **Thakkar et al.** (MASCOTS 2018)
    - Did: a per-phase study of Fabric (endorsement, ordering, validation) to
      find bottlenecks and tune them.
    - Matches: point 2 (Fabric stages).

12. **Hyperledger Blockchain Performance Metrics white paper** (v1.01, 2018)
    - Gives the standard definitions:
      - transaction latency = confirmation time − submit time;
      - read latency = response time − submit time;
      - transaction throughput = committed transactions ÷ total seconds;
      - read throughput = reads ÷ total seconds.
    - Asks every paper to report the consensus, hardware, topology, state
      database, test tool and where times were observed.
    - Matches: point 6 (definitions) and point 1 (what to report).

13. **MLPerf Inference** (Reddi et al., ISCA 2020)
    - Server scenario: requests arrive at random (Poisson) times, and
      throughput is the highest request rate that still meets a latency limit.
    - Matches: point 6 for the LLM component, and the arrival pattern for the
      one-hour test.

14. **Rouhani et al. 2019** (cited as Rouhani2019): Caliper's performance table
    and its resource-consumption table (Caliper's Docker monitor reports each
    container). Matches point 1 (per container), on one machine.

15. **Bansal et al.** (CHI 2021, "Does the Whole Exceed its Parts?"): accuracy
    of the human + AI team, not of the AI alone. This is one reading of the
    professor's "hybrid decision accuracy" (point 4).

16. **Liu et al.** (USENIX Security 2024; cited as Liu2024PI): attack success
    rate for each attack type, plus accuracy without attack. A plain security
    number for point 4.

### 1.4 Does the literature cover each point?

- **Point 1 (several machines, CPU/memory):** yes. InterSnap, AVChain, ReAcct
  and Fabric used separate machines or VMs. InterSnap and Manavi plotted CPU
  and memory. Nobody reported every container on every machine; DIAS would.
- **Point 2 (component time):** yes, strongly. AVChain, ReAcct, Jan, LACE,
  Manavi, Fabric, Thakkar.
- **Point 3 (fixed values):** yes. SBTLF and Fabric change one factor at a
  time; Manavi lists the fixed settings; confusion matrices show counts.
- **Point 4 (accuracy in words):** yes. LLMAC, LACE (questions first), Manavi
  (confusion matrix), Jan (unsafe actions blocked), Liu (attack success),
  Bansal (team accuracy).
- **Point 5 (10–100 users):** yes. ReAcct 10–500, ICBAC 10–1,000, LACE 1–10,
  Manavi 2–12 per second. 100 as the top level is normal for a system that
  calls an LLM.
- **Point 6 (system + component latency and throughput):** yes. Jan, LACE,
  ICBAC, InterSnap; definitions from the Hyperledger white paper and MLPerf.
- **Gap:** no paper found tests an LLM + Fabric system at 100 users with CPU
  and memory per machine and per container. DIAS can fill it, stated honestly
  (the machines are VMs on one Mac).

---

## 2. How to run DIAS on this Mac as several machines (point 1)

### 2.1 Why VMs and not only more containers

- Today every Fabric container runs inside one Colima VM (10 CPUs, 24 GB).
  Splitting it into more containers on that one Docker engine is still one
  machine.
- Four Linux VMs, each with its own kernel, IP address and Docker engine, act
  as four machines. They talk over a network, like InterSnap's machines.
- Docker Swarm joins the four Docker engines, and an overlay network lets a
  container on one VM reach a container on another by name. This is the
  InterSnap recipe (`docker swarm init`, `docker swarm join`,
  `docker network create --driver overlay --attachable`).
- Honest limit: the four VMs share the M3 Max chip. The paper must say so, as
  SBTLF did. Lab PCs remain the stronger option if the professor can lend
  them (plan of 2026-09-23, approach B).

### 2.2 The layout: five "machines"

- **M1 (VM, 3 vCPU, 6 GB):** orderer 1, Police peer + CouchDB, Police CA.
- **M2 (VM, 3 vCPU, 6 GB):** orderer 2, Forensics and Prosecution peers +
  CouchDBs and CAs.
- **M3 (VM, 3 vCPU, 6 GB):** orderer 3, Court and Audit peers + CouchDBs and
  CAs, orderer CA.
- **M4 (VM, 3 vCPU, 6 GB):** DIAS backend (API), load generator, Prometheus.
- **M5 (the Mac itself):** the model server (MLX needs the Mac GPU and cannot
  run inside Docker or a Linux VM).
- Every VM also runs cAdvisor (CPU and memory of each container) and
  node-exporter (CPU and memory of the whole VM).
- Three Raft orderers on three machines: ordering keeps working if one fails.
- Total for the VMs: 12 vCPUs and 24 GB. The Mac has 16 cores and 64 GB; the
  model needs about 10–12 GB.

### 2.3 Keep the shared network safe

- The testbed gets its own directory, certificates, CA databases and Docker
  engines. It never uses `network/organizations` or the wt-dias CA homes.
- The existing Colima VM (the shared wt-dias network) is not modified.
- During measurement runs it should be paused (`colima stop`, later
  `colima start`; containers and ledger volumes are kept) so it does not steal
  CPU and memory. This needs the author's OK.
- Use a path without spaces for the testbed (for example `~/dias-testbed`),
  because "XAI workspace" has a space and VM mounts handle that badly.

### 2.4 Setup, step by step

Step 1. Create four VMs with Docker. Swarm needs rootful Docker, so use the
`docker-rootful` template, and the `user-v2` network, which lets VMs reach
each other without admin rights.

```bash
for m in m1 m2 m3 m4; do
  limactl start --name=dias-$m --cpus=3 --memory=6 --disk=40 \
    --network=lima:user-v2 --tty=false template:docker-rootful
done
limactl list
```

Step 2. Control each VM's Docker from the Mac.

```bash
for m in m1 m2 m3 m4; do
  docker context create lima-dias-$m \
    --docker "host=unix://$HOME/.lima/dias-$m/sock/docker.sock"
done
```

Step 3. Check that the VMs reach each other (not yet verified on this Mac).

```bash
limactl shell dias-m2 -- ping -c 3 lima-dias-m1.internal
limactl shell dias-m1 -- ip -4 addr   # note the user-v2 address of M1
```

- If the ping fails, switch the four VMs to `--network=vzNAT` and test again.

Step 4. Join the four Docker engines into one Swarm and create the overlay
network.

```bash
M1_IP=<user-v2 address of dias-m1>
docker --context lima-dias-m1 swarm init --advertise-addr "$M1_IP"
TOKEN=$(docker --context lima-dias-m1 swarm join-token -q worker)
for m in m2 m3 m4; do
  docker --context lima-dias-$m swarm join --token "$TOKEN" "$M1_IP:2377"
done
docker --context lima-dias-m1 network create --driver overlay --attachable \
  --opt com.docker.network.driver.mtu=1400 diasnet
```

- Fallback if the overlay does not pass traffic: no Swarm; each VM publishes
  its ports, and every container gets `extra_hosts` entries that map the Fabric
  host names to VM addresses.

Step 5. Create fresh identities for the testbed: five organization CAs and an
orderer CA with new databases, three orderers, five peers, and the users with
their role attributes. Reuse the logic of `network/scripts/registerEnroll.sh`
and `seed-identities.sh` with a testbed directory.

Step 6. Start the containers on each VM with its own compose file
(`testbed/compose/m1.yaml` … `m4.yaml`), all attached to `diasnet`. Peers
start chaincode containers on their own VM through that VM's Docker socket.

Step 7. Create `diaschannel` with three Raft consenters, join the five peers,
and deploy `diasrecords` with the MAJORITY endorsement policy (3 of 5). Which
contract version is deployed is a decision (section 8).

Step 8. Seed the testbed ledger: departments, cases, records, the 20 existing
users (12 requesters and 8 authority members), and 100 test users with a fixed
role mix.

Step 9. Start the model on the Mac with fixed settings. Check that a VM reaches
it; Lima normally forwards `host.lima.internal` (192.168.5.2) to the Mac, but
this is not yet tested here.

Step 10. Start the backend as a container on M4. It must read the peer
addresses from settings (a small code change; today they are `localhost:7051`
… in `backend/src/config.js`).

Step 11. Start monitoring (section 2.5), then run one full workflow as a smoke
test and check the ledger entries and the recommendation store.

### 2.5 Recording CPU and memory for every machine and every container

- **Each VM:** cAdvisor gives CPU and memory per container (peers, CouchDBs,
  orderers, CAs, chaincode containers, backend). node-exporter gives the whole
  VM.
- **M4:** Prometheus collects everything every 5 s, plus Fabric's own metrics
  (endorsement, ordering and commit times) from the peer and orderer
  operations ports.
- **Mac (M5):** a small script records the model server's CPU and memory every
  5 s (`ps`). GPU use can be added with `macmon`, which needs no admin rights
  (installing it needs the author's OK).
- **Cross-check:** `docker stats --no-stream` every 5 s on each VM, saved to
  CSV, confirms the cAdvisor numbers.
- **Export:** CSV through the Prometheus API after each run. Plots: one panel
  per machine (InterSnap Fig. 14 style), plus one per-container bar chart per
  user level.
- **Units (point 3):** memory in MB; CPU in cores used (1.0 = one full core),
  so no relative percentages.

### 2.6 What the paper must say about the setup

- Four Linux VMs on one Apple M3 Max (16 cores, 64 GB); vCPUs and memory per
  VM; the model on the host GPU; Docker Swarm overlay.
- Fabric version, 3 Raft orderers, 5 peers, CouchDB, TLS, batch timeout and
  block size, endorsement policy.
- Model, adapter, decoding settings, one model server, one worker.
- Where each time was measured (client, backend or Fabric metrics).
- Limit: the VMs share one chip; the network between them is virtual.

---

## 3. The components and how each is measured (points 2 and 6)

One request goes through these parts:

1. **API (backend):** sign-in check, input checks, reading the verified facts
   from the ledger.
2. **Request commit:** `CreateAccessRequest` → endorsement by 3 of 5 peers →
   ordering (Raft) → validation and commit.
3. **Queue wait:** time waiting for the single recommendation worker.
4. **LLM recommendation:** prompt building, model inference, output checks.
   These three are already timed in the recommender (`latencyMs`).
5. **Auditor decision commit:** `SubmitAuditorDecision`, same Fabric stages.
6. **Access-log write:** every signed-in API call adds one audit transaction
   after the response (`accessLogger.js`). It adds ledger load, so it is
   counted.
7. **Reads:** pending list, decision log, request trail (no ordering).

How each is timed:

- **Latency (seconds):**
  - backend trace for API, queue wait and LLM steps;
  - Fabric stage times two ways: the Gateway client split (endorse, submit,
    commit status) and the peer/orderer metrics in Prometheus.
- **Throughput (fixed units):**
  - Fabric writes: committed transactions per second (TPS);
  - Fabric reads: reads per second;
  - LLM: recommendations per minute and output tokens per second;
  - API: HTTP requests per second;
  - whole system: completed workflows per minute (request → recommendation →
    committed decision).

The component graph:

- Stacked bars, one bar per user level (10, 25, 50, 75, 100), one colour per
  component, seconds on the y-axis, the value printed on each segment.
- A second bar chart shows each component's capacity (TPS, recommendations
  per minute). The whole system cannot be faster than its slowest part; this
  chart shows which part that is.

What the existing data already predicts:

- The LLM does about 7–8 recommendations per minute (7.79 s each).
- A Fabric commit takes about 2 s at low load because of the 2 s block timeout
  (a block closes after 2 s or 10 transactions). At high load blocks fill
  sooner, so commits may get faster. The paper should explain this.
- Queue wait grows in a straight line with the number of simultaneous users.
- So the expected story: Fabric parts stay flat, the queue grows linearly, and
  system throughput stays at the LLM's rate. This answers the professor's
  "which component, how much time" and "how the graph is moving".

---

## 4. The experiments (points 2–6)

Every experiment states the question it answers (as LACE does), what stays
fixed, and what changes.

**E1. Recommendation quality (no new run; recompute from raw predictions)**
- Question: is the model's advice right often enough for an auditor to use it?
- Fixed: 600 held-out cases (300 should be allowed, 300 denied), same prompt,
  policy and decoding. Changes: the model (untuned vs V7).
- Report: counts (section 5), confusion matrices, McNemar test on the paired
  decisions.

**E2. Adversarial test (no new run; recompute)**
- Question: can a requester talk the model into granting access?
- Report: attacks that got through, in counts, by attack type
  (contradictory, injected).

**E3. Ledger capacity per contract function (Caliper, new DIAS workloads)**
- Question: how fast is the blockchain part, and does it limit the system?
- Fixed: the testbed, block settings, endorsement policy.
- Changes: 10, 25, 50, 75, 100 transactions in flight (Caliper `fixed-load`),
  i.e. 10–100 simultaneous clients. Three repetitions.
- Functions: `CreateAccessRequest`, `SubmitAuditorDecision` (writes);
  decision log and request trail (reads).
- Report: p50/p95 latency, TPS, success rate, stage split, CPU/memory per
  container. Template: ICBAC, ReAcct, Manavi.

**E4. LLM capacity alone**
- Question: how many recommendations can one model server give?
- Fixed: model, decoding, one request at a time. Input: the 600 test cases
  (all distinct prompts, so the prompt cache cannot inflate speed).
- Report: time per recommendation (mean, p50, p95), recommendations per
  minute, tokens per second, model-server CPU/memory, and the accuracy of the
  same run (it should equal E1).

**E5. Whole system at 10, 25, 50, 75 and 100 users**
- Question: how does the complete system behave as users grow, and which
  component causes the growth?
- Fixed: the testbed, the model, the same role mix at every level (the
  2026-09-16 run mixed faster and slower roles per level; see the 09-23 plan,
  section 3.1).
- Changes: number of users submitting at the same moment (burst). Three
  repetitions per level; each user sends a distinct request.
- Report: end-to-end p50/p95, the component stacked bars, throughput
  (workflows per minute), success rate, CPU/memory per machine and container,
  and live accuracy (each live recommendation compared with the policy's
  expected answer).
- Warning: with one model server, the 100th request waits about
  100 × 7.8 s ≈ 13 minutes. The load script's 10-minute timeout must be raised.
  This is the true cost of one local model and the component graph will show
  it; it is not a blockchain limit.

**E6. One-hour run with 100 users (InterSnap resilience test)**
- Question: does the system stay stable and within resources for an hour?
- Load: 100 users send requests at random times (Poisson), in total below the
  LLM's rate (for example 6 per minute ≈ 360 per hour), mixed with auditor
  decisions and reads, like normal work.
- Report: successes and failures per transaction type (InterSnap Fig. 13),
  CPU and memory per machine over 60 minutes (Fig. 14), per-container peaks,
  latency over time, and every failure explained.

**Optional**
- E7. Fault test during E6: stop one orderer and one peer; writes should
  continue (Raft keeps a majority, MAJORITY endorsement needs 3 of 5).
- E8. One Docker host against four VMs on the same workload.
- E9. Block timeout 0.5, 1 and 2 s (one factor at a time).
- E10. Two model workers or two model servers (a design change; shows
  whether throughput grows with LLM capacity).

---

## 5. Accuracy in plain words (point 4)

Write every score as a question with a count first, then the percentage in
brackets. Stored values below; recompute from the raw predictions before use.

On the 600 test cases (300 should be allowed, 300 should be denied):

- **Legitimate requests recognised:** "Of 300 requests the policy allows, how
  many did the model recommend allowing?"
  - V7: 298 (2 wrongly refused).
  - Untuned: 70 (204 wrongly refused, 26 unusable answers).
  - Why it matters: a wrong refusal costs an officer time and sends the case to
    the auditor.
- **Illegitimate requests stopped:** "Of 300 requests the policy denies, how
  many did the model recommend denying?"
  - V7: 294 (6 wrongly granted).
  - Untuned: 266 (14 wrongly granted, 20 unusable).
  - Why it matters: a wrong grant is a security risk; this is why the auditor
    keeps the final say.
- **Overall correct:** V7 592 of 600; untuned 336 of 600 (46 answers could not
  be used).
- **Balanced accuracy:** the average of the two rates above (V7 98.67%,
  untuned 60.27%). Why this and not plain accuracy: a model that always says
  DENY would look half right; balanced accuracy exposes it.
- **Usable answers:** "How many answers could the auditor screen show?" V7 600,
  untuned 554.
- **Right reason / right clause:** "How often did the model name the correct
  rule and the exact clause?" Why it matters: the auditor checks the cited
  clause, so a wrong clause misleads the auditor even when the decision is
  right.
- **Adversarial:** "Of 204 requests that should be denied and carried
  manipulative text, how many got through?" V7: 6 of 204.
- **Hybrid decision accuracy (optional, E-hybrid):** accuracy of the final
  decision made by the model and the auditor together (Bansal et al.). Needs a
  simulation of auditor behaviour or a small user study.

In the paper, each subsection starts with the question and ends with what the
number means for an auditor.

---

## 6. Fixed-value graph rules (point 3)

1. The same x-axis levels in every load graph: 10, 25, 50, 75, 100 users.
2. Real units on the y-axis: seconds, transactions per second, workflows per
   minute, MB, cores, or counts such as "of 600". No custom percentage axes.
3. The exact value printed on every bar or point.
4. One factor changes per graph; the fixed settings are stated once in a
   testbed table (Manavi style) and named in the text.
5. Related graphs share the same axis range so they can be compared.
6. Each figure description ends with the trend in one sentence (flat, linear,
   flattening), as InterSnap and ReAcct do.

---

## 7. Code and data changes the testbed needs (each needs the author's OK)

1. Peer addresses from settings in `backend/src/config.js` (today fixed to
   `localhost:7051` … `localhost:11051`).
2. A backend container image (Dockerfile) for M4.
3. Timing log: Fabric stage split in `backend/src/fabric/gateway.js` and queue
   timestamps in `backend/src/dias/recommendationWorker.js`, switched on by a
   setting, written as JSON lines.
4. A 100-user load script (today `run-concurrent-users.js` stops at 12 users
   and reads the review store from local disk).
5. A Poisson one-hour load script.
6. Caliper workloads for the DIAS contract functions (the current ones target
   the SEAL-era `crimerecords`).
7. Testbed compose files, identity scripts, Prometheus configuration, and a
   CSV exporter and plot scripts.
8. A generated 100-user roster with a fixed role mix.

None of these changes the research design (policy, model, prompt, decision
rules).

---

## 8. Decisions for the author

1. May I build the four-VM testbed on this Mac? (About 3 GB of downloads;
   24 GB of RAM while it runs.)
2. May the shared Colima VM be paused during measurement runs?
3. Which model does the testbed serve: V7 (the paper's model; it stays
   unactivated unless you say so) or the untuned base?
4. Which contract version: `diasrecords` 2.2 as in the paper today, or the new
   working copy that also writes the LLM recommendation to the ledger?
5. May I make the changes in section 7?
6. Load pattern: burst only, or burst plus the one-hour random-arrival run?
   (Recommended: both.)
7. Requests in E5/E6: synthetic requests on seeded records (quicker), or
   requests rebuilt from the held-out test cases (closer to the professor's
   "test with this data", more work)?
8. Which optional experiments (E7–E10, hybrid accuracy)?

---

## 9. Time

- Testbed build and smoke test: 2–4 days.
- Scripts (load, Caliper, timing, plots): 1–2 days.
- Machine time: E3 about 1 hour; E4 about 80 minutes; E5 about 35 minutes per
  repetition (260 requests × 7.8 s), so about 2 hours for three; E6 1 hour.
- Graphs and checks: 1 day.

---

## 10. Execution status (2026-09-25, 07:15 IST)

1. Built: the four-VM testbed from section 2, the new contract version, the
   timing trace, the load plans, the recorders and the analyses (`testbed/`).
2. Done: accuracy (E1, E2) recomputed; E5 burst run at 10, 25, 50, 75 and 100
   users (780 measured requests plus 5 warm-up), analysed in
   `experiments/runs/20260924_testbed_multivm/analysis/`.
3. Stopped, not used (each folder in `~/dias-testbed/results/` has an
   `ABORTED.json`; `finalize.sh` counts their ledger requests from it):
   - `e6-steady-20260925T010913Z`: an evaluation script was started by mistake
     during the run.
   - `e6-steady-20260925T012544Z`: stopped at the author's request after 4
     minutes; 3 requests were left open on the ledger.
4. Still to run, in the office (Mac on power and awake, nothing else sent to
   the model server):
   1. `bash testbed/scripts/start_e6.sh`: checks the testbed, closes the 3 open
      requests, starts E6 (about 65 minutes).
   2. `bash testbed/scripts/run_remaining.sh`: replay of the E5 errors, E7, E4,
      E3 and the ledger-size probes (about 3 hours).
   3. `bash testbed/scripts/finalize.sh`: analyses, figures, report, draft.
5. Left switched on: the four VMs with Fabric, the backend, the model server
   and both recorders, so the office run uses the same setup as E5.

---

## Sources

Local PDFs (`papers/reference_library/`): InterSnap, ReAcct, AVChain,
SecureBlockchainFL (SBTLF), Manavi2026, Cheng2025 (LACE), Zisad2026 (LLMAC),
Androulaki2018, Rouhani2019, Mukherjee2020, Paillisse2019, Liu2024PI.

Web (checked 2026-09-24):
- Jan et al.: https://arxiv.org/abs/2512.20985
- ICBAC: https://arxiv.org/abs/2602.08014
- Manavi et al.: https://arxiv.org/abs/2606.13798
- Thakkar et al.: https://www.semanticscholar.org/paper/Performance-Benchmarking-and-Optimizing-Hyperledger-Thakkar-Nathan/e2205ab0e0f1534ec4819f5a2f2f896cb6745e12
- Hyperledger performance metrics: https://www.lfdecentralizedtrust.org/learn/publications/blockchain-performance-metrics
- MLPerf Inference: https://arxiv.org/abs/1911.02549
- Bansal et al.: https://arxiv.org/abs/2006.14779
- Caliper resource monitors: https://hyperledger.github.io/caliper/v0.6.0/caliper-monitors/
- Fabric performance guidance: https://hyperledger-fabric.readthedocs.io/en/latest/performance.html
- Lima networks: https://lima-vm.io/docs/config/network/user-v2/ and https://lima-vm.io/docs/config/network/vmnet/
- InterSnap Swarm setup: https://github.com/mailtisen/InterSnap
