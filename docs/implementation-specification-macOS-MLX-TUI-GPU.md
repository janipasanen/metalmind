# Implementation Specification: Agentic AI TUI for Apple Silicon Development

## 1. Project Goal

Build a terminal-based Agentic AI development environment for macOS on Apple Silicon, starting with M1 MacBooks, that is as easy to use and visually clear as Claude Code, Codex CLI, and OpenCode while remaining open, provider-agnostic, local-first where possible, and optimized for Apple Silicon GPU acceleration.

The system should support:

- A polished terminal user interface.
- Local small coding models using Apple Silicon acceleration.
- Optional local Ollama models.
- Cloud reasoning models for complex development tasks.
- Tool-based file operations such as search, read, edit, create, move, and delete.
- Git-aware code editing and diff review.
- Model abstraction so different providers can be swapped.
- Output normalization to handle different model quirks.
- Future support for MCP, MLX, Apple Intelligence integrations, and custom agent skills.

The long-term vision is not a chatbot in a terminal. It is a deterministic, inspectable, developer-controlled agent runtime that uses multiple models and tools safely.

---

## 2. Product Principles

### 2.1 Developer Control First

The AI must not silently make destructive changes.

Required behavior:

- Show proposed file changes as diffs.
- Ask for confirmation before destructive operations.
- Require permission for shell commands.
- Never delete files outside the project root unless explicitly allowed.
- Maintain an audit log of model decisions, tool calls, edits, and command output.

### 2.2 Provider-Agnostic Model Runtime

The system must not be tightly coupled to one model vendor.

Supported model categories:

- Local Apple Silicon models through MLX / MLX-LM.
- Local Ollama models.
- Ollama Cloud models such as `deepseek-v4-pro:cloud`.
- OpenAI / GPT-5 / Codex.
- Anthropic Claude.
- Google Gemini.
- Other OpenAI-compatible APIs.

### 2.3 Local-First, Cloud-When-Needed

Small local models should handle fast and private tasks.

Cloud models should handle:

- Architecture decisions.
- Complex reasoning.
- Large refactors.
- Multi-file debugging.
- Long-context analysis.
- Difficult code generation.

### 2.4 Tool Calls, Not Free-Form File Editing

Models should not directly manipulate the filesystem.

The model must request structured tool calls, and the runtime must validate and execute those calls.

Example:

```json
{
  "tool": "editFile",
  "arguments": {
    "path": "src/api/client.ts",
    "search": "const timeoutMilliseconds = 5000;",
    "replace": "const timeoutMilliseconds = 10000;"
  }
}
```

The runtime owns execution. The model only proposes.

---

## 3. Recommended Technology Stack

### 3.1 Primary Language

Use TypeScript + Node.js for the main application.

Reasons:

- Strong ecosystem for AI provider SDKs.
- Excellent async runtime.
- Excellent terminal UI libraries.
- Strong schema validation with Zod.
- Natural fit for MCP.
- Easy package distribution with npm.
- Easier plugin system than Swift.
- Better agent ecosystem than Swift.

### 3.2 Terminal UI

Use Ink.

Ink allows React-style terminal UIs and is a good fit for:

- Streaming responses.
- Panels.
- Diff views.
- Tool-call status.
- File tree views.
- Interactive approvals.
- Command palettes.

Alternative libraries to inspect:

- `blessed`
- `react-blessed`
- `bubbletea` if using Go

Recommendation: start with Ink + TypeScript.

### 3.3 Local Apple Silicon Inference

Use MLX / MLX-LM as the preferred future local inference layer.

MLX is optimized for Apple Silicon and unified memory. MLX-LM is specifically intended for running and fine-tuning LLMs on Apple Silicon.

Initial local model target:

- `deepseek-coder:1.3b` through Ollama for fast prototyping.

Future local model targets:

- DeepSeek-Coder variants.
- Qwen Coder small models.
- Phi small coding models.
- Gemma small models.
- MLX-converted models from Hugging Face.

### 3.4 Local Model Runtime Strategy

Phase 1:

- Use Ollama for local model execution.
- Use Ollama's HTTP API.
- Support models such as `deepseek-coder:1.3b`.

Phase 2:

- Add MLX-LM through a Python sidecar service.
- Expose local MLX inference through an internal HTTP or stdio protocol.
- Keep the TypeScript runtime as the orchestrator.

Phase 3:

- Add direct MLX process management.
- Add Apple Silicon-specific model benchmarking.
- Add automatic local/cloud routing based on speed, context, cost, and task type.

### 3.5 Cloud Model Providers

Support these providers behind one provider abstraction:

- OpenAI / GPT-5 / Codex.
- Anthropic Claude.
- Google Gemini.
- Ollama Cloud.
- Any OpenAI-compatible endpoint.

Ollama Cloud should be treated as a cloud provider, not just a local provider.

Example model:

- `deepseek-v4-pro:cloud`

---

## 4. Existing Open Source Projects to Study

### 4.1 OpenCode

Study for:

- Terminal-first AI coding UX.
- Provider-agnostic design.
- TUI interaction patterns.
- Model abstraction.
- Tool-call display.
- LSP support ideas.

Why it matters:

OpenCode is one of the closest open-source references for a Claude Code-like terminal coding agent. It is explicitly focused on being provider-agnostic and terminal-first.

### 4.2 Aider

Study for:

- Git-native editing.
- Codebase mapping.
- Patch application.
- Model-independent code editing.
- Auto-commit workflow.
- Context selection.

Why it matters:

Aider has strong ideas around repo maps, git diffs, and reliable model-assisted code editing. Its repo-map concept is especially important for large codebases.

### 4.3 Model Context Protocol TypeScript SDK

Study for:

- Tool server/client architecture.
- Standardized external tool integrations.
- Future plugin system.
- External data/source integration.
- Reusable tool definitions.

Why it matters:

MCP is becoming a common standard for model-tool integration. The TUI should eventually support MCP clients and possibly expose its own MCP server.

### 4.4 MLX / MLX-LM

Study for:

- Apple Silicon optimized inference.
- Local model execution.
- Quantized local models.
- Hugging Face model loading.
- Future local fine-tuning.

Why it matters:

The core differentiator of this project is Apple Silicon usage. MLX is the best long-term foundation for efficient local inference on M1/M2/M3/M4 hardware.

### 4.5 Continue.dev

Study for:

- Local/cloud model configuration.
- Provider abstraction.
- Developer workflow integration.
- Context providers.
- IDE-adjacent architecture.

Why it matters:

Continue is a strong example of local/cloud model routing and developer-facing model configuration.

### 4.6 Open Interpreter

Study for:

- Tool execution.
- Local command execution.
- Human-in-the-loop operation.
- Safety boundaries.

Why it matters:

The project needs controlled command execution and visible tool use.

---

## 5. High-Level Architecture

```text
┌─────────────────────────────────────────────┐
│                  TUI App                     │
│              Ink + TypeScript                │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│              Agent Runtime Core              │
│  planning, routing, state, permissions        │
└──────────────────────┬──────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
┌───────▼───────┐ ┌────▼─────┐ ┌──────▼──────┐
│ Model Router  │ │ Tool Bus │ │ Context Mgr │
└───────┬───────┘ └────┬─────┘ └──────┬──────┘
        │              │              │
┌───────▼────────┐ ┌───▼────────┐ ┌───▼─────────┐
│ Model Providers│ │ Tool System│ │ Memory/Index│
└────────────────┘ └────────────┘ └─────────────┘
        │              │              │
┌───────▼──────────────────────────────────────┐
│ Ollama / MLX / OpenAI / Claude / Gemini / etc │
└──────────────────────────────────────────────┘
```

---

## 6. Repository Structure

Recommended monorepo structure:

```text
agentic-ai-tui/
  apps/
    tui/
      src/
        components/
        screens/
        keybindings/
        themes/
        index.tsx

  packages/
    core/
      src/
        agent/
        runtime/
        state/
        permissions/
        events/

    providers/
      src/
        provider.ts
        openai/
        anthropic/
        gemini/
        ollama/
        mlx/

    tools/
      src/
        filesystem/
        git/
        shell/
        search/
        diagnostics/

    context/
      src/
        repo-map/
        file-selection/
        token-budget/
        summarization/

    memory/
      src/
        sqlite/
        vector-store/
        session-store/

    mcp/
      src/
        client/
        server/
        adapters/

    schemas/
      src/
        messages.ts
        tool-calls.ts
        config.ts

    config/
      src/
        load-config.ts
        defaults.ts

  examples/
    basic-project/
    swift-project/
    node-project/

  docs/
    architecture.md
    provider-adapters.md
    tool-system.md
    mlx-integration.md
    safety-model.md

  scripts/
    setup-dev.sh
    benchmark-local-models.sh
```

---

## 7. Core Internal Interfaces

### 7.1 Provider Interface

```typescript
export interface ModelProvider {
  readonly providerName: string;
  readonly supportedCapabilities: ModelCapabilities;

  streamChatCompletion(request: ChatCompletionRequest): AsyncIterable<ModelStreamEvent>;

  completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  countTokens?(request: TokenCountRequest): Promise<TokenCountResponse>;
}
```

### 7.2 Model Capabilities

```typescript
export interface ModelCapabilities {
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsJsonMode: boolean;
  readonly maximumContextTokens: number;
}
```

### 7.3 Tool Interface

```typescript
export interface AgentTool<TInput, TOutput> {
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly requiresConfirmation: boolean;
  execute(input: TInput, executionContext: ToolExecutionContext): Promise<TOutput>;
}
```

### 7.4 Internal Message Format

All provider-specific formats must be converted to one internal format.

```typescript
export interface AgentMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: AgentToolCall[];
  readonly metadata?: Record<string, unknown>;
}
```

### 7.5 Tool Call Format

```typescript
export interface AgentToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}
```

---

## 8. Required Tool System

### 8.1 Filesystem Tools

Required tools:

```text
listDirectory
findFiles
readFile
writeFile
editFile
createFile
deleteFile
moveFile
createDirectory
searchInFiles
```

Safety requirements:

- Restrict paths to project root by default.
- Normalize and validate paths.
- Prevent path traversal.
- Confirm destructive actions.
- Show diffs before write/edit/delete.
- Keep a tool audit log.

### 8.2 Git Tools

Required tools:

```text
gitStatus
gitDiff
gitDiffFile
gitAdd
gitCommit
gitRestore
gitCreateBranch
gitCurrentBranch
```

Safety requirements:

- Never commit without explicit user confirmation.
- Always show diff before commit.
- Refuse force-push or destructive git commands by default.

### 8.3 Shell Tools

Required tools:

```text
runCommand
runTests
runBuild
runLint
```

Safety requirements:

- Commands require confirmation unless allowlisted.
- Commands run inside project root by default.
- Dangerous commands are blocked or require elevated confirmation.
- Capture stdout, stderr, exit code, and duration.
- Support timeout.
- Support cancellation.

### 8.4 Search and Code Intelligence Tools

Required tools:

```text
ripgrepSearch
findSymbol
findReferences
getDiagnostics
listProjectFiles
buildRepoMap
```

Initial implementation can use:

- `rg`
- `fd`
- `git ls-files`
- Tree-sitter later
- LSP later

---

## 9. Output Normalization Layer

Different models produce different quirks:

- Invalid JSON.
- Markdown-wrapped JSON.
- XML-like tool calls.
- Malformed function call arguments.
- Extra prose before tool calls.
- Missing quotes.
- Escaped newlines.
- Truncated patches.
- Provider-specific streaming formats.

The runtime must normalize all output into internal events.

Required components:

```text
ProviderAdapter
MessageNormalizer
ToolCallExtractor
JsonRepair
SchemaValidator
RetryPolicy
PatchParser
MarkdownSanitizer
```

Use Zod for validation.

Every tool call must be validated before execution.

Invalid output handling:

1. Try strict parse.
2. Try safe extraction.
3. Try JSON repair.
4. Validate with schema.
5. Ask same model to correct output.
6. Escalate to stronger model if repeated failure.
7. Ask user only when execution would be unsafe.

---

## 10. Model Routing Strategy

### 10.1 Model Tiers

#### Tier 1: Fast Local Model

Example:

- `deepseek-coder:1.3b`

Runtime:

- Ollama initially.
- MLX-LM later.

Responsibilities:

- Intent classification.
- File summarization.
- Simple code explanation.
- Small edits.
- Filename search reasoning.
- Commit message drafts.
- Local/private context handling.
- Routing decisions.

#### Tier 2: Medium Model

Examples:

- Larger local Ollama model if available.
- Ollama Cloud fast model.
- Smaller cloud coding model.

Responsibilities:

- Moderate refactors.
- Test fixes.
- File-level edits.
- Debugging with command output.

#### Tier 3: Large Reasoning Model

Examples:

- Claude.
- GPT-5.
- Codex.
- Gemini.
- `deepseek-v4-pro:cloud`.
- Other strong Ollama Cloud model.

Responsibilities:

- Architecture.
- Large multi-file changes.
- Long-context reasoning.
- Complex debugging.
- Planning.
- Review.
- High-risk operations.

### 10.2 Routing Rules

Initial routing can be rule-based:

```text
If request is search/read/explain:
  use local model or no model

If request is simple single-file edit:
  use local model first, verify with tests

If request requires architecture/design:
  use large cloud model

If request includes "refactor", "migrate", "debug failing tests":
  use large cloud model

If local model output fails validation twice:
  escalate to cloud model

If file context exceeds local model context:
  summarize locally, reason remotely
```

Later routing can use a small local classifier model.

---

## 11. Apple Silicon / M1 GPU Strategy

### 11.1 What the M1 GPU Should Do

The M1 GPU should accelerate:

- Local LLM inference through MLX.
- Small coding model responses.
- Embedding generation if using MLX-compatible embedding models.
- Repo summarization.
- Local classification/routing.
- Local privacy-sensitive analysis.

### 11.2 What the Neural Engine Should Do

Do not depend on Apple Neural Engine initially.

Reasons:

- Public developer access for custom LLM workloads is limited compared to GPU/Metal/MLX.
- MLX targets Apple Silicon efficiently and is more practical for this project.

### 11.3 Apple Intelligence Role

Apple Intelligence should not be the foundation of the agent runtime.

Use Apple Intelligence as an optional future integration layer for:

- macOS writing tools integration.
- Shortcuts integration.
- App Intents.
- Siri-triggered commands.
- Local semantic context if Apple exposes suitable APIs.

The core AI runtime should be independent from Apple Intelligence.

### 11.4 MLX Sidecar

Recommended architecture:

```text
TypeScript Agent Runtime
        │
        ▼
MLX Local Inference Sidecar
Python + FastAPI or stdio
        │
        ▼
mlx-lm
        │
        ▼
Apple Silicon GPU / unified memory
```

The sidecar should expose:

```text
POST /chat
POST /complete
POST /embed
GET /models
GET /health
```

---

## 12. TUI UX Requirements

The TUI should feel premium and developer-focused.

### 12.1 Required Views

```text
Main Chat View
Tool Call Timeline
Diff Review View
File Tree View
Model Status View
Task Plan View
Command Output View
Approval Prompt View
Settings View
```

### 12.2 Required UX Behaviors

- Streaming model output.
- Live tool-call status.
- Keyboard-first navigation.
- Clear visual distinction between:
  - user input
  - assistant text
  - tool calls
  - command output
  - errors
  - diffs
- Collapsible verbose sections.
- Minimal noise by default.
- Expandable details on demand.
- Copyable command output.
- Searchable session history.

### 12.3 Suggested Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Project: my-app        Model: local-router → claude/gpt/etc  │
├───────────────────────┬──────────────────────────────────────┤
│ Files / Context       │ Conversation                         │
│                       │                                      │
│ src/                  │ User: refactor auth service           │
│ tests/                │ AI: I will inspect the files...       │
│ package.json          │                                      │
├───────────────────────┼──────────────────────────────────────┤
│ Tool Calls            │ Diff / Command Output                 │
│ readFile ✓            │ - old line                            │
│ editFile pending      │ + new line                            │
└───────────────────────┴──────────────────────────────────────┘
```

---

## 13. Configuration File

Use a project-level config file:

```yaml
models:
  localFast:
    provider: ollama
    model: deepseek-coder:1.3b

  localMlx:
    provider: mlx
    model: mlx-community/deepseek-coder-1.3b-mlx

  cloudReasoning:
    provider: anthropic
    model: claude-sonnet-latest

  cloudAlternative:
    provider: ollama
    model: deepseek-v4-pro:cloud

routing:
  defaultLocalModel: localFast
  defaultReasoningModel: cloudReasoning
  fallbackReasoningModel: cloudAlternative

permissions:
  allowReadFiles: true
  allowWriteFiles: ask
  allowDeleteFiles: ask
  allowShellCommands: ask
  allowGitCommit: ask

tools:
  filesystem: true
  git: true
  shell: true
  mcp: true

ui:
  theme: default
  showToolTimeline: true
  showDiffBeforeApply: true
```

---

## 14. Phased Implementation Plan

## Phase 1: MVP TUI + Provider Abstraction

Goal:

Build a working terminal AI chat with local Ollama and one cloud provider.

Deliverables:

- TypeScript monorepo.
- Ink TUI.
- Streaming chat.
- Provider interface.
- Ollama provider.
- OpenAI-compatible provider.
- Anthropic provider or OpenAI provider.
- Basic config file.
- Basic session history.

Success criteria:

- User can run the TUI in a repo.
- User can chat with local Ollama model.
- User can switch to cloud model.
- Streaming output works.
- Internal message format is provider-independent.

---

## Phase 2: Filesystem Tool System

Goal:

Let the agent safely inspect and modify project files.

Deliverables:

- Tool registry.
- Zod schemas for tools.
- `readFile`
- `listDirectory`
- `findFiles`
- `searchInFiles`
- `createFile`
- `editFile`
- `deleteFile`
- Diff preview.
- Confirmation prompts.
- Audit log.

Success criteria:

- The model can request file reads.
- The model can propose edits.
- The user can approve/reject edits.
- The runtime applies edits deterministically.
- Invalid tool calls are rejected.

---

## Phase 3: Git-Native Development Workflow

Goal:

Make the system useful for real coding tasks.

Deliverables:

- Git status view.
- Git diff view.
- Git-aware context selection.
- Commit message generation.
- Optional commit creation after approval.
- Repo map v1 using `git ls-files`, `rg`, and simple heuristics.
- Test/build/lint command tools.

Success criteria:

- User can ask for a small feature or bugfix.
- The system finds relevant files.
- The system edits files.
- The system runs tests.
- The system shows diffs.
- User can accept changes.

---

## Phase 4: Model Routing + Local/Cloud Collaboration

Goal:

Use small local model for fast/private tasks and cloud model for hard reasoning.

Deliverables:

- Router component.
- Task classification.
- Local-first routing rules.
- Escalation to cloud.
- Model fallback.
- Cost/latency tracking.
- Per-task model selection display in TUI.

Success criteria:

- Simple tasks use local model.
- Complex tasks use large cloud model.
- Failed local outputs escalate.
- User can see which model was used and why.

---

## Phase 5: MLX Apple Silicon Integration

Goal:

Use the M1 GPU through MLX for local inference.

Deliverables:

- Python MLX sidecar.
- MLX provider adapter.
- Model loading.
- Streaming support if practical.
- Local benchmark command.
- Configurable MLX models.
- Documentation for installing MLX models.

Success criteria:

- The TUI can run a local MLX model.
- Inference uses Apple Silicon acceleration.
- User can choose Ollama local or MLX local.
- Benchmarks show tokens/sec, memory use, and latency.

---

## Phase 6: MCP Support

Goal:

Support external tools and future ecosystem integrations.

Deliverables:

- MCP client.
- Register MCP tools into internal tool registry.
- MCP server configuration.
- Tool permission mapping.
- Tool-call display in TUI.

Success criteria:

- User can add an MCP server.
- MCP tools appear in the tool registry.
- Tool calls still use permission system.
- MCP results are normalized into internal tool responses.

---

## Phase 7: Advanced Code Intelligence

Goal:

Improve repo understanding and context selection.

Deliverables:

- Tree-sitter based code structure extraction.
- Symbol index.
- Reference lookup.
- LSP integration.
- Diagnostics tool.
- Repo map v2.
- Context budget optimizer.

Success criteria:

- The system can identify relevant files more accurately.
- The system can explain architecture.
- The system can perform multi-file changes with less manual context selection.

---

## Phase 8: Apple Platform Integrations

Goal:

Use macOS capabilities without making the core runtime dependent on them.

Deliverables:

- Optional Swift helper.
- Shortcuts integration.
- App Intents.
- Spotlight search integration.
- Keychain API key storage.
- Native notifications.
- Optional Apple Intelligence experiments where APIs allow.

Success criteria:

- API keys can be stored securely in Keychain.
- User can trigger common workflows through macOS.
- Core TUI remains portable and independent.

---

## Phase 9: Agent Skills / Reusable Workflows

Goal:

Allow specialized repeatable workflows.

Deliverables:

- Skills directory format.
- Skill loader.
- Skill-specific prompts.
- Skill-specific tools.
- Project-local skills.
- Global user skills.

Example skills:

```text
swift-vapor-grpc-review
gitlab-ci-debugger
mongodb-fluent-migration
android-kotlin-grpc-client
tvos-dashboard-ui
```

Success criteria:

- User can define reusable coding workflows.
- Skills can guide the agent toward project conventions.
- Skills can be shared between projects.

---

## 15. Security and Safety Model

### 15.1 Filesystem Boundaries

Default:

- Read/write only inside current project root.
- Block parent directory traversal.
- Block home directory access unless explicitly allowed.
- Block `.ssh`, `.gnupg`, `.aws`, `.kube`, and similar secret directories.

### 15.2 Command Safety

Block or require elevated confirmation for:

```text
rm -rf
sudo
curl | sh
wget | sh
chmod -R
chown -R
git reset --hard
git clean -fd
docker system prune
killall
launchctl
security dump-keychain
```

### 15.3 Secret Handling

The system must:

- Redact secrets in logs.
- Avoid sending secret files to cloud models.
- Detect `.env`, private keys, tokens, certificates.
- Ask before including potentially sensitive files in cloud context.

### 15.4 Cloud Model Privacy Boundary

Before sending context to cloud models:

- Show which files/snippets will be sent when in strict mode.
- Never send secret files by default.
- Allow project-specific ignore rules.

---

## 16. Testing Strategy

### 16.1 Unit Tests

Test:

- Provider adapters.
- Message normalization.
- Tool schemas.
- Filesystem path validation.
- JSON repair.
- Diff generation.
- Routing rules.

### 16.2 Integration Tests

Test:

- Ollama provider against local mock or real Ollama.
- OpenAI-compatible provider against mock server.
- Tool execution in temporary repo.
- Git workflows in temporary repo.
- TUI state transitions.

### 16.3 Golden Tests

Maintain fixtures for model output quirks:

```text
claude-tool-call.md
openai-tool-call.json
gemini-markdown-json.md
ollama-raw-output.txt
deepseek-invalid-json.txt
```

Each fixture must normalize into the same internal format.

### 16.4 Safety Tests

Test blocked operations:

- Delete outside root.
- Read secret file.
- Dangerous shell command.
- Invalid path traversal.
- Git destructive command.

---

## 17. Design Decisions

### 17.1 Why TypeScript Instead of Swift?

Use TypeScript for the main runtime because the agent ecosystem, model SDK ecosystem, MCP ecosystem, schema validation, and terminal tooling are stronger.

Use Swift only for optional macOS-native integrations later.

### 17.2 Why Ink?

Ink provides a React-based mental model for terminal UIs. This makes it easier to build a polished, componentized interface with streaming state and interactive views.

### 17.3 Why MLX?

MLX is designed for Apple Silicon and uses the strengths of unified memory and Apple GPU acceleration. It is the best long-term path for local inference on M1/M2/M3/M4 Macs.

### 17.4 Why Not Apple Intelligence First?

Apple Intelligence is not currently a complete developer agent runtime. It should be treated as an optional integration layer, not the foundation. The foundation should be an independent runtime using MLX, Ollama, and cloud providers.

### 17.5 Why Use Ollama First?

Ollama is the fastest way to prototype local and cloud model execution. It provides a simple local HTTP API and supports both local models and cloud models.

### 17.6 Why Build a Custom Tool System?

Because reliable coding agents require deterministic tool execution, validation, permissions, diffs, and audit logs. Model-generated text alone is not safe enough for file operations.

---

## 18. First Implementation Milestone

The first working milestone should be:

```text
agentic-ai-tui open .
```

Then the user sees:

- TUI opens in current repo.
- User can select local Ollama model.
- User can select cloud model.
- User can chat.
- User can ask: "Find where authentication is implemented."
- Agent uses file search/read tools.
- Agent shows tool calls.
- Agent answers with file references.
- No file edits yet.

Second milestone:

```text
"Change the auth timeout from 5 seconds to 10 seconds."
```

The agent should:

1. Search files.
2. Read candidate files.
3. Propose edit.
4. Show diff.
5. Ask approval.
6. Apply edit.
7. Show git diff.
8. Optionally run tests.

---

## 19. Definition of Done for Version 1

Version 1 is complete when:

- TUI is stable and pleasant to use.
- Ollama local works.
- At least one large cloud provider works.
- Filesystem tools work safely.
- Git diff workflow works.
- Edits are shown before application.
- Tool calls are validated.
- Model adapters normalize provider quirks.
- Local/cloud routing works with basic rules.
- Configuration is documented.
- Project can be used on a real codebase.

---

## 20. Future Differentiators

This project becomes special if it does these well:

- First-class Apple Silicon local inference.
- MLX-native local model support.
- Model collaboration between small local and large cloud models.
- Beautiful TUI similar to Claude Code / Codex / OpenCode.
- Strict deterministic tool runtime.
- Strong privacy boundaries.
- MCP compatibility.
- Skills/workflow system for repeated engineering tasks.
- Great Swift/Vapor/gRPC/Kotlin/DevOps workflows.

---

## 21. Recommended Initial Build Order

Build in this order:

1. TypeScript monorepo.
2. Ink TUI skeleton.
3. Provider abstraction.
4. Ollama provider.
5. One cloud provider.
6. Streaming response rendering.
7. Tool registry.
8. Read-only filesystem tools.
9. File edit tool with diff preview.
10. Git diff/status.
11. Routing local vs cloud.
12. MLX sidecar.
13. MCP support.
14. Code intelligence.
15. Apple integrations.

---

## 22. Summary

The best future architecture is:

```text
TypeScript + Ink TUI
        ↓
Deterministic Agent Runtime
        ↓
Provider Adapter Layer
        ↓
Ollama Local / Ollama Cloud / MLX / Claude / GPT-5 / Codex / Gemini
        ↓
Validated Tool System
        ↓
Filesystem / Git / Shell / Search / MCP
```

The M1 GPU matters most through MLX and local model execution. Apple Intelligence should be explored later, but the system should not depend on it. The foundation should be local-first, provider-agnostic, tool-driven, safe, inspectable, and optimized for real software engineering work.
