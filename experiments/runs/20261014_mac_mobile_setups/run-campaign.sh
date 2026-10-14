#!/usr/bin/env bash
#
# The three-setup campaign of 2026-10-14, as it is run (plan:
# experiments/plans/20261014_three_setups_two_models.md).
#
#   untuned  A steps, B reuse, C load            (D, the 600 cases, ran before)
#   v7       serve V7, restart the backend with V7's identity; A, B, C, then D
#   end      serve the untuned model again and restart the backend as it was
#
# Every runner refuses to start unless the host is idle (nothing waiting, no
# authorization active), so a part that fails and leaves something behind stops
# the parts after it. A model switch is checked before anything runs on it.
#
# usage: run-campaign.sh [untuned|v7|restore ...]   (default: untuned v7 restore)

set -u
REPO="/Users/venkatrayudu/Workspace/XAI workspace/DIAS"
cd "$REPO" || exit 1
R=experiments/runs/20261014_mac_mobile_setups
STAGING=backend/data/dias-reviews/host-20261006/access-events
# Make's abspath splits a path at spaces, so `make dias-model` gets the path relative to the repository.
V7_RELATIVE=LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7
V7_PATH="$REPO/$V7_RELATIVE"
V7_HASH=348f4ca5707e35afda2b35522ab6bb7c0527d84be23de80253a0c358ae1fd43d

log() { echo "$(date '+%F %T') $*" | tee -a "$R/campaign.log"; }
fail() { log "STOP: $*"; exit 1; }

model_pids() { pgrep -f "mlx_lm.server.*--port 8081"; }
backend_pids() { pgrep -f "node backend/src/server.js"; }
port_free() { ! lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

host_idle() {
  node -e '
    const { createClient } = require("./experiments/e2e/lib");
    (async () => {
      const client = createClient("http://127.0.0.1:3001/api");
      const pending = await client.get("/access/auditor/pending", "sp.north");
      const active = await client.get("/access/dynamic-authorizations?status=active", "sp.north");
      const idle = pending.status === 200 && active.status === 200 && pending.data.length === 0 && active.data.length === 0;
      process.exit(idle ? 0 : 1);
    })().catch(() => process.exit(1));'
}

staging_empty() { [ -z "$(ls "$STAGING" 2>/dev/null)" ]; }

wait_for() { # seconds, description, command...
  local seconds=$1 what=$2; shift 2
  for _ in $(seq 1 "$seconds"); do "$@" && return 0; sleep 1; done
  fail "$what did not happen within $seconds s"
}

model_answers() { curl -s -m 5 http://127.0.0.1:8081/v1/models | grep -q "Qwen3-14B-4bit"; }
backend_answers() { curl -s -m 2 http://127.0.0.1:3001/api/health | grep -q '"ok"'; }

# One short chat call straight to the model server, so the first workflow does not pay for loading.
warm_model() {
  curl -s -m 300 http://127.0.0.1:8081/v1/chat/completions -H 'Content-Type: application/json' \
    -d "{\"model\":\"default_model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK.\"}]$1}" \
    > /dev/null || fail "the model server did not answer a warm-up call"
}

# serve_model LABEL [ADAPTER, relative to the repository]: stop the model server on 8081 and start it again.
#
# mlx_lm 0.31.3 applies an adapter only to requests that name it (`adapters` in the
# request body; its start-up --adapter-path is not used for "default_model"). The
# backend and the evaluation both name it, with the same absolute path. The
# warm-up call names it too, so the adapter is loaded before the first workflow.
serve_model() {
  local label=$1 adapter=${2:-}
  for pid in $(model_pids); do kill "$pid"; done
  wait_for 120 "the old model server stopping" port_free 8081
  ( nohup make dias-model ${adapter:+DIAS_ADAPTER="$adapter"} >> "$R/$label/model-server.log" 2>&1 & )
  wait_for 600 "the model server answering" model_answers
  warm_model "${adapter:+,\"adapters\":\"$REPO/$adapter\"}"
  log "$label: model server up $(model_pids | tr '\n' ' ')(adapter: ${adapter:-none})"
}

# restart_backend LABEL [v7]: stop the backend and start it again with the model's identity.
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
  log "$label: backend up $(backend_pids | tr '\n' ' ')(model: $model)"
}

experiments_for() {
  local label=$1
  for part in steps reuse load; do
    if [ -e "$R/$label/$part/rows.jsonl" ]; then log "$label $part: already run, skipped"; continue; fi
    host_idle || fail "the host is not idle before $label $part"
    log "$label $part: start"
    node "experiments/e2e/setup-$part.js" --plan "$R/plan.json" --out "$R/$label/$part" --staging "$STAGING" \
      > "$R/$label/$part.log" 2>&1
    log "$label $part: exit $? ($(tail -1 "$R/$label/$part.log"))"
  done
}

quality_v7() {
  if [ -e "$R/v7/quality/metrics.json" ]; then log "v7 quality: already run, skipped"; return; fi
  log "v7 quality: start"
  node experiments/dias-finetuning/v2/eval/evaluate.js --prompt v2 --label v7-qwen3-14b-4bit \
    --url http://127.0.0.1:8081/v1 --sets test-decision-balanced --model-id qwen3-14b-dias-v7 \
    --adapter-id qwen3-14b-dias-lora-v7 --adapter-hash "$V7_HASH" --adapter-path "$V7_PATH" \
    --out "$R/v7/quality" > "$R/v7/quality.log" 2>&1
  log "v7 quality: exit $? ($(tr '\r' '\n' < "$R/v7/quality.log" | grep -E 'valid|written' | tail -2 | tr '\n' ' '))"
}

phase_untuned() {
  mkdir -p "$R/untuned"
  model_answers || fail "the untuned model server is not answering"
  experiments_for untuned
}

phase_v7() {
  mkdir -p "$R/v7"
  host_idle || fail "the host is not idle before switching to V7"
  [ "$(shasum -a 256 "$V7_PATH/adapters.safetensors" | cut -d' ' -f1)" = "$V7_HASH" ] || fail "the V7 adapter does not match its recorded hash"
  serve_model v7 "$V7_RELATIVE"
  restart_backend v7 v7
  experiments_for v7
  quality_v7
}

phase_restore() {
  mkdir -p "$R/restore"
  serve_model restore
  restart_backend restore untuned
  log "restore: the untuned model and the backend are back as before the campaign"
}

for phase in "${@:-untuned v7 restore}"; do
  for name in $phase; do
    case "$name" in
      untuned) phase_untuned ;;
      v7) phase_v7 ;;
      restore) phase_restore ;;
      *) fail "unknown phase $name" ;;
    esac
  done
done
log "campaign finished"
