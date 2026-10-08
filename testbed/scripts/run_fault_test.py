#!/usr/bin/env python3
"""E7: keep the workflow running while machines' services fail.

Twelve minutes of random arrivals (fault-plan.json) run through the normal
backend. Three minutes in, the current Raft leader orderer is stopped; at six
minutes it is started again and the Court peer is stopped; at nine minutes the
Court peer is started again. Every action is timed. Afterwards the script
checks that all five peers hold the same ledger height and block hash.

Whatever happens, every orderer and peer is started again before the script
exits, so a failed test never leaves the network degraded for the next one.
Exit codes: 0 every check passed; 1 the test could not start; 2 the test ran
but something failed (listed under "problems" in fault-timeline.json).

Usage: python3 run_fault_test.py --out <results dir on the Mac> --run-name <name>
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

PROM = "http://127.0.0.1:19090/api/v1/query?query="
MACHINE_OF = {"orderer1": "m1", "orderer2": "m2", "orderer3": "m3"}
FABRIC_CONTAINERS = [
    ("m1", "orderer1.example.com"), ("m2", "orderer2.example.com"), ("m3", "orderer3.example.com"),
    ("m1", "peer0.police.example.com"), ("m2", "peer0.forensics.example.com"),
    ("m2", "peer0.prosecution.example.com"), ("m3", "peer0.court.example.com"), ("m3", "peer0.audit.example.com"),
]
SETTLE_S = 30
SIGN_IN_LIMIT_S = 300
# Twelve minutes of arrivals, the settle time, and the load generator's one-hour limit per workflow.
RUN_LIMIT_S = 12 * 60 + SETTLE_S + 3600 + 300
CONVERGE_TRIES = 6
PHASES = [(180, "stop_leader"), (360, "restart_leader_stop_court_peer"), (540, "restart_court_peer")]


def docker(machine, *args):
    result = subprocess.run(["docker", "--context", f"lima-dias-{machine}", *args], capture_output=True, text=True)
    return result.returncode, (result.stdout + result.stderr).strip()


def prom_query(expr):
    with urllib.request.urlopen(PROM + urllib.parse.quote(expr), timeout=30) as response:
        return json.loads(response.read())["data"]["result"]


def raft_leader():
    for row in prom_query('consensus_etcdraft_is_leader{channel="diaschannel"}'):
        if row["value"][1] == "1":
            return row["metric"]["node"]
    return None


def ledger_heights():
    """Block height per peer (by organisation) and per orderer (by node)."""
    heights = {}
    for row in prom_query('ledger_blockchain_height{channel="diaschannel"}'):
        metric = row["metric"]
        heights[metric.get("org") or metric.get("node") or metric["instance"]] = int(float(row["value"][1]))
    return heights


PEERS = [("police", "PoliceMSP", 7051), ("forensics", "ForensicsMSP", 8051), ("prosecution", "ProsecutionMSP", 9051),
         ("court", "CourtMSP", 10051), ("audit", "AuditMSP", 11051)]


def chain_info():
    """Height and current block hash as each peer reports it (peer channel getinfo)."""
    info = {}
    for org, msp, port in PEERS:
        tb = "/testbed/organizations/peerOrganizations"
        env = [
            "-e", "CORE_PEER_TLS_ENABLED=true", "-e", f"CORE_PEER_LOCALMSPID={msp}",
            "-e", f"CORE_PEER_TLS_ROOTCERT_FILE={tb}/{org}.example.com/tlsca/tlsca.{org}.example.com-cert.pem",
            "-e", f"CORE_PEER_MSPCONFIGPATH={tb}/{org}.example.com/users/Admin@{org}.example.com/msp",
            "-e", f"CORE_PEER_ADDRESS=peer0.{org}.example.com:{port}", "-e", "FABRIC_CFG_PATH=/testbed/config",
        ]
        code, out = docker("m4", "run", "--rm", "--network", "diasnet", "-v", "/Users/venkatrayudu/dias-testbed:/testbed",
                           *env, "hyperledger/fabric-tools:2.5.16", "peer", "channel", "getinfo", "-c", "diaschannel")
        match = re.search(r"Blockchain info: (\{.*?\})", out)
        try:
            info[org] = json.loads(match.group(1)) if match else {"error": out[-300:]}
        except json.JSONDecodeError:
            info[org] = {"error": out[-300:]}
    return info


def wait_for_settling():
    """Return once the load generator has signed in; fail if it exits or stalls."""
    deadline = time.time() + SIGN_IN_LIMIT_S
    while time.time() < deadline:
        _, logs = docker("m4", "logs", "loadgen-e7")
        if "settling" in logs:
            return
        _, state = docker("m4", "inspect", "-f", "{{.State.Status}}", "loadgen-e7")
        if state.strip() == "exited":
            raise RuntimeError(f"the load generator exited before settling: {logs[-300:]}")
        time.sleep(0.5)
    raise RuntimeError("the load generator did not finish signing in")


def inject_faults(leader, t0, mark, problems):
    leader_container = f"{leader}.example.com"
    steps_of = {
        "stop_leader": [("stop", MACHINE_OF[leader], leader_container)],
        "restart_leader_stop_court_peer": [("start", MACHINE_OF[leader], leader_container),
                                           ("stop", "m3", "peer0.court.example.com")],
        "restart_court_peer": [("start", "m3", "peer0.court.example.com")],
    }
    for offset, action in PHASES:
        time.sleep(max(0, t0 + offset - time.time()))
        for verb, machine, container in steps_of[action]:
            code, out = docker(machine, verb, container)
            mark("stopped" if verb == "stop" else "started", container=container, code=code)
            if code != 0:
                problems.append(f"docker {verb} {container} failed: {out[-200:]}")
        time.sleep(12)  # let Raft elect and Prometheus scrape before reading the leader
        mark("raft_leader_now", node=raft_leader())


def wait_for_exit(mark, problems):
    deadline = time.time() + RUN_LIMIT_S
    while time.time() < deadline:
        _, state = docker("m4", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", "loadgen-e7")
        status, _, exit_code = state.strip().partition(" ")
        if status == "exited":
            mark("load_finished", exit_code=exit_code)
            if exit_code != "0":
                problems.append(f"the load generator exited with code {exit_code}")
            return
        time.sleep(5)
    raise RuntimeError("the load generator did not finish in time")


def check_convergence(mark, problems):
    """All peers and orderers at one height, and all peers on the same block hash."""
    for attempt in range(1, CONVERGE_TRIES + 1):
        time.sleep(20 if attempt == 1 else 10)
        heights = ledger_heights()
        if len(set(heights.values())) == 1:
            break
    equal = len(set(heights.values())) == 1
    mark("ledger_heights_after", heights=heights, all_equal=equal, attempts=attempt)
    if not equal:
        problems.append("ledger heights still differ after the test")
    mark("raft_leader_after", node=raft_leader())
    info = chain_info()
    hashes = {org: value.get("currentBlockHash") for org, value in info.items()}
    same = len(set(hashes.values())) == 1 and None not in hashes.values()
    mark("chain_info_after", info=info, same_hash=same)
    if not same:
        problems.append("the peers report different current block hashes")


def restore(mark, problems):
    """Start every orderer and peer again; starting a running container changes nothing."""
    for machine, container in FABRIC_CONTAINERS:
        code, out = docker(machine, "start", container)
        if code != 0:
            problems.append(f"could not start {container}: {out[-200:]}")
    time.sleep(5)
    running = {container: docker(machine, "inspect", "-f", "{{.State.Running}}", container)[1] == "true"
               for machine, container in FABRIC_CONTAINERS}
    mark("network_restored", running=running)
    if not all(running.values()):
        problems.append("not every orderer and peer is running after the test")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--run-name", required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    timeline = []
    problems = []

    def mark(event, **fields):
        entry = {"event": event, "epoch_s": time.time(), **fields}
        timeline.append(entry)
        print(json.dumps(entry), flush=True)

    leader = raft_leader()
    mark("raft_leader_before", node=leader)
    if leader not in MACHINE_OF:
        print(f"no Raft leader found (got {leader!r}); the test was not started", file=sys.stderr)
        return 1
    code, cid = docker("m4", "run", "-d", "--name", "loadgen-e7", "--network", "diasnet",
                       "-v", "/Users/venkatrayudu/dias-testbed/results:/results",
                       "dias-backend:testbed", "node", "testbed/load/run-steady.js",
                       "--url", "http://dias-backend:3001/api",
                       "--out", f"/results/{args.run_name}", "--plan", "fault-plan.json",
                       "--label", "E7 fault test", "--phase", "fault", "--settle", str(SETTLE_S * 1000))
    if code != 0:
        print(cid, file=sys.stderr)
        return 1
    try:
        wait_for_settling()
        t0 = time.time() + SETTLE_S
        mark("load_start_estimated", t0=t0)
        inject_faults(leader, t0, mark, problems)
        wait_for_exit(mark, problems)
        check_convergence(mark, problems)
    except Exception as error:  # recorded as a problem; the network is restored below
        problems.append(f"{type(error).__name__}: {error}")
        mark("error", detail=problems[-1])
        docker("m4", "stop", "loadgen-e7")
    finally:
        restore(mark, problems)
        _, logs = docker("m4", "logs", "loadgen-e7")
        with open(os.path.join(args.out, "loadgen.log"), "w") as handle:
            handle.write(logs)
        docker("m4", "rm", "loadgen-e7")
        mark("problems", items=problems)
        with open(os.path.join(args.out, "fault-timeline.json"), "w") as handle:
            json.dump(timeline, handle, indent=2)
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
