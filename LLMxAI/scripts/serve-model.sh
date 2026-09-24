#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
network_root=$(CDPATH= cd -- "$project_root/.." && pwd)
if [ -n "${LLMXAI_MLX_SERVER:-}" ]; then
  server_bin=$LLMXAI_MLX_SERVER
elif [ -x "$project_root/.venv/bin/mlx_lm.server" ]; then
  server_bin="$project_root/.venv/bin/mlx_lm.server"
else
  server_bin="$network_root/.venv-qwen-policy/bin/mlx_lm.server"
fi
adapter_path=${LLM_POLICY_ADAPTER_PATH:-"$project_root/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v4-best"}

if [ ! -x "$server_bin" ]; then
  echo "MLX-LM server was not found at $server_bin" >&2
  echo "Create the environment and install experiments/llm_policy_engine/requirements.txt first." >&2
  exit 1
fi

exec "$server_bin" \
  --model mlx-community/Qwen3-14B-4bit \
  --adapter-path "$adapter_path" \
  --host 127.0.0.1 \
  --port 8080 \
  --max-tokens 192 \
  --chat-template-args '{"enable_thinking":false}'
