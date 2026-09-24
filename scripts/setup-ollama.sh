#!/usr/bin/env bash
#
# Start the local LLM used by the explainable-AI module and pull its model.
#
# Ollama runs as an ordinary program on this Mac, NOT inside Docker, so it does
# not compete with the Fabric containers for memory.
#
# Usage: ./scripts/setup-ollama.sh [model]

set -euo pipefail

MODEL="${1:-llama3.2:3b}"

info() { printf '\n\033[0;34m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

info "Checking Ollama is installed"
command -v ollama >/dev/null 2>&1 || die "ollama not found. Install it with: brew install ollama"
printf 'ollama: %s\n' "$(ollama --version 2>&1 | head -1)"

info "Making sure the Ollama server is running"
if curl -s --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "already running on port 11434"
else
  echo "starting ollama serve in the background (log: /tmp/ollama.log)"
  nohup ollama serve > /tmp/ollama.log 2>&1 &
  for _ in $(seq 1 20); do
    if curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -s --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1 \
    || die "ollama did not start — see /tmp/ollama.log"
  echo "started"
fi

info "Pulling model '${MODEL}' (skipped if already present)"
if ollama list | awk '{print $1}' | grep -qx "${MODEL}"; then
  echo "already downloaded"
else
  ollama pull "${MODEL}"
fi

info "Models available locally"
ollama list

info "Ready"
cat <<EOF
The backend picks up the model automatically. To use a different one:

  OLLAMA_MODEL=llama3.1:8b npm start        (from backend/)

If Ollama is stopped, the app still works — explanations fall back to
deterministic template wording and nothing errors.
EOF
