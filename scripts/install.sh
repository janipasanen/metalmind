#!/usr/bin/env bash
#
# MetalMind installer — build from source, register the `metalmind` command,
# and set up the optional local-inference dependencies.
#
#   ./scripts/install.sh              # build + link + check dependencies
#   ./scripts/install.sh --with-mlx   # also create the MLX venv (Apple Silicon)
#   ./scripts/install.sh --with-model # also pull a local Ollama model
#   ./scripts/install.sh --all        # everything
#   ./scripts/install.sh --check      # report what is missing, change nothing
#
# Nothing is installed without asking except inside this repo. Homebrew
# packages and model downloads are always confirmed first, because they are
# large and touch the system.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MLX_VENV="$HOME/.local/share/metalmind/.venv"
CONFIG_DIR="${METALMIND_CONFIG_DIR:-$HOME/.config/metalmind}"
DEFAULT_LOCAL_MODEL="qwen3.5:4b-mlx"
DEFAULT_MLX_MODEL="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit"

WITH_MLX=0
WITH_MODEL=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --with-mlx)   WITH_MLX=1 ;;
    --with-model) WITH_MODEL=1 ;;
    --all)        WITH_MLX=1; WITH_MODEL=1 ;;
    --check)      CHECK_ONLY=1 ;;
    -h|--help)    sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }

confirm() {
  [ "$CHECK_ONLY" = "1" ] && return 1
  # No terminal (CI, piped output): skip optional steps quietly instead of
  # emitting a bash error about /dev/tty.
  if [ ! -r /dev/tty ]; then
    printf '  \033[33m!\033[0m %s — skipped (no terminal; re-run interactively)\n' "$1"
    return 1
  fi
  printf '  → %s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------- prerequisites
bold "Prerequisites"

MISSING_REQUIRED=0

if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 20 ]; then ok "node $(node -v)"; else
    fail "node $(node -v) — MetalMind needs Node 20 or newer"; MISSING_REQUIRED=1
  fi
else
  fail "node not found — install Node 20+ (https://nodejs.org or nvm)"; MISSING_REQUIRED=1
fi

have npm && ok "npm $(npm -v)" || { fail "npm not found"; MISSING_REQUIRED=1; }

# Native addons (better-sqlite3, tree-sitter) are compiled by node-gyp.
if [ "$(uname -s)" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode Command Line Tools"
  else
    fail "Xcode CLT missing — run: xcode-select --install  (needed to build native addons)"
    MISSING_REQUIRED=1
  fi
fi

# ripgrep: search/findFiles degrade without it, and replaceInProject HARD FAILS.
if have rg; then
  ok "ripgrep $(rg --version | head -1 | awk '{print $2}')"
else
  warn "ripgrep not found — search is slower and replaceInProject will not work"
  if have brew && confirm "Install ripgrep with Homebrew?"; then
    brew install ripgrep && ok "ripgrep installed"
  else
    warn "install manually: brew install ripgrep"
  fi
fi

# Ollama powers tier 2 (local) and tier 3 (cloud, via api.ollama.com).
if have ollama; then
  ok "ollama $(ollama --version 2>&1 | awk '{print $NF}')"
  if curl -sf -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    ok "ollama daemon is running"
  else
    warn "ollama installed but not running — start it with: ollama serve"
  fi
else
  warn "ollama not found — no local tier-2 model and no cloud tier"
  if have brew && confirm "Install ollama with Homebrew?"; then
    brew install ollama && ok "ollama installed (start it with: ollama serve)"
  else
    warn "install manually: brew install ollama   (or https://ollama.com/download)"
  fi
fi

if [ "$MISSING_REQUIRED" = "1" ]; then
  echo
  fail "Required prerequisites are missing — fix the items above and re-run."
  exit 1
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo
  bold "Check complete (nothing was installed)."
  exit 0
fi

# ----------------------------------------------------------------------- build
echo
bold "Building"
cd "$REPO_ROOT"
[ -d node_modules ] || { npm install; ok "dependencies installed"; }
npm run build >/dev/null
ok "built apps/tui/dist/index.js"
node apps/tui/dist/index.js --version >/dev/null && ok "bundle runs"

# ------------------------------------------------------------------- install
echo
bold "Installing the metalmind command"
# `npm link` registers a symlink into the active Node prefix and keeps pointing
# at THIS checkout, so a later `npm run build` updates the installed command
# with no reinstall. That is what you want for a source install.
npm link -w metalmind >/dev/null 2>&1
if have metalmind; then
  ok "metalmind → $(command -v metalmind)"
else
  warn "npm link succeeded but 'metalmind' is not on PATH"
  warn "add your npm prefix to PATH: export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
fi

# --------------------------------------------------------------------- config
echo
bold "Configuration"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR" 2>/dev/null || true
ok "config dir $CONFIG_DIR (0700 — it holds API keys)"
[ -f "$CONFIG_DIR/config.json" ] && chmod 600 "$CONFIG_DIR/config.json" 2>/dev/null || true
if [ -n "${OLLAMA_API_KEY:-}" ]; then
  ok "OLLAMA_API_KEY is set — the cloud tier will be auto-detected"
else
  warn "OLLAMA_API_KEY not set — export it for the cloud tier, or use /apikey in the app"
fi

# ------------------------------------------------------------ local tier-2 model
if [ "$WITH_MODEL" = "1" ]; then
  echo
  bold "Local model (tier 2)"
  if have ollama && curl -sf -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$DEFAULT_LOCAL_MODEL"; then
      ok "$DEFAULT_LOCAL_MODEL already installed"
    elif confirm "Pull $DEFAULT_LOCAL_MODEL (a few GB)?"; then
      ollama pull "$DEFAULT_LOCAL_MODEL" && ok "$DEFAULT_LOCAL_MODEL installed"
    fi
  else
    warn "ollama is not running — start it (ollama serve) then: ollama pull $DEFAULT_LOCAL_MODEL"
  fi
fi

# ------------------------------------------------------------- MLX sidecar (tier 1)
if [ "$WITH_MLX" = "1" ]; then
  echo
  bold "MLX sidecar (tier 1, Apple Silicon GPU)"
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    warn "not Apple Silicon — skipping (tier 1 falls back to a local Ollama model)"
  elif ! have python3; then
    warn "python3 not found — skipping MLX setup"
  else
    if [ ! -x "$MLX_VENV/bin/python3" ]; then
      mkdir -p "$(dirname "$MLX_VENV")"
      python3 -m venv "$MLX_VENV"
      ok "created venv at $MLX_VENV"
    fi
    if "$MLX_VENV/bin/python3" -c "import mlx_lm" >/dev/null 2>&1; then
      ok "mlx-lm already installed in the venv"
    else
      "$MLX_VENV/bin/python3" -m pip install --quiet --upgrade mlx-lm fastapi uvicorn
      if "$MLX_VENV/bin/python3" -c "import mlx_lm" >/dev/null 2>&1; then
        ok "mlx-lm, fastapi, uvicorn installed"
      else
        # A half-built venv would be PREFERRED by the launcher forever, so remove it.
        rm -rf "$MLX_VENV"
        fail "mlx-lm install failed — removed the incomplete venv so MetalMind falls back cleanly"
      fi
    fi

    if [ -x "$MLX_VENV/bin/python3" ] && confirm "Download the MLX model $DEFAULT_MLX_MODEL (~4GB)?"; then
      "$MLX_VENV/bin/python3" -m mlx_lm generate --model "$DEFAULT_MLX_MODEL" --prompt hi --max-tokens 4 >/dev/null 2>&1 \
        && ok "model cached in ~/.cache/huggingface" \
        || warn "download failed — retry manually (see README)"
    fi
  fi
fi

# ----------------------------------------------------------------------- done
echo
bold "Done"
echo "  Run it:            metalmind"
echo "  Diagnose setup:    metalmind  → /doctor"
echo "  Routing mode:      /routing on|off   (AUTO/CLOUD badge in the status bar)"
if [ "$WITH_MLX" = "1" ]; then
  echo
  echo "  Start the MLX sidecar (tier 1) in its own terminal:"
  echo "    $MLX_VENV/bin/python3 $REPO_ROOT/scripts/mlx-sidecar.py --model $DEFAULT_MLX_MODEL"
  echo "  Launching via the 'metalmind' command starts it automatically when the"
  echo "  venv has mlx-lm; 'npm run dev' does NOT."
fi
