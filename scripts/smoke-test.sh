#!/usr/bin/env bash
# Run the live DIAS API suite. The DIAS backend (make dias-backend) and the model
# server (make dias-model) must already be running against diaschannel.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${API_BASE:-http://localhost:3001/api}"

curl -fsS --max-time 3 "${API}/health" >/dev/null || {
  echo "backend is not reachable at ${API}" >&2
  echo "start it in another terminal with: make dias-backend" >&2
  exit 1
}

echo "Running the live DIAS API suite against ${API}..."
cd "${PROJECT_DIR}/backend"
API_BASE="${API}" npx mocha test/api.live.test.js --timeout 600000
