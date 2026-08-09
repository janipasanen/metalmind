#!/usr/bin/env bash
# Start the MLX sidecar for tier 1, defaulting to the model configured in
# metalmind.yaml. Run this in its own terminal and leave it running.
#
#   ./scripts/start-mlx-sidecar.sh                 # model from metalmind.yaml
#   ./scripts/start-mlx-sidecar.sh <model-or-path> # explicit model
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PY="$HOME/.local/share/metalmind/.venv/bin/python3"

MODEL="${1:-}"
if [ -z "$MODEL" ] && [ -f "$REPO_ROOT/metalmind.yaml" ]; then
  # The `model:` line inside the local-mlx block.
  MODEL="$(awk '/local-mlx:/{f=1} f&&/model:/{print $2; exit}' "$REPO_ROOT/metalmind.yaml")"
fi
[ -n "$MODEL" ] || { echo "No model given and none found in metalmind.yaml" >&2; exit 2; }

[ -x "$VENV_PY" ] || { echo "MLX venv missing — run: ./scripts/install.sh --with-mlx" >&2; exit 1; }
"$VENV_PY" -c "import mlx_lm" 2>/dev/null || { echo "mlx-lm not installed in the venv — run: ./scripts/install.sh --with-mlx" >&2; exit 1; }

# A local directory must be fully downloaded: LM Studio leaves *.part files
# while a download is in flight, and mlx_lm would fail on a partial model.
if [ -d "$MODEL" ]; then
  if compgen -G "$MODEL"/*.part >/dev/null; then
    echo "Model is still downloading (found .part files in $MODEL)." >&2
    echo "Wait for it to finish, then re-run." >&2
    exit 1
  fi
  compgen -G "$MODEL"/*.safetensors >/dev/null || { echo "No .safetensors in $MODEL" >&2; exit 1; }
fi

if curl -sf -m 2 http://127.0.0.1:8742/health >/dev/null 2>&1; then
  echo "A sidecar is already running on 127.0.0.1:8742."
  exit 0
fi

echo "Starting MLX sidecar on 127.0.0.1:8742"
echo "  model: $MODEL"
echo "  (first load pulls the weights into memory — this can take minutes for a large model)"
exec "$VENV_PY" "$REPO_ROOT/scripts/mlx-sidecar.py" --model "$MODEL"
