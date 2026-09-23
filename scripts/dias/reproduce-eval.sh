#!/usr/bin/env bash
#
# Reproduce a retained DIAS model evaluation and write a complete run record.
#
#   scripts/dias/reproduce-eval.sh <adapter-dir|none> <run-dir> <port> <sets> [limit]
#
#   adapter-dir  LoRA adapter directory, or "none" for the untuned base model
#   run-dir      new directory under experiments/runs/ (must not exist, or must
#                hold only an earlier partial attempt of the same command)
#   port         local port for the temporary mlx_lm server (never 8080/8081)
#   sets         comma-separated held-out sets, e.g. test-decision-balanced
#   limit        optional: evaluate only the first N examples of each set
#
# The server runs with HF_HUB_OFFLINE=1 so the cached base-model revision is
# used and no network call can change the weights. Decoding is fixed by the
# harness (temperature 0, top_p 1, thinking disabled, 512 tokens). Every run
# directory records config.json, environment.json, command.txt, timestamps,
# evaluation.log, server.log, predictions/, metrics.json and exit_status.json.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADAPTER="${1:?usage: reproduce-eval.sh <adapter-dir|none> <run-dir> <port> <sets> [limit]}"
RUN_DIR="${2:?missing run-dir}"
PORT="${3:?missing port}"
SETS="${4:?missing sets}"
LIMIT="${5:-}"
cd "$REPO" || exit 1

case "$PORT" in
  8080|8081) echo "refusing port ${PORT}: reserved for the V6 service and make dias-model" >&2; exit 2 ;;
esac
mkdir -p "$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" && pwd)"
LOG="${RUN_DIR}/evaluation.log"
STARTED="$(date -u +%FT%TZ)"
printf '%q ' "$0" "$@" > "${RUN_DIR}/command.txt"; echo >> "${RUN_DIR}/command.txt"

if [ "$ADAPTER" = "none" ]; then
  ADAPTER_ARGS=(); EVAL_ADAPTER_ARGS=(); ADAPTER_SHA="null"; LABEL="untuned-qwen3-14b-4bit"; MODEL_ID="qwen3-14b-4bit-untuned"
else
  case "$ADAPTER" in /*) ;; *) ADAPTER="${REPO}/${ADAPTER}" ;; esac
  if [ ! -f "${ADAPTER}/adapters.safetensors" ]; then
    echo "no adapter weights at ${ADAPTER}" | tee -a "$LOG" >&2; exit 1
  fi
  ADAPTER_SHA="$(shasum -a 256 "${ADAPTER}/adapters.safetensors" | cut -d' ' -f1)"
  ADAPTER_ARGS=(--adapter-path "${ADAPTER}")
  LABEL="qwen3-14b-dias-v7"; MODEL_ID="qwen3-14b-dias-v7"
  EVAL_ADAPTER_ARGS=(--model-id "$MODEL_ID" --adapter-id "$(basename "$ADAPTER")" --adapter-hash "$ADAPTER_SHA" --adapter-path "$ADAPTER")
fi

node - "$RUN_DIR" "$ADAPTER" "$ADAPTER_SHA" "$PORT" "$SETS" "$LIMIT" "$STARTED" "$LABEL" <<'NODE'
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { execSync } = require('child_process');
const [runDir, adapter, adapterSha, port, sets, limit, started, label] = process.argv.slice(2);
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return null; } };
const data = 'experiments/dias-finetuning/data-v2-binary';
const setHashes = Object.fromEntries(sets.split(',').map((s) => {
  const f = path.join(data, `${s}.cases.jsonl`);
  return [s, { file: f, sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') }];
}));
const config = {
  purpose: 'reproduce a retained DIAS model evaluation with the current checkout',
  label, startedAtUtc: started,
  baseModel: 'mlx-community/Qwen3-14B-4bit', baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4',
  adapterPath: adapter === 'none' ? null : path.relative(process.cwd(), adapter),
  adapterSha256: adapterSha === 'null' ? null : adapterSha,
  server: { binary: '.venv-qwen-policy/bin/mlx_lm.server', port: Number(port), maxTokens: 512,
    chatTemplateArgs: { enable_thinking: false }, env: { HF_HUB_OFFLINE: '1' } },
  decoding: { temperature: 0, topP: 1, maxTokens: 512, thinking: 'disabled', seed: 'not applicable (greedy decoding)' },
  harness: 'experiments/dias-finetuning/v2/eval/evaluate.js -> backend/src/dias/recommender.js',
  sets: setHashes, limit: limit ? Number(limit) : null,
  git: { commit: sh('git rev-parse HEAD'), branch: sh('git branch --show-current'),
    dirtyFiles: Number(sh('git status --porcelain | wc -l')),
    promptPathDiffVsHead: sh('git diff --stat HEAD -- backend/src/dias/recommender.js backend/src/dias/recommendationPrompt.js backend/src/dias/recommendationContract.js backend/src/dias/policyContextProvider.js chaincode/crimerecords/lib/dias/recommendationSchema.js policies experiments/dias-finetuning/v2/eval') || '' },
};
const env = {
  node: process.version,
  mlxLm: sh(".venv-qwen-policy/bin/python -c \"import importlib.metadata as m; print(m.version('mlx-lm'))\""),
  mlx: sh(".venv-qwen-policy/bin/python -c \"import importlib.metadata as m; print(m.version('mlx'))\""),
  python: sh('.venv-qwen-policy/bin/python --version'),
  os: sh('sw_vers -productName') + ' ' + sh('sw_vers -productVersion') + ' (' + sh('sw_vers -buildVersion') + ')',
  chip: sh('sysctl -n machdep.cpu.brand_string'),
  memoryBytes: Number(sh('sysctl -n hw.memsize')),
  cpuCount: Number(sh('sysctl -n hw.ncpu')),
};
fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
fs.writeFileSync(path.join(runDir, 'environment.json'), JSON.stringify(env, null, 2) + '\n');
NODE

echo "=== ${STARTED} serving ${ADAPTER} (sha256 ${ADAPTER_SHA}) on :${PORT} ===" >> "$LOG"
HF_HUB_OFFLINE=1 .venv-qwen-policy/bin/mlx_lm.server \
  --model mlx-community/Qwen3-14B-4bit "${ADAPTER_ARGS[@]}" \
  --host 127.0.0.1 --port "${PORT}" --max-tokens 512 \
  --chat-template-args '{"enable_thinking":false}' >> "${RUN_DIR}/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null' EXIT

for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then break; fi
  sleep 5
done
STATUS=0
if ! curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
  echo "server did not become ready on :${PORT}" | tee -a "$LOG" >&2
  STATUS=3
else
  echo "=== $(date -u +%FT%TZ) server ready ===" >> "$LOG"
  LIMIT_ARGS=(); [ -n "$LIMIT" ] && LIMIT_ARGS=(--limit "$LIMIT")
  node experiments/dias-finetuning/v2/eval/evaluate.js \
    --label "$LABEL" --url "http://127.0.0.1:${PORT}/v1" "${EVAL_ADAPTER_ARGS[@]}" \
    --sets "$SETS" "${LIMIT_ARGS[@]}" --skip-existing --out "$RUN_DIR" >> "$LOG" 2>&1 || STATUS=$?
fi
FINISHED="$(date -u +%FT%TZ)"
echo "=== ${FINISHED} done (exit ${STATUS}) ===" >> "$LOG"
printf '{\n  "startedAtUtc": "%s",\n  "finishedAtUtc": "%s",\n  "exitStatus": %s\n}\n' "$STARTED" "$FINISHED" "$STATUS" > "${RUN_DIR}/exit_status.json"
exit "$STATUS"
