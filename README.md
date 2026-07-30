# MetalMind

An agentic AI assistant for the terminal with intelligent three-tier routing: simple tasks run on-device (Apple Silicon MLX or local Ollama), complex tasks escalate to your configured cloud model automatically.

## Install

### From npm (recommended)

```bash
npm install -g metalmind
metalmind
```

On Apple Silicon, `postinstall` automatically creates a Python `.venv` at
`~/.local/share/metalmind/.venv` and installs `mlx-lm` so the MLX sidecar
is ready for GPU inference with no extra steps. Requires Python 3 and
Xcode Command Line Tools (`xcode-select --install`).

### From source (development)

```bash
git clone https://github.com/janipasanen/metalmind
cd metalmind
npm install        # installs all workspace packages
npm run build      # type-checks + bundles apps/tui → dist/index.js
npm link -w metalmind   # registers the `metalmind` command globally
```

```bash
metalmind          # run from any directory
```

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
time. The only runtime npm dependency is `tree-sitter` (native addon, compiled
on install by node-gyp — requires Xcode CLT on macOS).

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

Place a `metalmind.yaml` in your project directory or home directory to define named model references and routing:

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
