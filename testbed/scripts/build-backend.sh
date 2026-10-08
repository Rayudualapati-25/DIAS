#!/usr/bin/env bash
# Stage the backend sources into the shared testbed folder and build the
# dias-backend:testbed image on M4. Prints the hash of the staged sources.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="${TB:-${HOME}/dias-testbed}"
B="${TB}/build/app"
if [ -d "$B" ]; then
  mkdir -p "${TB}/staging-history"
  mv "$B" "${TB}/staging-history/backend-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
mkdir -p "$B/backend" "$B/chaincode/crimerecords" "$B/policies" "$B/testbed" "$B/scripts"
rsync -a "$REPO/backend/package.json" "$REPO/backend/package-lock.json" "$B/backend/"
rsync -a "$REPO/backend/src" "$B/backend/"
rsync -a "$REPO/chaincode/crimerecords/lib" "$B/chaincode/crimerecords/"
rsync -a "$REPO/policies/lib" "$REPO/policies/reference-oracle" "$REPO/policies/dias-governance-policy-v1.json" "$B/policies/"
rsync -a --exclude node_modules "$REPO/frontend" "$B/"
rsync -a "$REPO/testbed/seed" "$REPO/testbed/load" "$REPO/testbed/reuse" "$B/testbed/"
rsync -a "$REPO/scripts/dias" "$B/scripts/"
cp "$REPO/testbed/backend/Dockerfile" "$B/Dockerfile"
HASH="$(cd "$B" && find . -type f -not -name Dockerfile | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | awk '{print $1}')"
echo "$HASH" > "${TB}/build/BACKEND_SOURCE_SHA256"
if [ "${1:-}" = "--stage-only" ]; then
  echo "backend staged from sources sha256 ${HASH}; image not built"
  exit 0
fi
docker --context lima-dias-m4 build -q -t dias-backend:testbed "$B" >/dev/null
echo "backend image built from sources sha256 ${HASH}"
