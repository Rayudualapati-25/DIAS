#!/usr/bin/env bash
#
# Read the direct-ledger access events and describe Fabric's integrity controls.
#
# Usage: ./scripts/verify-access-log.sh

set -uo pipefail

API="${API_BASE:-http://localhost:3001/api}"

info() { printf '\n\033[0;34m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

curl -s --max-time 3 "${API}/health" >/dev/null 2>&1 \
  || die "backend is not reachable at ${API} — start it with: cd backend && npm start"

info "Signing in as the auditor"
TOKEN="$(curl -s -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"sp.north"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const j=JSON.parse(d); if(!j.success){console.error(j.error);process.exit(1);}
      console.log(j.data.token);})')" || die "login failed"

info "Reading ledger events and Fabric integrity description"
curl -s "${API}/audit/access-log/verify" -H "Authorization: Bearer ${TOKEN}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const j=JSON.parse(d); if(!j.success){console.error(j.error);process.exit(1);}
      const r=j.data;
      console.log(`  events returned : ${r.entriesChecked}`);
      console.log(`  storage         : ${r.storage}`);
      console.log(`  mechanism       : ${r.mechanism}`);
      if (r.ok) {
        console.log("\n  \x1b[0;32mLEDGER READ SUCCEEDED\x1b[0m — events are Fabric transactions.");
        process.exit(0);
      }
      process.exit(1);
    })'
