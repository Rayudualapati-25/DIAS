#!/usr/bin/env bash
#
# One-command bring-up of the Crime Records Access Network:
#   6 Fabric CAs -> org MSP generation -> orderer + 5 peers (CouchDB)
#   -> channel 'crimechannel' created and joined by every department peer.
#
# Usage: scripts/network-up.sh [channel-name]

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "${PROJECT_DIR}/.." && pwd)"
NETWORK_DIR="${PROJECT_DIR}/network"
CHANNEL_NAME="${1:-crimechannel}"
FABRIC_VERSION="${FABRIC_VERSION:-2.5.16}"
FABRIC_CA_VERSION="${FABRIC_CA_VERSION:-1.5.22}"
FABRIC_PEER_IMAGE="hyperledger/fabric-peer:${FABRIC_VERSION}"
export FABRIC_VERSION FABRIC_CA_VERSION

export PATH="${WORKSPACE}/fabric-samples/bin:${PATH}"

LOG_DIR="${PROJECT_DIR}/.bootstrap-logs"
mkdir -p "${LOG_DIR}"

info() { printf '\n\033[0;34m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
info "Preflight checks"

command -v docker            >/dev/null 2>&1 || die "docker not found on PATH"
command -v peer              >/dev/null 2>&1 || die "peer binary not found (expected in fabric-samples/bin)"
command -v configtxgen       >/dev/null 2>&1 || die "configtxgen not found"
command -v osnadmin          >/dev/null 2>&1 || die "osnadmin not found"
command -v fabric-ca-client  >/dev/null 2>&1 || die "fabric-ca-client not found"

# Use whichever Docker runtime holds the Fabric images (Colima vs Desktop).
find_fabric_context() {
  if docker image inspect "${FABRIC_PEER_IMAGE}" >/dev/null 2>&1; then
    return 0
  fi
  local ctx
  for ctx in $(docker context ls --format '{{.Name}}' 2>/dev/null); do
    if docker --context "${ctx}" image inspect "${FABRIC_PEER_IMAGE}" >/dev/null 2>&1; then
      export DOCKER_CONTEXT="${ctx}"
      printf 'note:       switched to Docker context "%s"\n' "${ctx}"
      return 0
    fi
  done
  return 1
}

docker info >/dev/null 2>&1 || die "Docker daemon not reachable. If you use Colima: colima start"
find_fabric_context || die "no Docker runtime has ${FABRIC_PEER_IMAGE}; install the pinned Fabric ${FABRIC_VERSION} images first"

printf 'docker:     %s\n' "$(docker --version)"
printf 'peer:       %s\n' "$(peer version | sed -ne 's/^ Version: //p')"
printf 'context:    %s\n' "${DOCKER_CONTEXT:-$(docker context show)}"

cd "${NETWORK_DIR}"

# --- clean slate -----------------------------------------------------------
info "Tearing down any previous run"
"${PROJECT_DIR}/scripts/network-down.sh" >/dev/null 2>&1 || true

# --- CAs -------------------------------------------------------------------
info "Starting 6 Fabric CAs"
docker compose -f compose/compose-ca.yaml up -d >"${LOG_DIR}/ca-up.log" 2>&1 \
  || die "CA bring-up failed — see ${LOG_DIR}/ca-up.log"

info "Generating org MSP material (registerEnroll)"
bash scripts/registerEnroll.sh >"${LOG_DIR}/register-enroll.log" 2>&1 \
  || die "registerEnroll failed — see ${LOG_DIR}/register-enroll.log"

# --- network ---------------------------------------------------------------
info "Starting orderer + 5 department peers (CouchDB state)"
docker compose -f compose/compose-net.yaml up -d >"${LOG_DIR}/net-up.log" 2>&1 \
  || die "network bring-up failed — see ${LOG_DIR}/net-up.log"

info "Creating channel '${CHANNEL_NAME}' and joining all peers"
bash scripts/createChannel.sh "${CHANNEL_NAME}" >"${LOG_DIR}/create-channel.log" 2>&1 \
  || die "channel creation failed — see ${LOG_DIR}/create-channel.log"

# --- verify ----------------------------------------------------------------
info "Running containers"
docker ps --format '  {{.Names}}\t{{.Status}}'

info "Channel status per department"
export FABRIC_CFG_PATH="${WORKSPACE}/fabric-samples/config"
# shellcheck source=network/scripts/orgs.sh
source "${NETWORK_DIR}/scripts/orgs.sh"
for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  setGlobals "$org"
  height="$(peer channel getinfo -c "${CHANNEL_NAME}" 2>/dev/null | sed -n 's/^Blockchain info: //p' | jq -r .height)"
  printf '  %-12s peer0 joined, block height %s\n' "$org" "${height:-?}"
done

info "Crime Records Access Network is UP"
printf 'Channel:   %s\nOrgs:      police forensics prosecution court audit\nTear down: make down\n' "${CHANNEL_NAME}"
