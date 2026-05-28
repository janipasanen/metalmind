# MetalMind TUI

MetalMind is an AI-powered terminal-based development assistant with intelligent routing across local and cloud models.

## Build & Install

### 1. Build the project

```bash
cd /Users/janipasanen/Documents/Developer/JMPasanenIT/AI/metalmind
npm install
npm run build
```

### 2. Install globally

Make the `metalmind` command available from any terminal:

```bash
npm run build
npm link --workspace=@metalmind/tui
```

Or use `npm link` for local development:

```bash
npm link --workspace=@metalmind/tui
```

### 3. Run from anywhere

```bash
metalmind
```

## Configuration

### Choose a Provider

MetalMind supports multiple AI providers. The default provider is selected automatically based on available API keys:

- **OpenAI** - if `OPENAI_API_KEY` is set
- **Anthropic** - if `ANTHROPIC_API_KEY` is set
- **Ollama** (local) - otherwise

To force a specific provider, use one of these methods:

**Environment variables:**
```bash
export METALMIND_PROVIDER=openai    # or: anthropic, ollama, mlx
```

**Command line:**
```bash
metalmind --provider=openai
metalmind --provider=anthropic
```

### Select a Model

Each provider has default models:

- **OpenAI**: `gpt-4o`
- **Anthropic**: `claude-sonnet-4-6`
- **Ollama**: `deepseek-coder:1.3b`
- **MLX** (macOS only): `mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit`

To use a specific model:

**Environment variables:**
```bash
export METALMIND_MODEL=gpt-4o
export METALMIND_MODEL=claude-sonnet-4-6
export METALMIND_MODEL=deepseek-coder:1.3b
```

**Command line:**
```bash
metalmind --model=gpt-4o
metalmind --model=claude-sonnet-4-6
```

### Configure Custom Base URL (Ollama, MLX, etc.)

Set a custom base URL for self-hosted services:

**Environment variables:**
```bash
export METALMIND_BASE_URL=http://localhost:11434  # Ollama default
export METALMIND_BASE_URL=http://127.0.0.1:8742   # MLX default
```

### Named Models in Configuration File

Create a `metalmind.yaml` file in your project directory or home directory:

```yaml
models:
  local:
    provider: ollama
    model: deepseek-coder:6.7b
    baseUrl: http://localhost:11434
  cloud:
    provider: openai
    model: gpt-4o
    apiKey: sk-...
  mlx:
    provider: mlx
    model: mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit
    baseUrl: http://127.0.0.1:8742

routing:
  defaultLocalModel: local
  defaultReasoningModel: cloud
```

Then reference by name:
```bash
metalmind --model local
metalmind --model cloud
```

## Using the TUI

### Keyboard Shortcuts

- **Tab** - Switch focus between chat panel and input bar
- **Ctrl+C** - Quit the application

### Commands (type in the input bar)

- `/help` - Show this help message
- `/quit` - Exit the application
- `/clear` - Clear chat history
- `/model <name>` - Switch to a different model (e.g., `/model gpt-4o`)

### API Keys

Set your API keys as environment variables in your shell profile (e.g., `~/.zshrc`, `~/.bashrc`):

```bash
# OpenAI
export OPENAI_API_KEY=sk-...

# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Ollama Cloud
export OLLAMA_API_KEY=...
```

## Troubleshooting

### Ink Raw Mode Error

If you see: "Raw mode is not supported on the current process.stdin"

This can happen in some terminal environments (like certain SSH sessions or IDE terminals). The TUI requires an interactive terminal with raw mode support. Try:

1. Use a standard terminal (Terminal.app, iTerm2, VS Code integrated terminal)
2. Don't run inside non-interactive shells
3. For SSH: use `ssh -t` flag

### Model Not Loading

Check that:
1. Your API key is set correctly
2. For Ollama: `ollama serve` is running locally
3. For MLX: The MLX sidecar is running at `http://127.0.0.1:8742`

## Build from Source

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Test
npm test

# Type check
npm run typecheck
### Command Palette (Ctrl+P)

MetalMind includes a command palette for quick navigation and provider/model selection:

- **Ctrl+P** - Open command palette
- Type to search through available commands and providers
- Use Arrow keys to navigate
- **Return** to select a command or provider
- **Esc** to cancel

The command palette allows you to:
- Switch between providers (Ollama, OpenAI, Anthropic, MLX)
- Select different models for each provider
- Access provider configuration

## Provider and Model Selection

When the app starts, it automatically selects a provider based on available API keys:
1. Anthropic (if `ANTHROPIC_API_KEY` is set)
2. OpenAI (if `OPENAI_API_KEY` is set)
3. Ollama (default, uses `deepseek-coder:1.3b`)

You can change the provider/model at any time using:
- **Ctrl+P** - Open command palette and select
- Environment variable: `export METALMIND_PROVIDER=anthropic`
- Command line: `metalmind --provider=anthropic --model=claude-sonnet-4-6`

## MCP Configuration

MetalMind supports Model Context Protocol (MCP) servers with multiple authentication types.

### Adding MCP Servers

Use **Ctrl+P** → **MCP** to open the MCP configuration panel. From there you can:

- **Add a new server** - Press 'A' to add a server with your preferred authentication
- **Navigate** - Use Up/Down arrows to move between servers
- **Delete a server** - Select a server and press 'D' to confirm deletion

### Authentication Types

Configure the auth type when adding a server:

- **`oauth2`** (default) - OAuth2 session authentication, like Codex/OpenCode
  - Login via: `codex mcp login ServerName` or `opencode mcp auth ServerName`
  - Uses interactive browser-based OAuth flow

- **`bearer`** - Direct Bearer token authentication
  - No login needed, just provide your API token
  - For services requiring direct token access

- **`none`** - No authentication required
  - For local MCP servers without auth

### Manual Configuration

Edit `~/.config/metalmind/config.json`:

```json
{
  "mcpServers": {
    "git": {
      "name": "Git",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"],
      "authType": "oauth2",
      "enabled": true
    },
    "memory": {
      "name": "Memory",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "authType": "oauth2",
      "enabled": true
    },
    "custom": {
      "name": "Custom Server",
      "command": "node",
      "args": ["server.js"],
      "authType": "bearer",
      "enabled": true
    }
  }
}
```

Or use `metalmind.yaml` in your project directory:

```yaml
mcpServers:
  git:
    name: Git
    command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-git"
    authType: oauth2
    enabled: true
```

After adding servers, restart MetalMind and they'll be available as MCP tools.
