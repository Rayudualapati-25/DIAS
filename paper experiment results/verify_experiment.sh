#!/usr/bin/env bash
#
# Independent verification that the ledger-growth experiment ran against a real
# Hyperledger Fabric network, and that its numbers are not self-reported.
#
# The load harness measured itself. This script deliberately does NOT trust it:
# every check here uses a different tool, a different code path, or the ledger's
# own cryptographic record.
#
#   1. environment fingerprint   what was actually running
#   2. block height              the ledger grew by real blocks
#   3. transaction provenance    sampled records resolve to committed txids
#   4. block retrieval           those txids are inside real blocks (qscc)
#   5. endorsement               blocks carry peer signatures
#   6. independent record count  CouchDB agrees with the API
#   7. independent timing        curl re-measures what the Node harness claimed
#
# Read-only. Safe to run on a live network, but run it AFTER a measurement
# sweep finishes so the peer is not competing with the experiment.
#
# Usage: bash verify_experiment.sh [samples]

set -uo pipefail

SAMPLES="${1:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${HERE}/.." && pwd)"
WORKSPACE="$(cd "${PROJECT_DIR}/.." && pwd)"
NETWORK_DIR="${PROJECT_DIR}/network"
CHANNEL="crimechannel"
API="${API_BASE:-http://localhost:3001/api}"
COUCH="http://localhost:5984"
REPORT="${HERE}/verification_report.txt"

export PATH="${WORKSPACE}/fabric-samples/bin:${PATH}"
export FABRIC_CFG_PATH="${WORKSPACE}/fabric-samples/config"

exec > >(tee "${REPORT}") 2>&1

hr() { printf '%s\n' "------------------------------------------------------------"; }
section() { hr; printf '%s\n' "$1"; hr; }

echo "Verification run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Host: $(uname -sm)"
echo

# ---------------------------------------------------------------- 1. environment
section "1. ENVIRONMENT FINGERPRINT"
echo "Fabric peer binary:"
peer version 2>/dev/null | sed 's/^/  /' | head -6
echo
echo "Colima VM:"
colima list 2>/dev/null | sed 's/^/  /'
echo
echo "Running Fabric containers:"
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | sort | head -25
echo
echo "Container count: $(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "Orderer batching (from configtx.yaml — the cause of the 1-user latency):"
grep -E "BatchTimeout|MaxMessageCount" "${NETWORK_DIR}/configtx/configtx.yaml" | sed 's/^/  /'

cd "${NETWORK_DIR}" || exit 1
# shellcheck source=/dev/null
source "${NETWORK_DIR}/scripts/orgs.sh"
setGlobals police

# ---------------------------------------------------------------- 2. block height
section "2. LEDGER BLOCK HEIGHT"
echo "Reported by the police peer itself, not by the experiment:"
peer channel getinfo -c "${CHANNEL}" 2>/dev/null | sed 's/^/  /'
echo
echo "A ledger that never ran these transactions cannot have this height."
echo "Record it before and after a re-run: the delta is the transaction count."

# ---------------------------------------------------------------- 3. provenance
section "3. TRANSACTION PROVENANCE OF SAMPLED RECORDS"
echo "Sampling ${SAMPLES} filler records written by the experiment."
echo "createdTxId and createdAtUtc are assigned by the NETWORK (getTxID and"
echo "getDateTimestamp inside the chaincode), not by the client harness."
echo

TOKEN="$(curl -s -X POST "${API}/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"aud.qureshi"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)"

if [ -z "${TOKEN}" ]; then
  echo "  ! backend not reachable at ${API} — skipping API-dependent checks"
  TXIDS=""
else
  TXIDS=""
  for i in $(seq 1 "${SAMPLES}"); do
    IDX=$(( (RANDOM * 32768 + RANDOM) % 50000 ))
    RID="BULK-$(printf '%06d' "${IDX}")"
    JSON="$(curl -s -H "Authorization: Bearer ${TOKEN}" "${API}/records/${RID}")"
    TXID="$(printf '%s' "${JSON}" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)["data"]
    print(d.get("createdTxId",""))
except Exception: print("")' 2>/dev/null)"
    CREATED="$(printf '%s' "${JSON}" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)["data"]
    print(d.get("createdAtUtc",""))
except Exception: print("")' 2>/dev/null)"
    if [ -n "${TXID}" ]; then
      echo "  ${RID}"
      echo "     txid       ${TXID}"
      echo "     committed  ${CREATED}   (orderer-assigned timestamp)"
      TXIDS="${TXIDS} ${TXID}"
    else
      echo "  ${RID}  not found (below the seeded range)"
    fi
  done
fi

# ---------------------------------------------------------------- 4. block retrieval
section "4. THOSE TXIDS RESOLVE TO REAL BLOCKS"
echo "Querying the Query System Chaincode (qscc) on the peer. This reads the"
echo "committed ledger directly. A fabricated txid cannot be retrieved."
echo
for TXID in ${TXIDS}; do
  OUT="$(peer chaincode query -C "${CHANNEL}" -n qscc \
    -c "{\"Args\":[\"GetBlockByTxID\",\"${CHANNEL}\",\"${TXID}\"]}" 2>&1)"
  RC=$?
  if [ ${RC} -eq 0 ]; then
    echo "  ${TXID:0:24}...  FOUND in a committed block (${#OUT} bytes returned)"
  else
    echo "  ${TXID:0:24}...  NOT FOUND  <-- would invalidate the experiment"
  fi
done

# ---------------------------------------------------------------- 5. endorsement
section "5. ENDORSEMENT SIGNATURES ON A REAL BLOCK"
echo "Fetching the newest block and showing the MSPs that signed it."
peer channel fetch newest "${HERE}/.verify-newest.block" -c "${CHANNEL}" 2>&1 | tail -2 | sed 's/^/  /'
if [ -f "${HERE}/.verify-newest.block" ]; then
  echo
  echo "  MSP identities appearing in the block:"
  strings "${HERE}/.verify-newest.block" 2>/dev/null \
    | grep -oE "(Police|Forensics|Prosecution|Court|Audit|Orderer)MSP" \
    | sort | uniq -c | sed 's/^/    /'
  echo
  echo "  Block size on disk: $(wc -c < "${HERE}/.verify-newest.block" | tr -d ' ') bytes"
  rm -f "${HERE}/.verify-newest.block"
fi

# ---------------------------------------------------------------- 6. couch count
section "6. INDEPENDENT RECORD COUNT (CouchDB, not the API)"
echo "The peer's state database, queried directly. Different system, different"
echo "credentials, no involvement from the experiment harness."
echo
curl -s -u admin:adminpw "${COUCH}/crimechannel_crimerecords" \
  | python3 -c 'import sys, json
d = json.load(sys.stdin)
s = d.get("sizes", {})
docs = d.get("doc_count", 0)
print("  documents in world state : {:,}".format(docs))
print("  active bytes             : {:,}".format(s.get("active", 0)))
print("  on-disk bytes            : {:,}".format(s.get("file", 0)))
print("  bytes per document       : {:,.0f}".format(s.get("active", 0) / docs if docs else 0))' \
  || echo "  ! CouchDB not reachable"

# ---------------------------------------------------------------- 7. timing
section "7. INDEPENDENT TIMING (curl, not the Node harness)"
echo "The experiment timed itself with process.hrtime. curl is a different"
echo "program with a different clock path. If the two disagree, distrust both."
echo
if [ -n "${TOKEN}" ]; then
  for LABEL in "point read:/records/REC-FIR-001" \
               "rich query:/records?owningStation=PS-Central" \
               "audit trail:/audit/trail/REC-FIR-001"; do
    NAME="${LABEL%%:*}"; PATH_PART="${LABEL#*:}"
    printf '  %-12s' "${NAME}"
    for _ in 1 2 3; do
      T="$(curl -s -o /dev/null -w '%{time_total}' \
        -H "Authorization: Bearer ${TOKEN}" "${API}${PATH_PART}")"
      printf '%8.0f ms' "$(echo "${T} * 1000" | bc -l)"
    done
    printf '\n'
  done
else
  echo "  ! backend not reachable — skipped"
fi

hr
echo "Report written to: ${REPORT}"
hr
