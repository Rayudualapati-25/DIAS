#!/usr/bin/env bash
#
# Shared org metadata + peer CLI environment helpers.
# Source this from scripts that run with PWD = crime-records-network/network.

# The Fabric binaries live in the parent workspace, not on the system PATH.
# network-up.sh exports the PATH before calling its children, but `make deploy`
# and `make seed` invoke scripts here directly and make starts a fresh shell for
# every recipe line, so that export never reaches them. Every script in this
# directory sources this file, so resolving the PATH here covers all of them.
# Derived from this file's own location rather than PWD, so it holds however the
# caller was invoked.
_ORGS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_FABRIC_BIN="$(cd "${_ORGS_DIR}/../../.." && pwd)/fabric-samples/bin"
if [ -d "${_FABRIC_BIN}" ] && [[ ":${PATH}:" != *":${_FABRIC_BIN}:"* ]]; then
  export PATH="${_FABRIC_BIN}:${PATH}"
fi
unset _ORGS_DIR _FABRIC_BIN

# org : msp id : CA port : peer port
ORGS=(
  "police:PoliceMSP:7054:7051"
  "forensics:ForensicsMSP:8054:8051"
  "prosecution:ProsecutionMSP:9054:9051"
  "court:CourtMSP:10054:10051"
  "audit:AuditMSP:11054:11051"
  "ai:AIOrgMSP:13054:12051"
)

# ORG_SET=dias selects the five organizations of the DIAS channel. DIAS has no AI
# organization: the LLM runs in the application backend.
if [ "${ORG_SET:-}" = "dias" ]; then
  ORGS=(
    "police:PoliceMSP:7054:7051"
    "forensics:ForensicsMSP:8054:8051"
    "prosecution:ProsecutionMSP:9054:9051"
    "court:CourtMSP:10054:10051"
    "audit:AuditMSP:11054:11051"
  )
fi

ORDERER_CA_PORT=12054

org_field() { # org_field <entry> <index>
  echo "$1" | cut -d: -f"$2"
}

# Point the peer CLI at a given org's peer, acting as that org's admin.
# Usage: setGlobals police
setGlobals() {
  local org="$1"
  local entry msp port
  for e in "${ORGS[@]}"; do
    if [ "$(org_field "$e" 1)" = "$org" ]; then entry="$e"; fi
  done
  [ -n "${entry:-}" ] || { echo "unknown org: $org" >&2; return 1; }
  msp="$(org_field "$entry" 2)"
  port="$(org_field "$entry" 4)"

  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="$msp"
  export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/${org}.example.com/tlsca/tlsca.${org}.example.com-cert.pem"
  export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/${org}.example.com/users/Admin@${org}.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:${port}"
}
