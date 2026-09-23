#!/usr/bin/env bash
#
# Read the ledger state of the running network: membership, block contents,
# endorsement signatures, certificate attributes, key history, and world state.
#
# Read-only. Pauses between sections unless --no-pause is given.
#
# Usage: scripts/inspect-ledger.sh            (pauses between steps)
#        scripts/inspect-ledger.sh --no-pause (runs straight through)

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "${PROJECT_DIR}/.." && pwd)"
NETWORK_DIR="${PROJECT_DIR}/network"
CHANNEL="crimechannel"
CC="crimerecords"
WORK="${PROJECT_DIR}/.blockdemo"
FABRIC_VERSION="${FABRIC_VERSION:-2.5.16}"
FABRIC_PEER_IMAGE="hyperledger/fabric-peer:${FABRIC_VERSION}"

export PATH="${WORKSPACE}/fabric-samples/bin:${PATH}"
export FABRIC_CFG_PATH="${WORKSPACE}/fabric-samples/config"

PAUSE=1
[ "${1:-}" = "--no-pause" ] && PAUSE=0

cd "${NETWORK_DIR}"
# shellcheck source=network/scripts/orgs.sh
source "${NETWORK_DIR}/scripts/orgs.sh"

# Use whichever Docker runtime holds the Fabric images.
if ! docker image inspect "${FABRIC_PEER_IMAGE}" >/dev/null 2>&1; then
  for ctx in $(docker context ls --format '{{.Name}}' 2>/dev/null); do
    if docker --context "${ctx}" image inspect "${FABRIC_PEER_IMAGE}" >/dev/null 2>&1; then
      export DOCKER_CONTEXT="${ctx}"; break
    fi
  done
fi

# Act as a seeded officer, not the org admin. Org admin certificates carry no
# role attribute, and the chaincode requires one — so admin queries are rejected.
setUser() { # setUser <org> <username>
  setGlobals "$1"
  export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/$1.example.com/users/$2@$1.example.com/msp"
}

step()  { printf '\n== %s\n' "$1"; }
note()  { printf '   %s\n' "$1"; }
hold()  { [ "$PAUSE" -eq 1 ] && { printf '\n[Enter to continue] '; read -r _; }; return 0; }

mkdir -p "${WORK}"

# ---------------------------------------------------------------------------
step "1. The network: six organizations, each with its own peer"
note "Five operational/oversight organizations and AIOrg each run a peer and CA."
note "No single organization owns the network."
echo
docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'peer0|orderer|^ca_' | sort | sed 's/^/  /'
echo
printf '  %s peers · %s certificate authorities · 1 ordering service\n' \
  "$(docker ps --format '{{.Names}}' | grep -c '^peer0')" \
  "$(docker ps --format '{{.Names}}' | grep -c '^ca_')"
hold

# ---------------------------------------------------------------------------
step "2. Every department is on the same chain, at the same height"
note "All six peers agree on the same block height and the same latest block"
note "hash. That agreement is what makes it a shared ledger."
echo
for entry in "${ORGS[@]}"; do
  org="$(org_field "$entry" 1)"
  setGlobals "$org"
  info="$(peer channel getinfo -c "${CHANNEL}" 2>/dev/null | sed -n 's/^Blockchain info: //p')"
  printf '  %-12s height %-5s hash %s\n' \
    "$org" \
    "$(echo "$info" | jq -r .height)" \
    "$(echo "$info" | jq -r .currentBlockHash | cut -c1-24)…"
done
hold

# ---------------------------------------------------------------------------
step "3. A real block, fetched from the chain and decoded"
note "This is the actual block structure: a number, the hash of the previous"
note "block, and the transactions inside it. The previous-block hash is what"
note "chains the blocks together — change an old block and every later hash breaks."
echo
setGlobals police
peer channel fetch newest "${WORK}/latest.block" -c "${CHANNEL}" >/dev/null 2>&1 \
  || { echo "  could not fetch block"; exit 1; }
configtxlator proto_decode --input "${WORK}/latest.block" \
  --type common.Block --output "${WORK}/latest.json" >/dev/null 2>&1

node -e '
const b = require(process.argv[1]);
console.log("  block number       :", b.header.number);
console.log("  previous block hash:", String(b.header.previous_hash).slice(0, 44) + "…");
console.log("  transactions       :", b.data.data.length);
' "${WORK}/latest.json"
echo
note "Full decoded block saved to .blockdemo/latest.json if you want to open it."
hold

# ---------------------------------------------------------------------------
step "4. Consensus: a majority of organizations endorse a transaction"
note "The application policy requires four endorsements in this six-organization channel."
note "These signatures are inside the block — one organization cannot write alone."
echo
node -e '
const b = require(process.argv[1]);
const env = b.data.data[0];
const actions = (env.payload.data && env.payload.data.actions) || [];
if (!actions.length) { console.log("  (this block is a config block, not an application transaction)"); }
for (const a of actions) {
  const endorsements = a.payload.action.endorsements || [];
  console.log("  endorsements:", endorsements.length);
  for (const e of endorsements) {
    const identity = Buffer.from(e.endorser, "base64").toString("utf8");
    const msp = identity.match(/(Police|Forensics|Prosecution|Court|Audit|AIOrg)MSP/);
    console.log("    signed by:", msp ? msp[0] : "(unparsed identity)");
  }
}
' "${WORK}/latest.json"
echo
setGlobals police
peer lifecycle chaincode querycommitted -C "${CHANNEL}" -n "${CC}" 2>/dev/null | sed 's/^/  /'
hold

# ---------------------------------------------------------------------------
step "5. Smart contracts running on the peers"
note "The access-control rules are not in the web app — they run inside the"
note "blockchain, in a container per peer, so every department executes the same code."
echo
docker ps --format '{{.Names}}' 2>/dev/null | grep '^dev-peer0' | sed 's/^/  /' | sed 's/-[0-9a-f]\{64\}.*//'
hold

# ---------------------------------------------------------------------------
step "6. Identity: the officer's role is inside their certificate"
note "Access is not decided from a database row that could be edited. It is"
note "decided from attributes signed into the officer's X.509 certificate by"
note "their department's certificate authority."
echo
CERT="${NETWORK_DIR}/organizations/peerOrganizations/police.example.com/users/const.verma@police.example.com/msp/signcerts/cert.pem"
if [ -f "$CERT" ]; then
  openssl x509 -in "$CERT" -noout -subject | sed 's/^/  /'
  openssl x509 -in "$CERT" -noout -text > "${WORK}/cert.txt" 2>/dev/null
  node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const found = text.match(/\{"attrs":\{[^}]*\}\}/);
    if (!found) { console.log("  (no attribute extension found)"); process.exit(0); }
    const attrs = JSON.parse(found[0]).attrs;
    for (const key of ["role", "rank", "station", "jurisdiction", "badgeId",
                       "clearance", "credentialStatus", "caseAssignments"]) {
      if (attrs[key] !== undefined) console.log("  " + key.padEnd(17) + ": " + attrs[key]);
    }
  ' "${WORK}/cert.txt"
else
  echo "  certificate not found — run bootstrap.sh and seed-identities.sh first"
fi
hold

# ---------------------------------------------------------------------------
step "7. Immutability: past versions of a record cannot be rewritten"
note "Updating a record appends a new version. The old ones stay on the chain"
note "with the transaction that wrote them. This is the audit guarantee."
echo
setUser audit sp.north
RECORD="$(peer chaincode query -C "${CHANNEL}" -n "${CC}" \
  -c '{"function":"RecordContract:QueryRecords","Args":["{\"caseId\":\"CASE-2026-001\"}"]}' 2>/dev/null \
  | jq -r '.[0].recordId // empty')"

if [ -n "${RECORD}" ]; then
  printf '  record: %s\n' "${RECORD}"
  peer chaincode query -C "${CHANNEL}" -n "${CC}" \
    -c "{\"function\":\"RecordContract:GetRecordHistory\",\"Args\":[\"${RECORD}\"]}" 2>/dev/null \
    | jq -r '. | to_entries[] | "  version \(.key+1)  tx \(.value.txId[0:16])…  sealed=\(.value.value.sealed)"'
else
  echo "  no records found — file one in the app first"
fi
hold

# ---------------------------------------------------------------------------
step "8. What is deliberately NOT on the chain"
note "Only metadata and a SHA-256 commitment go on the ledger. The case"
note "narrative stays in the department's own storage. Search the whole world"
note "state for the record text and it is not there."
echo
if [ -n "${RECORD}" ]; then
  setUser police insp.sharma
  peer chaincode query -C "${CHANNEL}" -n "${CC}" \
    -c "{\"function\":\"RecordContract:GetRecord\",\"Args\":[\"${RECORD}\"]}" 2>/dev/null \
    | jq '{recordId, recordType, sensitivityLevel, jurisdiction, contentHash, offChainReference}' \
    | sed 's/^/  /'
  echo
  note "contentHash is the commitment; offChainReference identifies the agency vault object."
fi
hold

# ---------------------------------------------------------------------------
step "9. The world state database, per department"
note "Each peer keeps its own queryable copy of current state in CouchDB."
note "Open this in a browser to browse the ledger state directly:"
echo
printf '  Police      http://admin:adminpw@localhost:5984/_utils\n'
printf '  Forensics   http://admin:adminpw@localhost:6984/_utils\n'
printf '  Prosecution http://admin:adminpw@localhost:7984/_utils\n'
printf '  Court       http://admin:adminpw@localhost:8984/_utils\n'
printf '  Audit       http://admin:adminpw@localhost:9984/_utils\n'
printf '  AIOrg       http://admin:adminpw@localhost:10984/_utils\n'
echo
COUNT="$(curl -s "http://admin:adminpw@localhost:5984/crimechannel_crimerecords/_all_docs?limit=0" 2>/dev/null | jq -r '.total_rows // "?"')"
printf '  Police peer world state holds %s keys\n' "${COUNT}"

printf '\nAll values above were read from the running network.\n'
