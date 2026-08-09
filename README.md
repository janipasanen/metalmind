# MetalMind

An agentic AI assistant for the terminal with intelligent three-tier routing: simple tasks run on-device (Apple Silicon MLX or local Ollama), complex tasks escalate to your configured cloud model automatically.

## Install

### Quick start (from source)

```bash
git clone https://github.com/janipasanen/metalmind
cd metalmind
npm install
./scripts/install.sh --all
```

`install.sh` checks prerequisites, builds, registers the `metalmind` command,
creates the config directory with the right permissions, and optionally sets up
local inference. It asks before installing anything outside the repo.

| Flag | Effect |
|---|---|
| *(none)* | check prerequisites, build, link the command |
| `--with-model` | also pull a local Ollama model for tier 2 |
| `--with-mlx` | also create the MLX venv for tier 1 (Apple Silicon) |
| `--all` | everything |
| `--check` | report what is missing and change nothing |

### Manual build and install

```bash
npm install             # all workspace packages
npm run build           # tsc -b (typecheck) + tsup → apps/tui/dist/index.js
npm link -w metalmind   # register the `metalmind` command globally
metalmind               # run from any directory
```

`npm link` symlinks into your active Node prefix and keeps pointing at this
checkout, so a later `npm run build` updates the installed command with no
reinstall. To remove it: `npm unlink -g metalmind`.

Two ways to run without installing:

```bash
npm run dev --workspace apps/tui   # TypeScript directly, no build step
node apps/tui/dist/index.js        # the built bundle
```

One caveat: **only the `metalmind` command auto-starts the MLX sidecar.**
`npm run dev` and running `dist/index.js` directly do not.

### From npm

```bash
npm install -g metalmind
```

On Apple Silicon, `postinstall` creates the MLX venv described below. If that
step fails it removes the half-built venv rather than leaving one MetalMind
would keep preferring.

### Prerequisites

| | Needed for | Install |
|---|---|---|
| **Node 20+** | everything | [nodejs.org](https://nodejs.org) or nvm |
| **Xcode CLT** (macOS) | native addons (`better-sqlite3`, `tree-sitter`) | `xcode-select --install` |
| **ripgrep** | search, findFiles, and `replaceInProject` | `brew install ripgrep` |
| **Ollama** | tier 2 (local) and tier 3 (cloud) | `brew install ollama` |
| **Python 3.10+** | MLX sidecar only (tier 1) | `brew install python@3.13` — the preinstalled 3.9 is too old for current `mlx-lm` |

ripgrep is worth singling out: `search` and `findFiles` fall back to a slower
built-in walk without it, but **`replaceInProject` has no fallback and will
fail**, so repo-wide refactors need it.

### Where everything lives

| Path | What |
|---|---|
| `~/.config/metalmind/config.json` | provider, model, API keys, tier overrides, settings (mode `0600`) |
| `~/.config/metalmind/metalmind.yaml` | models + routing applied in every directory |
| `~/.config/metalmind/instructions.md` | standing instructions applied in every project |
| `~/.config/metalmind/commands/*.md` | your own `/<name>` slash commands |
| `~/.config/metalmind/hooks.json` | global lifecycle hooks |
| `~/.local/share/metalmind/.venv` | Python venv for the MLX sidecar |
| `~/.cache/huggingface` | downloaded MLX model weights |
| `<project>/.metalmind/` | per-project session db, transcripts, RAG index |
| `<project>/metalmind.yaml` | per-project models, routing, permissions, tools |

Set `METALMIND_CONFIG_DIR` to relocate the config root (useful for containers or
separate profiles).

### Setting up the tiers

**Tier 3 — cloud** (default, needs an API key):

```bash
export OLLAMA_API_KEY=...        # add to ~/.zshrc to persist
```

The key is auto-detected on first run. Inside the app, `/model` opens a picker
listing the models your account actually serves.

**Tier 2 — local Ollama:**

```bash
brew install ollama
ollama serve                     # leave running (or use the menu-bar app)
ollama pull qwen3.5:4b-mlx       # any model you like
```

Then point tier 2 at it with `/tier 2 qwen3.5:4b-mlx`, or edit `metalmind.yaml`.
Note that a per-tier override saved in `config.json` wins over `metalmind.yaml` —
if a yaml model change seems ignored, that override is why.

**Tier 1 — MLX sidecar** (Apple Silicon GPU, fastest local):

```bash
./scripts/install.sh --with-mlx      # creates the venv and offers to fetch a model
```

or manually:

> **Use Python 3.10 or newer.** macOS still ships 3.9, and pip silently pins
> `mlx-lm` to 0.29 there — a version that cannot load recent architectures
> (`Model type qwen3_5 not supported`). Install a newer Python
> (`brew install python@3.13`) and build the venv with it.

```bash
/opt/homebrew/bin/python3.13 -m venv ~/.local/share/metalmind/.venv
~/.local/share/metalmind/.venv/bin/python3 -m pip install mlx-lm fastapi uvicorn

# Download a model (cached in ~/.cache/huggingface)
~/.local/share/metalmind/.venv/bin/python3 -m mlx_lm generate \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --prompt hi --max-tokens 4
```

Point tier 1 at that model in `metalmind.yaml`:

```yaml
models:
  local-mlx:
    provider: mlx
    model: mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
```

The sidecar listens on `127.0.0.1:8742` and starts automatically when you launch
with the `metalmind` command. To run it yourself:

```bash
./scripts/start-mlx-sidecar.sh          # uses the model from metalmind.yaml
./scripts/start-mlx-sidecar.sh <model>  # or an explicit model / path
```

Leave it running in its own terminal. It reads the tier-1 model out of
`metalmind.yaml`, refuses to start on a partially downloaded model, and exits
cleanly if a sidecar is already up.

**Using a model downloaded by LM Studio** works too — point tier 1 at the
directory:

```yaml
models:
  local-mlx:
    provider: mlx
    model: /Users/you/.lmstudio/models/mlx-community/gemma-3-12b-it-qat-4bit
```

LM Studio writes `*.part` files while downloading, so wait for those to
disappear before starting the sidecar.

Check it with `curl -s 127.0.0.1:8742/health`. If it is not running, tier 1
falls back to a local Ollama model and the status line says so.

Tier 1 supports **tool calling**: the sidecar renders the tool definitions
through the model's chat template and the provider parses the calls back out, so
tier 1 does real agentic work rather than chat only. Pick a model whose template
is tool-aware (Qwen, Llama 3.1+, Hermes and most modern instruct models are); if
a template does not accept tools the sidecar falls back to a plain prompt and
reports `tools_applied: false` rather than failing the request.

**Verify the whole setup** with `/doctor` inside the app — it reports each tier,
names any unusable one, and gives the exact command to fix it.

### Publishing a new release

```bash
# 1. Bump the version in apps/tui/package.json
# 2. Build the bundle
npm run build

# 3. Publish (only the apps/tui package — all @metalmind/* deps are bundled in)
npm publish --workspace apps/tui
```

The published package contains only `dist/`, `bin/`, and `scripts/`. All
`@metalmind/*` internal packages are bundled into `dist/index.js` at build
time. `tsc` emits to `dist-tsc/` so a typecheck can never overwrite the
published bundle.

## Providers

| Provider | Config id | Description | Default model |
|---|---|---|---|
| **Ollama Cloud** | `ollama-cloud` | Cloud-hosted Ollama models at api.ollama.com (API key required) | `gpt-oss:120b` |
| **Ollama (local)** | `ollama` | Self-hosted Ollama at localhost:11434, no key needed | `ministral-3:3b` |
| **Anthropic** | `anthropic` | Claude models | `claude-sonnet-4-6` |
| **OpenAI** | `openai` | GPT-4 and others | `gpt-4o` |
| **MLX** | `mlx` | Apple Silicon GPU (M1–M4), runs entirely on-device | `mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit` |

The **config id** is what goes in `activeProvider` — `ollama-cloud` and `ollama`
are different providers pointing at different hosts. Pairing the local id with a
cloud-only model is the most common misconfiguration; `/doctor` reports it.

Provider priority on startup: **saved config** → **env var auto-detect** (`OLLAMA_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`) → local Ollama.

## Three-tier routing

When no provider is forced explicitly, MetalMind routes each turn automatically:

- **Tier 1 / 2** — local model (MLX on Apple Silicon, or local Ollama). Handles simple and medium tasks with zero latency and no API cost.
- **Tier 3** — your configured cloud provider/model. Used for complex tasks or when the local response fails quality gating.

The active tier is shown in the header after each response.

## Configuration

Settings persist to `~/.config/metalmind/config.json`. Use the in-app UI (Ctrl+P) or edit directly:

```json
{
  "activeProvider": "ollama-cloud",
  "activeModel": "gpt-oss:120b",
  "apiKeys": {
    "ollama-cloud": "your-ollama-cloud-key",
    "anthropic": "sk-ant-..."
  },
  "uiTheme": "dracula",
  "budgetUsd": 5,
  "mcpServers": {}
}
```

Optional companions to this file:

| Path | Purpose |
|---|---|
| `~/.config/metalmind/instructions.md` | Standing instructions applied in every project |
| `~/.config/metalmind/commands/<name>.md` | Custom `/<name>` slash commands (`$ARGUMENTS` is substituted) |
| `~/.config/metalmind/hooks.json` | Lifecycle hooks: `preTool` (exit 2 blocks the call), `postTool`, `sessionStart`, `stop` |
| `<project>/.metalmind/commands/`, `<project>/.metalmind/hooks.json` | Project-scoped equivalents (override the global ones) |
| `<project>/metalmind.yaml` | Per-project `models`, `routing`, `permissions`, `tools`, `ui`, `mcp` |

### Environment variables

```bash
export METALMIND_PROVIDER=anthropic
export METALMIND_MODEL=claude-sonnet-4-6
export METALMIND_BASE_URL=http://localhost:11434   # custom endpoint

# API keys (alternative to storing in config.json)
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export OLLAMA_API_KEY=...                          # Ollama Cloud key
```

### CLI flags

```bash
metalmind --provider=anthropic     --model=claude-sonnet-4-6
metalmind --provider=openai        --model=gpt-4o
metalmind --provider=ollama-cloud  --model=gpt-oss:120b
metalmind --provider=ollama        --model=gemma3:27b

metalmind --continue        # resume the most recent session (also: -c)
metalmind --resume <id>     # resume a specific session
metalmind --version         # print the version and exit
```

CLI flags override env vars, which override saved config.

### Named models (`metalmind.yaml`)

Define named model references and routing in a `metalmind.yaml`. Two locations
are read, in this order:

| File | Applies to |
|---|---|
| `~/.config/metalmind/metalmind.yaml` | every directory — put your tiers here |
| `<project>/metalmind.yaml` (nearest, walking up from the cwd) | that project |

A section defined in the project file replaces the user-level one, except
`models`, which merges by name — so a project can override a single tier and
inherit the rest. Without a user-level file, running `metalmind` outside a
configured project leaves every tier on a built-in default, which is rarely a
model you have installed.

`routing` requires `defaultLocalModel` and `defaultReasoningModel`; a file that
omits either is rejected **whole** (run `/doctor` — it reports the reason).

```yaml
models:
  local:
    provider: ollama
    model: gemma3:27b
    baseUrl: http://localhost:11434
  cloud:
    provider: anthropic
    model: claude-sonnet-4-6
    apiKey: sk-ant-...
  gpu:
    provider: mlx
    model: mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit
    baseUrl: http://127.0.0.1:8742

routing:
  defaultLocalModel: gpu
  defaultReasoningModel: cloud
```

```bash
metalmind --model local
metalmind --model cloud
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| **Ctrl+P** | Open command palette |
| **Tab** | Switch focus between chat and input |
| **Ctrl+C** | Quit |

## Command palette (Ctrl+P)

Type to filter, arrow keys to navigate, Return to select, Esc to close.

| Command | Description |
|---|---|
| **Remote Provider** | Switch the cloud provider (Ollama, Anthropic, OpenAI, MLX) |
| **Remote Model** | Switch the model for the current provider |
| **MCP** | Add, remove, or view MCP servers |
| **Theme** | Switch the color theme |

Provider selection will prompt for an API key. For Ollama, the key is optional — press Return without one to use a local endpoint instead.

## Slash commands

Type in the input bar:

**Session**

| Command | Description |
|---|---|
| `/help` | Show every command with its syntax |
| `/clear` | Start a fresh session (history is kept in `/resume`) |
| `/resume [id]` | List/resume sessions; `search <text>`, `rename <id> <title>`, `tag <id> <tags>` |
| `/branch` | Fork this conversation into a new session |
| `/compact` | Summarize older turns to reclaim context |
| `/search <text>` | Find text in the current transcript |
| `/export [md\|json]` | Write the transcript to `.metalmind/transcripts/` (secrets redacted) |
| `/copy [last\|code\|all\|<n>]` | Copy to the clipboard |
| `/retry`, `/edit <text>` | Re-run the last prompt (as-is / modified) |
| `/quit` | Exit |

**Models & routing**

| Command | Description |
|---|---|
| `/model <name>` | Switch model |
| `/models` | Local Ollama models: `list`, `pull <name>`, `delete <name>` |
| `/tier 1\|2\|3\|auto [model]` | Force a tier (optionally with a model override) |
| `/routes` | Routing decisions and per-tier hit counts |
| `/brain [on\|off]` | Remote-brain mode (cloud coordinates, local executes) |
| `/cost`, `/budget [set <usd>\|off]` | Token usage + spend, and the session spend cap |
| `/apikey <key>` | Update the current provider's API key |
| `/keychain` | `save`, `load`, `status` — macOS keychain key storage |

**Working on code**

| Command | Description |
|---|---|
| `/plan`, `/build` | Read-only planning mode vs executing mode |
| `/commit [context]`, `/pr [context]` | AI-written Conventional Commit / GitHub PR (approval-gated) |
| `/test`, `/check`, `/lint [cmd]` | Run tests / project check / lint; results feed back to the model |
| `/undo`, `/redo` | Revert / re-apply the agent's last edit set |
| `/checkpoints`, `/rollback [turn]` | Turn-level git checkpoints |
| `/tree`, `/files` | Browse the project |
| `/workspace <path>` | Grant access to another directory |
| `/init` | Generate a starter project memory file |
| `/allow` | Persist auto-approval: `tool`, `path`, `command`, `list`, `clear` |

**Context & extensions**

| Command | Description |
|---|---|
| `/rag` | Retrieval: `add <path>`, `search <q>`, `status`, `clear` |
| `/remember <text>` | Save a durable fact to long-term memory |
| `/skill` | `list`, `activate <name>`, `deactivate <name>` |
| `/mcp` | `list`, `presets`, `add`, `remove`, `status`, `reconnect`, `resources`, `prompts`, `auth <srv>` |
| `/prompt` | Prompt library: `save`, `list`, `delete`, `<name> k=v` |
| `/image <path\|url>` | Attach an image for a vision model |
| `/<custom>` | Your own commands from `.metalmind/commands/<name>.md` |

**Diagnostics**

| Command | Description |
|---|---|
| `/doctor` | Check ollama, cloud key, `gh`, `rg`, LSP and persistence, with fixes |
| `/audit` | This session's tool-call log |
| `/diagnostics` | Recent errors / crash log (persisted across sessions) |
| `/notifications` | Recent notifications |
| `/vim [on\|off\|help]` | Vim modal editing in the input bar |

## Themes

Themes are saved to `~/.config/metalmind/theme.json` and applied immediately on switch.

Available themes: **dracula**, **dark**, **light**, **nord**, **solarized-dark**, **gruvbox**, **one-dark**, **tokyo-night**, **catppuccin**.

Change via Ctrl+P → Theme.

## MCP servers

MetalMind supports [Model Context Protocol](https://modelcontextprotocol.io) servers. Configure them via Ctrl+P → MCP or edit `~/.config/metalmind/config.json` directly:

```json
{
  "mcpServers": {
    "filesystem": {
      "name": "Filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"],
      "authType": "none",
      "enabled": true
    }
  }
}
```

Authentication types: `none` (local servers), `bearer` (token-based), `oauth2` (browser-based flow).

## Apple Silicon (MLX)

On M1–M4 Macs, MetalMind will use the MLX sidecar for on-device inference if it is running:

```bash
# Start the MLX sidecar (default port 8742)
mlx-server --model mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit
```

If the sidecar is not reachable at startup, the local tier falls back to Ollama automatically.

## Troubleshooting

**Raw mode error** — The TUI requires an interactive terminal. Use Terminal.app, iTerm2, or a standard VS Code terminal. For SSH: `ssh -t user@host`.

**Model not found** — Check your API key is set in `~/.config/metalmind/config.json` or as an env var. For local Ollama, ensure `ollama serve` is running.

**Command not found after install** — Check that your Node global bin directory is in `$PATH` (`npm bin -g`). For source installs, re-run `npm link -w metalmind` from the repo root.
