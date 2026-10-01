#!/usr/bin/env bash
#
# Create `diaschannel` on the three Raft orderers and join the five peers.
# Runs inside hyperledger/fabric-tools on the diasnet overlay network with the
# testbed directory mounted at /testbed. Mirrors network/scripts/createChannel.sh.
set -euo pipefail

TB=/testbed
CHANNEL="${CHANNEL:-diaschannel}"
ORGS=(police:PoliceMSP:7051 forensics:ForensicsMSP:8051 prosecution:ProsecutionMSP:9051 court:CourtMSP:10051 audit:AuditMSP:11051)
ART="${TB}/channel-artifacts"
BLOCK="${ART}/${CHANNEL}.block"
ORD="${TB}/organizations/ordererOrganizations/example.com"

infoln() { printf '== %s\n' "$1"; }

peer_env() { # peer_env <org> <msp> <port>
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="$2"
  export CORE_PEER_TLS_ROOTCERT_FILE="${TB}/organizations/peerOrganizations/$1.example.com/tlsca/tlsca.$1.example.com-cert.pem"
  export CORE_PEER_MSPCONFIGPATH="${TB}/organizations/peerOrganizations/$1.example.com/users/Admin@$1.example.com/msp"
  export CORE_PEER_ADDRESS="peer0.$1.example.com:$3"
}

mkdir -p "$ART"
export FABRIC_CFG_PATH="${TB}/config"
if [ ! -f "$BLOCK" ]; then
  infoln "genesis block for ${CHANNEL}"
  configtxgen -profile DiasTestbedChannel -outputBlock "$BLOCK" -channelID "$CHANNEL"
fi

for n in 1 2 3; do
  host="orderer${n}.example.com"
  infoln "orderer ${host} joins ${CHANNEL}"
  for attempt in $(seq 1 10); do
    if osnadmin channel join --channelID "$CHANNEL" --config-block "$BLOCK" \
        -o "${host}:7053" --ca-file "${ORD}/orderers/${host}/tls/ca.crt" \
        --client-cert "${ORD}/orderers/${host}/tls/server.crt" \
        --client-key "${ORD}/orderers/${host}/tls/server.key"; then
      break
    fi
    if osnadmin channel list --channelID "$CHANNEL" -o "${host}:7053" \
        --ca-file "${ORD}/orderers/${host}/tls/ca.crt" \
        --client-cert "${ORD}/orderers/${host}/tls/server.crt" \
        --client-key "${ORD}/orderers/${host}/tls/server.key" >/dev/null 2>&1; then
      infoln "${host} already has ${CHANNEL}"; break
    fi
    [ "$attempt" -lt 10 ] || { echo "${host} failed to join" >&2; exit 1; }
    sleep 3
  done
done

infoln "waiting for a Raft leader"
sleep 8

for entry in "${ORGS[@]}"; do
  IFS=: read -r org msp port <<< "$entry"
  peer_env "$org" "$msp" "$port"
  if peer channel list 2>/dev/null | grep -qx "$CHANNEL"; then
    infoln "peer0.${org} already joined"; continue
  fi
  infoln "peer0.${org} joins ${CHANNEL}"
  for attempt in $(seq 1 10); do
    if peer channel join -b "$BLOCK"; then break; fi
    [ "$attempt" -lt 10 ] || { echo "peer0.${org} failed to join" >&2; exit 1; }
    sleep 3
  done
done

infoln "channel ${CHANNEL} created on 3 orderers and joined by ${#ORGS[@]} peers"
