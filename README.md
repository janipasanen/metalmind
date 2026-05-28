# MetalMind

An agentic AI assistant for the terminal with intelligent three-tier routing: simple tasks run on-device (Apple Silicon MLX or local Ollama), complex tasks escalate to your configured cloud model automatically.

## Install

```bash
git clone https://github.com/janipasanen/metalmind
cd metalmind
npm install
npm run build
npm link -w @metalmind/tui
```

```bash
metalmind            # run from any directory
```

## Providers

| Provider | Description | Default model |
|---|---|---|
| **Ollama Cloud** | Cloud-hosted Ollama models (API key required) | `gemini-3-flash-preview:cloud` |
| **Ollama (local)** | Self-hosted Ollama, no key needed | `gemini-3-flash-preview:cloud` |
| **Anthropic** | Claude models | `claude-sonnet-4-6` |
| **OpenAI** | GPT-4 and others | `gpt-4o` |
| **MLX** | Apple Silicon GPU (M1–M4), runs entirely on-device | `mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit` |

Provider priority on startup: **saved config** → **env var auto-detect** (Ollama key → Anthropic key → OpenAI key) → Ollama default.

## Three-tier routing

When no provider is forced explicitly, MetalMind routes each turn automatically:

- **Tier 1 / 2** — local model (MLX on Apple Silicon, or local Ollama). Handles simple and medium tasks with zero latency and no API cost.
- **Tier 3** — your configured cloud provider/model. Used for complex tasks or when the local response fails quality gating.

The active tier is shown in the header after each response.

## Configuration

Settings persist to `~/.config/metalmind/config.json`. Use the in-app UI (Ctrl+P) or edit directly:

```json
{
  "activeProvider": "ollama",
  "activeModel": "gemini-3-flash-preview:cloud",
  "apiKeys": {
    "ollama": "your-ollama-cloud-key",
    "anthropic": "sk-ant-..."
  },
  "uiTheme": "dracula",
  "mcpServers": {}
}
```

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
metalmind --provider=anthropic --model=claude-sonnet-4-6
metalmind --provider=openai    --model=gpt-4o
metalmind --provider=ollama    --model=gemma3:27b
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

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/model <name>` | Switch model (e.g. `/model gemma3:27b`) |
| `/clear` | Clear conversation history |
| `/quit` | Exit |

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

**Command not found after install** — Re-run `npm link -w @metalmind/tui` from the repo root, or check that your Node bin directory is in `$PATH`.
