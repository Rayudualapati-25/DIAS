#!/usr/bin/env bash
#
# Regenerate every figure, table and paper document from the result files.
#
# The interpreter is chosen rather than assumed: `python3` on this machine can
# resolve to a build without numpy depending on how the shell was started, which
# silently breaks regeneration. This picks the first interpreter that actually
# has the plotting and statistics stack, and says which one it used.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

pick_python() {
  local candidates=("${SEAL_PYTHON:-}" /opt/anaconda3/bin/python3.13 /usr/local/bin/python3 python3)
  for c in "${candidates[@]}"; do
    [[ -z "$c" ]] && continue
    local bin; bin="$(command -v "$c" 2>/dev/null)" || continue
    if "$bin" -c "import numpy, matplotlib, scipy" >/dev/null 2>&1; then echo "$bin"; return 0; fi
  done
  echo "no interpreter with numpy, matplotlib and scipy found" >&2
  return 1
}

PY="$(pick_python)"
echo "using $PY"
"$PY" -c "import numpy,matplotlib,scipy;print(f'  numpy {numpy.__version__}  matplotlib {matplotlib.__version__}  scipy {scipy.__version__}')"
echo

for script in make_01_02.py make_ablation_analysis.py make_stats.py make_03_04.py make_results_text.py make_limitations.py make_docs.py; do
  echo "--- $script"
  "$PY" "$script"
done
echo
echo "done."
