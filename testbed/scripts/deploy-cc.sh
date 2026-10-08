#!/usr/bin/env bash
#
# Package, install, approve and commit the DIAS chaincode on the testbed.
# Runs inside hyperledger/fabric-tools on the diasnet overlay network with the
# testbed directory mounted at /testbed. Mirrors network/scripts/deployCC.sh:
# same private-data collection, same channel endorsement policy (MAJORITY, 3 of
# 5). The staged source (with production dependencies already installed) is
# prepared by prepare-chaincode.sh before this runs.
set -euo pipefail

TB=/testbed
CHANNEL="${CHANNEL:-diaschannel}"
CC_NAME="${CC_NAME:-diasrecords}"
CC_VERSION="${CC_VERSION:-3.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
SRC="${TB}/chaincode-staging/src"
COLLECTIONS="${TB}/config/collections-config.json"
PKG="${TB}/channel-artifacts/${CC_NAME}_${CC_VERSION}.tar.gz"
ORDERER_CA="${TB}/organizations/ordererOrganizations/example.com/orderers/orderer1.example.com/tls/ca.crt"
ORGS=(police:PoliceMSP:7051 forensics:ForensicsMSP:8051 prosecution:ProsecutionMSP:9051 court:CourtMSP:10051 audit:AuditMSP:11051)
export FABRIC_CFG_PATH="${TB}/config"

infoln() { printf '== %s\n' "$1"; }
peer_env() {
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="$2"
  export CORE_PEER_TLS_ROOTCERT_FILE="${TB}/organizations/peerOrganizations/$1.example.com/tlsca/tlsca.$1.example.com-cert.pem"
  export CORE_PEER_MSPCONFIGPATH="${TB}/organizations/peerOrganizations/$1.example.com/users/Admin@$1.example.com/msp"
  export CORE_PEER_ADDRESS="peer0.$1.example.com:$3"
}

mkdir -p "${TB}/channel-artifacts"
[ -f "${SRC}/index.js" ] || { echo "run prepare-chaincode.sh first" >&2; exit 1; }
[ ! -e "${PKG}" ] || { echo "package already exists; select a new version label to retain earlier evidence" >&2; exit 1; }

infoln "packaging ${CC_NAME} ${CC_VERSION}"
peer lifecycle chaincode package "$PKG" --path "$SRC" --lang node --label "${CC_NAME}_${CC_VERSION}"
IFS=: read -r o m p <<< "${ORGS[0]}"; peer_env "$o" "$m" "$p"
PACKAGE_ID="$(peer lifecycle chaincode calculatepackageid "$PKG")"
infoln "package id ${PACKAGE_ID}"
sha256sum "$PKG" | tee "${TB}/channel-artifacts/${CC_NAME}_${CC_VERSION}.sha256"

# Installs build the chaincode image on each peer's own VM; run them in
# parallel so the five builds overlap.
pids=()
for entry in "${ORGS[@]}"; do
  IFS=: read -r org msp port <<< "$entry"
  (
    peer_env "$org" "$msp" "$port"
    if peer lifecycle chaincode queryinstalled 2>/dev/null | grep -q "$PACKAGE_ID"; then
      echo "== install: already on peer0.${org}"
    else
      echo "== install: peer0.${org}"
      peer lifecycle chaincode install "$PKG" > "/tmp/install-${org}.log" 2>&1 \
        || { cat "/tmp/install-${org}.log"; exit 1; }
      echo "== install: peer0.${org} done"
    fi
  ) &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

for entry in "${ORGS[@]}"; do
  IFS=: read -r org msp port <<< "$entry"
  peer_env "$org" "$msp" "$port"
  infoln "approve: ${org}"
  peer lifecycle chaincode approveformyorg -o orderer1.example.com:7050 \
    --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
    --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --package-id "$PACKAGE_ID" \
    --collections-config "$COLLECTIONS"
done

IFS=: read -r o m p <<< "${ORGS[0]}"; peer_env "$o" "$m" "$p"
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --collections-config "$COLLECTIONS" --output json

CONN=()
for entry in "${ORGS[@]}"; do
  IFS=: read -r org msp port <<< "$entry"
  CONN+=(--peerAddresses "peer0.${org}.example.com:${port}" --tlsRootCertFiles \
    "${TB}/organizations/peerOrganizations/${org}.example.com/tlsca/tlsca.${org}.example.com-cert.pem")
done
infoln "commit"
peer lifecycle chaincode commit -o orderer1.example.com:7050 --tls --cafile "$ORDERER_CA" \
  --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --collections-config "$COLLECTIONS" "${CONN[@]}"
peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME"
infoln "${CC_NAME} ${CC_VERSION} committed at sequence ${CC_SEQUENCE}"

peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" --output json \
  > "${TB}/channel-artifacts/${CC_NAME}_${CC_VERSION}-committed.json"
