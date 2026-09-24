#!/usr/bin/env bash
#
# Package, install (5 peers), approve (5 orgs), and commit the crimerecords
# chaincode with the evidenceDetails private data collection.
# Run with PWD = crime-records-network/network, network + channel up.
#
# Usage: deployCC.sh [channel] [cc-name] [version] [sequence]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orgs.sh
source "${SCRIPT_DIR}/orgs.sh"

CHANNEL_NAME="${1:-crimechannel}"
CC_NAME="${2:-crimerecords}"
CC_VERSION="${3:-1.0}"
CC_SEQUENCE="${4:-1}"

PROJECT_DIR="$(cd "${PWD}/.." && pwd)"
CC_SRC="${PROJECT_DIR}/chaincode/crimerecords"
COLLECTIONS_CONFIG="${PROJECT_DIR}/chaincode/collections-config.json"
ORDERER_CA="${PWD}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"

export FABRIC_CFG_PATH="${PWD}/../../fabric-samples/config"

infoln() { printf '\033[0;34m%s\033[0m\n' "$1"; }

# --- package (from a deterministic staging copy without generated outputs) --
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
# The retained SEAL-era rule engine and disagreement guard are offline research
# artifacts. They are excluded from the package so the deployed DIAS chaincode
# cannot evaluate policy or override a recommendation
# (test/architectureGuard.test.js keeps this list and the runtime imports in step).
rsync -a --exclude node_modules --exclude coverage --exclude test \
  --exclude .nyc_output \
  --exclude /lib/policy/policyEngine.js --exclude /lib/policy/controlledDecision.js \
  --exclude /lib/policy/llmDecisionProtocol.js --exclude /lib/policy/dynamicPolicy.js \
  --exclude /lib/policy/reasonDecisions.js \
  "${CC_SRC}/" "${STAGING}/src/"

# Ship the production dependencies inside the package. Without them every peer
# resolves and downloads them itself during install, which takes minutes per peer
# and repeatedly exceeded the peer's chaincode execute timeout. Installing them
# once here from the lockfile is both faster and more reproducible: all six peers
# then build from byte-identical inputs.
infoln "Vendoring production dependencies"
npm ci --omit=dev --prefix "${STAGING}/src" --no-audit --no-fund >/dev/null

PKG="${PWD}/channel-artifacts/${CC_NAME}_${CC_VERSION}.tar.gz"
infoln "Packaging ${CC_NAME} ${CC_VERSION}"
peer lifecycle chaincode package "$PKG" \
  --path "${STAGING}/src" --lang node --label "${CC_NAME}_${CC_VERSION}"

# The package ID is a hash of the package just built, so it must be computed
# BEFORE the install loop and the loop must test for that exact ID. Testing for
# the label instead is wrong: labels are not unique, and repackaging into a new
# staging directory changes the hash while leaving the label identical. That
# combination silently skips the install and then approves a package ID no peer
# holds, producing "definition exists, but chaincode is not installed" on every
# later invoke.
setGlobals police
PACKAGE_ID="$(peer lifecycle chaincode calculatepackageid "$PKG")"
infoln "Package ID: ${PACKAGE_ID}"

# --- install on every department peer ---------------------------------------
for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  setGlobals "$org"
  if peer lifecycle chaincode queryinstalled 2>/dev/null | grep -q "${PACKAGE_ID}"; then
    infoln "install: already present on peer0.${org}"
  else
    infoln "install: peer0.${org}"
    peer lifecycle chaincode install "$PKG"
  fi
done

# Fabric requires the definition sequence to be exactly one greater than the
# committed one, and 1 on a channel where this chaincode has never been
# committed. A hardcoded value therefore breaks after every teardown and
# rebuild, because the new ledger starts again at 1. Resolve it from the
# channel unless the caller pinned an explicit number.
if [ "$CC_SEQUENCE" = "auto" ]; then
  COMMITTED_SEQ="$(peer lifecycle chaincode querycommitted \
    --channelID "$CHANNEL_NAME" --name "$CC_NAME" --output json 2>/dev/null \
    | jq -r '.sequence // 0' 2>/dev/null || true)"
  case "$COMMITTED_SEQ" in
    ''|*[!0-9]*) COMMITTED_SEQ=0 ;;
  esac
  CC_SEQUENCE=$(( COMMITTED_SEQ + 1 ))
  infoln "Sequence: ${CC_SEQUENCE} (committed on channel: ${COMMITTED_SEQ})"
fi

# --- approve for all 5 orgs --------------------------------------------------
for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  setGlobals "$org"
  infoln "approve: ${org}"
  peer lifecycle chaincode approveformyorg \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL_NAME" --name "$CC_NAME" \
    --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
    --package-id "$PACKAGE_ID" \
    --collections-config "$COLLECTIONS_CONFIG"
done

# --- commit ------------------------------------------------------------------
infoln "Checking commit readiness"
setGlobals police
peer lifecycle chaincode checkcommitreadiness \
  --channelID "$CHANNEL_NAME" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --collections-config "$COLLECTIONS_CONFIG" --output json

PEER_CONN_ARGS=()
for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  port="$(org_field "$entry" 4)"
  PEER_CONN_ARGS+=(--peerAddresses "localhost:${port}" --tlsRootCertFiles \
    "${PWD}/organizations/peerOrganizations/${org}.example.com/tlsca/tlsca.${org}.example.com-cert.pem")
done

infoln "Committing chaincode definition"
peer lifecycle chaincode commit \
  -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" \
  --channelID "$CHANNEL_NAME" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --collections-config "$COLLECTIONS_CONFIG" \
  "${PEER_CONN_ARGS[@]}"

infoln "Committed definition:"
peer lifecycle chaincode querycommitted --channelID "$CHANNEL_NAME" --name "$CC_NAME"
