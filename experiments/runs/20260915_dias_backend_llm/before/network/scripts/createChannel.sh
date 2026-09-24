#!/usr/bin/env bash
#
# Create the application channel and join all 5 department peers.
# Run with PWD = crime-records-network/network, network containers up.
#
# Usage: createChannel.sh [channel-name]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orgs.sh
source "${SCRIPT_DIR}/orgs.sh"

CHANNEL_NAME="${1:-crimechannel}"
ARTIFACTS_DIR="${PWD}/channel-artifacts"
BLOCK_FILE="${ARTIFACTS_DIR}/${CHANNEL_NAME}.block"

ORDERER_DIR="${PWD}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com"
ORDERER_CA="${ORDERER_DIR}/tls/ca.crt"
ORDERER_ADMIN_TLS_CERT="${ORDERER_DIR}/tls/server.crt"
ORDERER_ADMIN_TLS_KEY="${ORDERER_DIR}/tls/server.key"

infoln() { printf '\033[0;34m%s\033[0m\n' "$1"; }

infoln "Generating genesis block for channel '${CHANNEL_NAME}'"
mkdir -p "$ARTIFACTS_DIR"
FABRIC_CFG_PATH="${PWD}/configtx" configtxgen \
  -profile CrimeChannel \
  -outputBlock "$BLOCK_FILE" \
  -channelID "$CHANNEL_NAME"

infoln "Joining orderer to the channel (osnadmin)"
# The orderer may still be starting; retry briefly.
rc=1
for i in $(seq 1 10); do
  if osnadmin channel join \
      --channelID "$CHANNEL_NAME" \
      --config-block "$BLOCK_FILE" \
      -o localhost:7053 \
      --ca-file "$ORDERER_CA" \
      --client-cert "$ORDERER_ADMIN_TLS_CERT" \
      --client-key "$ORDERER_ADMIN_TLS_KEY"; then
    rc=0; break
  fi
  sleep 2
done
[ "$rc" -eq 0 ] || { echo "orderer failed to join channel" >&2; exit 1; }

export FABRIC_CFG_PATH="${PWD}/../../fabric-samples/config"

for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  infoln "Joining peer0.${org}.example.com to '${CHANNEL_NAME}'"
  setGlobals "$org"
  rc=1
  for i in $(seq 1 5); do
    if peer channel join -b "$BLOCK_FILE"; then rc=0; break; fi
    sleep 2
  done
  [ "$rc" -eq 0 ] || { echo "peer0.${org} failed to join" >&2; exit 1; }
done

infoln "Channel '${CHANNEL_NAME}' created and joined by all 5 department peers."
