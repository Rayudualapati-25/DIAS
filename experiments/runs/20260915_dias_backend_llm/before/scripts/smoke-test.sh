#!/usr/bin/env bash
# Run the live Fabric API story. The backend must already be listening on :3001.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${API_BASE:-http://localhost:3001/api}"

curl -fsS --max-time 3 "${API}/health" >/dev/null || {
  echo "backend is not reachable at ${API}" >&2
  echo "start it in another terminal with: make backend" >&2
  exit 1
}

echo "Running the eight contextual-policy scenarios against live Fabric..."
cd "${PROJECT_DIR}/backend"
npx mocha test/api.test.js --timeout 90000
