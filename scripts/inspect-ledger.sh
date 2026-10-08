#!/usr/bin/env bash
# Read actual channel membership, heights, definitions and DIAS commitments.
# No transactions, key copying or credential-bearing CouchDB URLs.
# FABRIC_NETWORK_DIR=/active/network INSPECT_OUT=/fresh/output scripts/inspect-ledger.sh --no-pause
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "${PROJECT_DIR}/.." && pwd)"
NETWORK_DIR="${FABRIC_NETWORK_DIR:-${PROJECT_DIR}/network}"
CHANNEL="${CHANNEL:-diaschannel}"
CC="${CC:-${CHAINCODE:-diasrecords}}"
export ORG_SET="${ORG_SET:-dias}"
WORK="${INSPECT_OUT:-${PROJECT_DIR}/.blockdemo/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export PATH="${FABRIC_BIN:-${WORKSPACE}/fabric-samples/bin}:${PATH}"
export FABRIC_CFG_PATH="${FABRIC_CFG_PATH:-${WORKSPACE}/fabric-samples/config}"
PAUSE=1
[ "${1:-}" = "--no-pause" ] && PAUSE=0
for command in peer configtxlator jq node docker; do
  command -v "$command" >/dev/null || { printf 'Missing tool: %s\n' "$command" >&2; exit 1; }
done
[ -d "$NETWORK_DIR/organizations" ] || { echo 'Choose the running network identity directory with FABRIC_NETWORK_DIR' >&2; exit 1; }
[ ! -d "$WORK" ] || [ -z "$(ls -A "$WORK")" ] || { echo 'INSPECT_OUT contains earlier evidence; use a fresh directory' >&2; exit 1; }
mkdir -p "$WORK"
cd "$NETWORK_DIR"
source "$NETWORK_DIR/scripts/orgs.sh"
if [ -z "${DOCKER_CONTEXT:-}" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'peer0.police.example.com'; then
  for context in $(docker context ls --format '{{.Name}}'); do
    if docker --context "$context" ps --format '{{.Names}}' 2>/dev/null | grep -qx 'peer0.police.example.com'; then
      export DOCKER_CONTEXT="$context"; break
    fi
  done
fi
step() { printf '\n== %s\n' "$1"; }
hold() { if [ "$PAUSE" -eq 1 ]; then printf '\n[Enter to continue] '; read -r _; fi; }
setUser() {
  setGlobals "$1"
  export CORE_PEER_MSPCONFIGPATH="$NETWORK_DIR/organizations/peerOrganizations/$1.example.com/users/$2@$1.example.com/msp"
  [ -d "$CORE_PEER_MSPCONFIGPATH" ] || { echo 'Enrolled inspection identity is missing' >&2; exit 1; }
}
step '1. Observed channel membership and endorsement policy'
setGlobals police
peer channel fetch config "$WORK/config.block" -c "$CHANNEL" > "$WORK/config-fetch.log" 2>&1
configtxlator proto_decode --input "$WORK/config.block" --type common.Block --output "$WORK/config.json"
jq '.data.data[0].payload.data.config.channel_group.groups.Application | {members: (.groups | keys), endorsement: .policies.Endorsement}' "$WORK/config.json"
hold
step '2. Peer heights observed sequentially (writes may advance them during inspection)'
: > "$WORK/peer-heights.jsonl"
for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  msp="$(org_field "$entry" 2)"
  # A reused network directory may also contain organizations from another
  # channel. Inspect only members observed in this channel's configuration.
  if ! jq -e --arg msp "$msp" '.data.data[0].payload.data.config.channel_group.groups.Application.groups | has($msp)' "$WORK/config.json" >/dev/null; then
    continue
  fi
  setGlobals "$org"
  peer channel getinfo -c "$CHANNEL" > "$WORK/$org-info.log" 2>&1
  info="$(sed -n 's/^Blockchain info: //p' "$WORK/$org-info.log")"
  [ -n "$info" ] || { echo "No channel info returned for $org" >&2; exit 1; }
  jq -c --arg org "$org" '. + {organization: $org}' <<< "$info" | tee -a "$WORK/peer-heights.jsonl"
done
hold
step '3. Committed chaincode definition and a decoded current block'
setGlobals police
peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC" --output json > "$WORK/chaincode-definition.json"
cat "$WORK/chaincode-definition.json"
peer channel fetch newest "$WORK/latest.block" -c "$CHANNEL" > "$WORK/block-fetch.log" 2>&1
configtxlator proto_decode --input "$WORK/latest.block" --type common.Block --output "$WORK/latest.json"
node - "$WORK/latest.json" <<'NODE'
const fs = require('fs');
const block = JSON.parse(fs.readFileSync(process.argv[2]));
console.log(JSON.stringify({ block: block.header.number, transactions: block.data.data.length }));
for (const envelope of block.data.data) {
  for (const action of envelope.payload.data.actions || []) {
    const endorsements = action.payload.action.endorsements || [];
    console.log('observed endorsers:', endorsements.map(e => {
      const serialized = Buffer.from(e.endorser, 'base64').toString('utf8');
      const found = serialized.match(/(?:Police|Forensics|Prosecution|Court|Audit|AIOrg)MSP/);
      return found ? found[0] : 'unparsed identity';
    }).join(', '));
  }
}
NODE
hold
step '4. Current DIAS case summaries and decision commitments'
setUser police insp.sharma
peer chaincode query -C "$CHANNEL" -n "$CC" -c '{"function":"GovernanceContract:QueryCases","Args":[]}' > "$WORK/cases.json"
jq 'map({caseId, owningAgency, jurisdiction, status})' "$WORK/cases.json"
setUser audit sp.north
peer chaincode query -C "$CHANNEL" -n "$CC" -c '{"function":"AccessContract:QueryAccessDecisions","Args":["10"]}' > "$WORK/decisions.json"
jq 'map({requestId, decision, outcome, llmRecommendation, llmAgreement, decisionTxId})' "$WORK/decisions.json"
hold
step '5. Running peer and state-database containers'
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '^(peer0\.|couchdb|dev-peer0)' || true
printf '\nRead-only evidence saved to %s\n' "$WORK"
