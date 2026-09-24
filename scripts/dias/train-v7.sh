#!/usr/bin/env bash
#
# Launch a DIAS V7 LoRA training run under nohup with a complete record.
#
# Long runs must survive losing a terminal, so this is written to be started
# detached and inspected afterwards from the files it leaves behind. It refuses
# to start if the configuration could damage V6 or resume from an existing
# adapter, because those are the two mistakes that are unrecoverable rather than
# merely wasteful.
#
#   nohup scripts/dias/train-v7.sh experiments/dias-finetuning/train-v7.yaml \
#         experiments/runs/<date>_dias_qwen3_lora_v7 > /dev/null 2>&1 &
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Resolve both paths before anything changes directory: the run cds into
# LLMxAI/ (where mlx_lm expects to run) and a relative config would stop
# resolving there, which fails only AFTER the preflight has already passed.
CONFIG="$(cd "$(dirname "${1:?usage: train-v7.sh <config.yaml> <run-dir>}")" && pwd)/$(basename "$1")"
mkdir -p "${2:?usage: train-v7.sh <config.yaml> <run-dir>}"
RUN_DIR="$(cd "$2" && pwd)"
PYTHON="${REPO}/.venv-qwen-policy/bin/python"

V6_ADAPTER="/Users/venkatrayudu/Workspace/XAI workspace/crime-records-network/LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v6-best/adapters.safetensors"
V6_SHA="5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe"

LOG="${RUN_DIR}/training.log"

# The enclosing block redirects both streams to the log, so this writes once.
# The caller surfaces it to the terminal after the block exits.
fail() { echo "PREFLIGHT FAILED: $1"; exit 1; }

{
  echo "=== preflight $(date -u +%FT%TZ) ==="

  # 1. V6 must be exactly what it was. Checked before the run, and again after.
  actual="$(shasum -a 256 "${V6_ADAPTER}" | cut -d' ' -f1)"
  [ "${actual}" = "${V6_SHA}" ] || fail "V6 adapter digest changed (${actual})"
  echo "V6 adapter intact: ${V6_SHA}"

  # 2. No resume. A V7 run that resumes from anything is not a fresh model.
  #    Match an actual top-level key, not a mention in a comment: the config
  #    documents why the key is absent, and a naive grep would refuse every run.
  grep -Eq '^[[:space:]]*resume_adapter_file[[:space:]]*:' "${CONFIG}" \
    && fail "config sets resume_adapter_file"
  echo "no resume_adapter_file key"

  # 3. The output directory must not be a V6 one, and must not already hold
  #    weights from a different run that this would silently overwrite.
  ADAPTER_REL="$(grep '^adapter_path:' "${CONFIG}" | awk '{print $2}')"
  case "${ADAPTER_REL}" in
    *seba*|*v6*) fail "adapter_path '${ADAPTER_REL}' points at a SEAL/V6 directory" ;;
  esac
  ADAPTER_ABS="${REPO}/LLMxAI/${ADAPTER_REL}"
  if [ -f "${ADAPTER_ABS}/adapters.safetensors" ]; then
    fail "adapter_path already holds weights: ${ADAPTER_ABS} (move or rename it first)"
  fi
  echo "adapter_path is new: ${ADAPTER_ABS}"

  # 4. Enough disk for checkpoints.
  FREE_GB="$(df -g "${REPO}" | tail -1 | awk '{print $4}')"
  [ "${FREE_GB}" -ge 20 ] || fail "only ${FREE_GB} GB free"
  echo "disk free: ${FREE_GB} GB"

  echo "config sha256: $(shasum -a 256 "${CONFIG}" | cut -d' ' -f1)"
  echo "=== training $(date -u +%FT%TZ) ==="
} >> "${LOG}" 2>&1 || { tail -1 "${LOG}" >&2; exit 1; }

cat > "${RUN_DIR}/run.json" <<JSON
{
  "status": "running",
  "startedAtUtc": "$(date -u +%FT%TZ)",
  "config": "${CONFIG}",
  "configSha256": "$(shasum -a 256 "${CONFIG}" | cut -d' ' -f1)",
  "runDir": "${RUN_DIR}",
  "baseModel": "mlx-community/Qwen3-14B-4bit",
  "baseModelRevision": "a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4",
  "v6AdapterSha256AtStart": "${V6_SHA}"
}
JSON

cd "${REPO}/LLMxAI" || exit 1
"${PYTHON}" -m mlx_lm lora --config "${CONFIG}" >> "${LOG}" 2>&1
EXIT=$?

# V6 must still be untouched afterwards. A training run has no business writing
# there, so a change means something went badly wrong and must be visible.
AFTER="$(shasum -a 256 "${V6_ADAPTER}" | cut -d' ' -f1)"
[ "${AFTER}" = "${V6_SHA}" ] && V6_OK=true || V6_OK=false

ADAPTER_REL="$(grep '^adapter_path:' "${CONFIG}" | awk '{print $2}')"
ADAPTER_ABS="${REPO}/LLMxAI/${ADAPTER_REL}"
if [ -f "${ADAPTER_ABS}/adapters.safetensors" ]; then
  FINAL_SHA="$(shasum -a 256 "${ADAPTER_ABS}/adapters.safetensors" | cut -d' ' -f1)"
else
  FINAL_SHA="null"
fi

python3 - "${RUN_DIR}/run.json" "${EXIT}" "${V6_OK}" "${FINAL_SHA}" <<'PY'
import json, sys, datetime
path, exit_code, v6_ok, final_sha = sys.argv[1:5]
record = json.load(open(path))
record.update({
    "status": "completed" if exit_code == "0" else "failed",
    "exitCode": int(exit_code),
    "finishedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "v6AdapterIntactAfterRun": v6_ok == "true",
    "finalAdapterSha256": None if final_sha == "null" else final_sha,
})
json.dump(record, open(path, "w"), indent=2)
print(json.dumps(record, indent=2))
PY

echo "=== finished $(date -u +%FT%TZ) exit=${EXIT} v6_intact=${V6_OK} ===" >> "${LOG}"
exit "${EXIT}"
