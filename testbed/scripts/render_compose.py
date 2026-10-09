#!/usr/bin/env python3
"""Render one Docker Compose file per testbed VM from a single placement table.

Four Linux VMs act as four machines. Every container joins the attachable
Docker Swarm overlay network `diasnet`, so a container on one VM reaches a
container on another VM by its host name. Nothing is published on the VMs
except the backend API and Prometheus on M4, which keeps the testbed apart
from the shared single-host network on this Mac.

Compose accepts JSON, so the files are written as JSON: no hand-written YAML.
"""

import json
import os
import sys

# Host paths are written as ${HOME}/dias-testbed by default: Docker Compose
# interpolates HOME on the Mac that runs `docker --context ... compose`, and Lima
# mounts the Mac home at the same path inside every VM. Set TB to write a fixed path.
TB = os.environ.get("TB", "${HOME}/dias-testbed")
# The Mac as seen from a VM on Lima's user-v2 network (host.lima.internal).
HOST_GATEWAY = os.environ.get("HOST_GATEWAY", "192.168.104.2")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "compose")

FABRIC = "2.5.16"
FABRIC_CA = "1.5.22"
COUCHDB = "couchdb:3.4.2"
CADVISOR = "gcr.io/cadvisor/cadvisor:v0.49.1"
NODE_EXPORTER = "prom/node-exporter:v1.8.2"
PROMETHEUS = "prom/prometheus:v3.13.1"

# org -> (MSP, peer port, operations port)
ORGS = {
    "police": ("PoliceMSP", 7051, 9444),
    "forensics": ("ForensicsMSP", 8051, 9445),
    "prosecution": ("ProsecutionMSP", 9051, 9446),
    "court": ("CourtMSP", 10051, 9447),
    "audit": ("AuditMSP", 11051, 9448),
}

PLACEMENT = {
    "m1": {"orderer": "orderer1", "orgs": ["police"], "cas": ["orderer", "police"]},
    "m2": {"orderer": "orderer2", "orgs": ["forensics", "prosecution"], "cas": ["forensics", "prosecution"]},
    "m3": {"orderer": "orderer3", "orgs": ["court", "audit"], "cas": ["court", "audit"]},
    "m4": {"orderer": None, "orgs": [], "cas": [], "app": True},
}

NET = ["diasnet"]


def ca_service(name):
    return {
        "image": f"hyperledger/fabric-ca:{FABRIC_CA}",
        "container_name": f"ca-{name}",
        "hostname": f"ca-{name}",
        "environment": [
            "FABRIC_CA_HOME=/etc/hyperledger/fabric-ca-server",
            f"FABRIC_CA_SERVER_CA_NAME=ca-{name}",
            "FABRIC_CA_SERVER_TLS_ENABLED=true",
            "FABRIC_CA_SERVER_PORT=7054",
            f"FABRIC_CA_SERVER_CSR_HOSTS=ca-{name},localhost",
            "FABRIC_CA_SERVER_OPERATIONS_LISTENADDRESS=0.0.0.0:17054",
        ],
        # The CA database stays on the VM's own disk (a volume), not on the
        # shared mount; its TLS certificate is copied out after start-up.
        "command": "sh -c 'fabric-ca-server start -b admin:adminpw -d'",
        "volumes": [f"ca-{name}:/etc/hyperledger/fabric-ca-server"],
        "networks": NET,
        "restart": "unless-stopped",
    }


def orderer_service(name):
    base = f"{TB}/organizations/ordererOrganizations/example.com/orderers/{name}.example.com"
    return {
        "image": f"hyperledger/fabric-orderer:{FABRIC}",
        "container_name": f"{name}.example.com",
        "hostname": f"{name}.example.com",
        "environment": [
            "FABRIC_LOGGING_SPEC=INFO",
            "ORDERER_GENERAL_LISTENADDRESS=0.0.0.0",
            "ORDERER_GENERAL_LISTENPORT=7050",
            "ORDERER_GENERAL_LOCALMSPID=OrdererMSP",
            "ORDERER_GENERAL_LOCALMSPDIR=/var/hyperledger/orderer/msp",
            "ORDERER_GENERAL_TLS_ENABLED=true",
            "ORDERER_GENERAL_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key",
            "ORDERER_GENERAL_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt",
            "ORDERER_GENERAL_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]",
            "ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=/var/hyperledger/orderer/tls/server.crt",
            "ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=/var/hyperledger/orderer/tls/server.key",
            "ORDERER_GENERAL_CLUSTER_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]",
            "ORDERER_GENERAL_BOOTSTRAPMETHOD=none",
            "ORDERER_CHANNELPARTICIPATION_ENABLED=true",
            "ORDERER_ADMIN_TLS_ENABLED=true",
            "ORDERER_ADMIN_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt",
            "ORDERER_ADMIN_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key",
            "ORDERER_ADMIN_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]",
            "ORDERER_ADMIN_TLS_CLIENTROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]",
            "ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:7053",
            "ORDERER_OPERATIONS_LISTENADDRESS=0.0.0.0:9443",
            "ORDERER_METRICS_PROVIDER=prometheus",
        ],
        "working_dir": "/root",
        "command": "orderer",
        "volumes": [
            f"{base}/msp:/var/hyperledger/orderer/msp:ro",
            f"{base}/tls:/var/hyperledger/orderer/tls:ro",
            f"{name}:/var/hyperledger/production/orderer",
        ],
        "networks": NET,
        "restart": "unless-stopped",
    }


def couchdb_service(org):
    return {
        "image": COUCHDB,
        "container_name": f"couchdb-{org}",
        "hostname": f"couchdb-{org}",
        "environment": ["COUCHDB_USER=admin", "COUCHDB_PASSWORD=adminpw"],
        "healthcheck": {
            "test": ["CMD-SHELL", "curl -sf http://localhost:5984/_up || exit 1"],
            "interval": "3s", "timeout": "3s", "retries": 30,
        },
        "volumes": [f"couchdb-{org}:/opt/couchdb/data"],
        "networks": NET,
        "restart": "unless-stopped",
    }


def peer_service(org):
    msp, port, ops = ORGS[org]
    host = f"peer0.{org}.example.com"
    return {
        "image": f"hyperledger/fabric-peer:{FABRIC}",
        "container_name": host,
        "hostname": host,
        "depends_on": {f"couchdb-{org}": {"condition": "service_healthy"}},
        "environment": [
            "FABRIC_CFG_PATH=/etc/hyperledger/peercfg",
            "FABRIC_LOGGING_SPEC=INFO",
            "CORE_PEER_TLS_ENABLED=true",
            "CORE_PEER_PROFILE_ENABLED=false",
            "CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt",
            "CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key",
            "CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt",
            f"CORE_PEER_ID={host}",
            f"CORE_PEER_ADDRESS={host}:{port}",
            f"CORE_PEER_LISTENADDRESS=0.0.0.0:{port}",
            f"CORE_PEER_CHAINCODEADDRESS={host}:{port + 1}",
            f"CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:{port + 1}",
            f"CORE_PEER_GOSSIP_BOOTSTRAP={host}:{port}",
            f"CORE_PEER_GOSSIP_EXTERNALENDPOINT={host}:{port}",
            f"CORE_PEER_LOCALMSPID={msp}",
            "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp",
            f"CORE_OPERATIONS_LISTENADDRESS=0.0.0.0:{ops}",
            "CORE_METRICS_PROVIDER=prometheus",
            # Same chaincode timeouts as the single-host network.
            "CORE_CHAINCODE_EXECUTETIMEOUT=900s",
            "CORE_CHAINCODE_INSTALLTIMEOUT=900s",
            "CORE_VM_ENDPOINT=unix:///host/var/run/docker.sock",
            # Chaincode containers join the overlay network on the peer's own VM.
            "CORE_VM_DOCKER_HOSTCONFIG_NETWORKMODE=diasnet",
            "CORE_LEDGER_STATE_STATEDATABASE=CouchDB",
            f"CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS=couchdb-{org}:5984",
            "CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin",
            "CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=adminpw",
        ],
        "working_dir": "/root",
        "command": "peer node start",
        "volumes": [
            f"{TB}/organizations/peerOrganizations/{org}.example.com/peers/{host}:/etc/hyperledger/fabric:ro",
            f"peer0-{org}:/var/hyperledger/production",
            f"{TB}/config:/etc/hyperledger/peercfg:ro",
            "/var/run/docker.sock:/host/var/run/docker.sock",
        ],
        "networks": NET,
        "restart": "unless-stopped",
    }


def cadvisor_service(machine):
    return {
        "image": CADVISOR,
        "container_name": f"cadvisor-{machine}",
        "hostname": f"cadvisor-{machine}",
        "privileged": True,
        "devices": ["/dev/kmsg"],
        "command": [
            "--docker_only=true",
            "--housekeeping_interval=5s",
            "--store_container_labels=false",
            "--whitelisted_container_labels=com.docker.compose.service",
            "--disable_metrics=percpu,sched,tcp,udp,disk,diskIO,hugetlb,referenced_memory,"
            "cpu_topology,resctrl,cpuset,advtcp,memory_numa,process",
        ],
        "volumes": [
            "/:/rootfs:ro",
            "/var/run:/var/run:ro",
            "/sys:/sys:ro",
            "/var/lib/docker/:/var/lib/docker:ro",
            "/dev/disk/:/dev/disk:ro",
        ],
        "networks": NET,
        "restart": "unless-stopped",
    }


def node_exporter_service(machine):
    return {
        "image": NODE_EXPORTER,
        "container_name": f"node-exporter-{machine}",
        "hostname": f"node-exporter-{machine}",
        "pid": "host",
        "command": ["--path.rootfs=/host"],
        "volumes": ["/:/host:ro,rslave"],
        "networks": NET,
        "restart": "unless-stopped",
    }


def app_services():
    peers = {org: f"peer0.{org}.example.com:{ORGS[org][1]}" for org in ORGS}
    return {
        "prometheus": {
            "image": PROMETHEUS,
            "container_name": "prometheus",
            "hostname": "prometheus",
            "command": [
                "--config.file=/etc/prometheus/prometheus.yml",
                "--storage.tsdb.path=/prometheus",
                "--storage.tsdb.retention.time=60d",
            ],
            "volumes": [
                f"{TB}/monitor/prometheus.yml:/etc/prometheus/prometheus.yml:ro",
                "prometheus-data:/prometheus",
            ],
            "ports": ["19090:9090"],
            "networks": NET,
            "restart": "unless-stopped",
        },
        "dias-backend": {
            "image": "dias-backend:testbed",
            "container_name": "dias-backend",
            "hostname": "dias-backend",
            "env_file": [f"{TB}/backend.env"],
            "environment": [
                "FABRIC_PEER_ENDPOINTS=" + json.dumps(peers, separators=(",", ":")),
            ],
            "volumes": [
                f"{TB}/organizations:/app/network/organizations:ro",
                "backend-data:/data",
                f"{TB}/keys:/run/dias-keys:ro",
            ],
            "extra_hosts": [f"host.lima.internal:{HOST_GATEWAY}"],
            "ports": ["13001:3001"],
            "networks": NET,
            "restart": "unless-stopped",
        },
    }


def render(machine, spec):
    services = {}
    volumes = {}
    for ca in spec["cas"]:
        services[f"ca-{ca}"] = ca_service(ca)
        volumes[f"ca-{ca}"] = {}
    if spec["orderer"]:
        services[f"{spec['orderer']}.example.com"] = orderer_service(spec["orderer"])
        volumes[spec["orderer"]] = {}
    for org in spec["orgs"]:
        services[f"couchdb-{org}"] = couchdb_service(org)
        services[f"peer0.{org}.example.com"] = peer_service(org)
        volumes[f"couchdb-{org}"] = {}
        volumes[f"peer0-{org}"] = {}
    if spec.get("app"):
        services.update(app_services())
        volumes["prometheus-data"] = {}
        volumes["backend-data"] = {"name": "dias-backend-data"}
    services[f"cadvisor-{machine}"] = cadvisor_service(machine)
    services[f"node-exporter-{machine}"] = node_exporter_service(machine)
    return {
        "name": f"dias-{machine}",
        "networks": {"diasnet": {"external": True, "name": "diasnet"}},
        "volumes": volumes,
        "services": services,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    for machine, spec in PLACEMENT.items():
        path = os.path.join(OUT, f"{machine}.json")
        with open(path, "w") as handle:
            json.dump(render(machine, spec), handle, indent=2)
            handle.write("\n")
        print(f"wrote {os.path.relpath(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
