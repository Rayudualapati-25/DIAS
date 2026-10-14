#!/usr/bin/env bash
#
# The 100-user part of the campaign (author's decision, 2026-10-14: at least 100
# users; register them; a one-hour run and a burst of 100 per setup; both models).
# It starts when the first campaign (run-campaign.sh) has finished and the 100
# officers are registered.
#
#   untuned  hour (200 requests from 100 officers over one hour), then a burst of 100 per setup
#   v7       serve V7, restart the backend with V7's identity; hour, then the bursts
#   end      serve the untuned model again and restart the backend as it was
#
# CPU and memory are sampled every 5 s during each run (resource-sampler.js).
#
# usage: run-campaign-100.sh

set -u
REPO="/Users/venkatrayudu/Workspace/XAI workspace/DIAS"
cd "$REPO" || exit 1
R=experiments/runs/20261014_mac_mobile_setups
PLAN=$R/plan-100.json
STAGING=backend/data/dias-reviews/host-20261006/access-events
V7_RELATIVE=LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7
V7_PATH="$REPO/$V7_RELATIVE"
V7_HASH=348f4ca5707e35afda2b35522ab6bb7c0527d84be23de80253a0c358ae1fd43d
SAMPLER=""

log() { echo "$(date '+%F %T') $*" | tee -a "$R/campaign.log"; }
fail() { stop_sampler; log "STOP (100 users): $*"; exit 1; }

model_pids() { pgrep -f "mlx_lm.server.*--port 8081"; }
backend_pids() { pgrep -f "node backend/src/server.js"; }
port_free() { ! lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
staging_empty() { [ -z "$(ls "$STAGING" 2>/dev/null)" ]; }
model_answers() { curl -s -m 5 http://127.0.0.1:8081/v1/models | grep -q "Qwen3-14B-4bit"; }
backend_answers() { curl -s -m 2 http://127.0.0.1:3001/api/health | grep -q '"ok"'; }

host_idle() {
  node -e '
    const { createClient } = require("./experiments/e2e/lib");
    (async () => {
      const client = createClient("http://127.0.0.1:3001/api");
      const pending = await client.get("/access/auditor/pending", "sp.north");
      const active = await client.get("/access/dynamic-authorizations?status=active", "sp.north");
      process.exit(pending.status === 200 && active.status === 200 && pending.data.length === 0 && active.data.length === 0 ? 0 : 1);
    })().catch(() => process.exit(1));'
}

wait_for() { # seconds, description, command...
  local seconds=$1 what=$2; shift 2
  for _ in $(seq 1 "$seconds"); do "$@" && return 0; sleep 1; done
  fail "$what did not happen within $seconds s"
}

warm_model() {
  curl -s -m 300 http://127.0.0.1:8081/v1/chat/completions -H 'Content-Type: application/json' \
    -d "{\"model\":\"default_model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK.\"}]$1}" \
    > /dev/null || fail "the model server did not answer a warm-up call"
}

# mlx_lm 0.31.3 applies an adapter only to requests that name it; the backend names it (DIAS_ADAPTER_PATH).
serve_model() {
  local label=$1 adapter=${2:-}
  for pid in $(model_pids); do kill "$pid"; done
  wait_for 120 "the old model server stopping" port_free 8081
  ( nohup make dias-model ${adapter:+DIAS_ADAPTER="$adapter"} >> "$R/$label/model-server.log" 2>&1 & )
  wait_for 600 "the model server answering" model_answers
  warm_model "${adapter:+,\"adapters\":\"$REPO/$adapter\"}"
  log "$label (100 users): model server up $(model_pids | tr '\n' ' ')(adapter: ${adapter:-none})"
}

restart_backend() {
  local label=$1 model=${2:-untuned}
  wait_for 1800 "the access-event staging folder emptying" staging_empty
  for pid in $(backend_pids); do kill "$pid"; done
  wait_for 120 "the old backend stopping" port_free 3001
  if [ "$model" = v7 ]; then
    ( DIAS_MODEL_ID=qwen3-14b-dias-v7 DIAS_ADAPTER_ID=qwen3-14b-dias-lora-v7 DIAS_ADAPTER_HASH=$V7_HASH \
      DIAS_ADAPTER_PATH="$V7_PATH" nohup make dias-backend >> "$R/$label/backend.log" 2>&1 & )
  else
    ( nohup make dias-backend >> "$R/$label/backend.log" 2>&1 & )
  fi
  wait_for 120 "the backend answering" backend_answers
  log "$label (100 users): backend up $(backend_pids | tr '\n' ' ')(model: $model)"
}

start_sampler() { # folder
  mkdir -p "$1"
  node experiments/e2e/resource-sampler.js --out "$1/resources.jsonl" --every 5 > "$1/resources.log" 2>&1 &
  SAMPLER=$!
}
stop_sampler() { if [ -n "$SAMPLER" ]; then kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null; SAMPLER=""; fi; }

hundred_users() {
  local label=$1
  for part in hour bursts100; do
    if [ -e "$R/$label/$part/rows.jsonl" ]; then log "$label $part: already run, skipped"; continue; fi
    host_idle || fail "the host is not idle before $label $part"
    start_sampler "$R/$label/$part"
    log "$label $part: start"
    if [ "$part" = hour ]; then
      node experiments/e2e/setup-hour.js --plan "$PLAN" --out "$R/$label/$part" --staging "$STAGING" > "$R/$label/$part.log" 2>&1
    else
      node experiments/e2e/setup-load.js --plan "$PLAN" --out "$R/$label/$part" --staging "$STAGING" > "$R/$label/$part.log" 2>&1
    fi
    local code=$?
    stop_sampler
    log "$label $part: exit $code ($(tail -1 "$R/$label/$part.log"))"
  done
}

until grep -q "campaign finished" "$R/campaign.log" && grep -q "registration: exit 0" "$R/campaign.log"; do
  grep -q "STOP" "$R/campaign.log" && { echo "the first campaign stopped; not starting"; exit 1; }
  sleep 30
done

log "100 users: start"
model_answers || fail "the untuned model server is not answering"
hundred_users untuned

host_idle || fail "the host is not idle before switching to V7"
[ "$(shasum -a 256 "$V7_PATH/adapters.safetensors" | cut -d' ' -f1)" = "$V7_HASH" ] || fail "the V7 adapter does not match its recorded hash"
serve_model v7 "$V7_RELATIVE"
restart_backend v7 v7
hundred_users v7

serve_model restore
restart_backend restore untuned
log "100 users: finished; the untuned model and the backend are back as before the campaign"
