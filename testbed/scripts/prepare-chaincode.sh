#!/usr/bin/env bash
# Stage a reproducible v3 package with production dependencies. No ledger writes.
# TB=/absolute/testbed-directory testbed/scripts/prepare-chaincode.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="${TB:-${HOME}/dias-testbed}"
STAGE="${TB}/chaincode-staging"
mkdir -p "${TB}"
NEXT="$(mktemp -d "${TB}/chaincode-staging.XXXXXX")"
mkdir -p "${NEXT}/src"
cp "${REPO}/chaincode/crimerecords/"{index.js,package.json,package-lock.json} "${NEXT}/src/"
cp -R "${REPO}/chaincode/crimerecords/lib" "${NEXT}/src/lib"
# Hash the deployable source paths and bytes, excluding installed dependencies.
node - "${NEXT}/src" > "${NEXT}/SOURCE_SHA256" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.argv[2];
function files(dir) {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const p = path.join(dir, name);
    return fs.statSync(p).isDirectory() ? files(p) : [p];
  });
}
const hash = crypto.createHash('sha256');
for (const file of files(root)) hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
console.log(hash.digest('hex'));
NODE
(cd "${NEXT}/src" && npm ci --omit=dev --no-audit --no-fund)
if [ -d "${STAGE}" ]; then
  mkdir -p "${TB}/staging-history"
  mv "${STAGE}" "${TB}/staging-history/chaincode-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
mv "${NEXT}" "${STAGE}"
printf 'Staged source SHA-256: %s\n' "$(cat "${STAGE}/SOURCE_SHA256")"
