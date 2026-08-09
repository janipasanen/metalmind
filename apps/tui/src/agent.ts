import { createProvider, OllamaWorkerProvider, isAbortError, isRetryableError, isProviderScopedError, ProviderError } from "@metalmind/providers";
import { PathValidator, ToolRegistry, allReadOnlyTools, allWriteTools, allGitTools, runShellTools, runShellAsync, allSymbolTools, allWebTools, allDocumentTools, backgroundShellTools, killAllBackgroundProcesses, createDiagnosticsTool, shutdownLspClient, AuditLog, DiffGenerator, RepoMapV2, indexFile, getReferenceIndex } from "@metalmind/tools";
import { loadConfigFromFile, loadMergedConfig, loadXdgConfig, saveXdgConfig, getConfigLoadIssue, XDG_CONFIG_DIR } from "@metalmind/config";
import { McpHttpClient, type McpToolDef } from "./mcp-http.js";
import { McpClient, normalizeMcpResult } from "@metalmind/mcp";
import { SkillLoader, SkillManager } from "@metalmind/skills";

/** Structural view of the session store — imported lazily so a missing native
 *  better-sqlite3 addon degrades to no-persistence instead of crashing launch. */
interface SessionRecordLite {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  tags?: string;
}
interface SessionStore {
  createSession(title?: string): string;
  saveMessages(id: string, messages: AgentMessage[]): void;
  loadMessages(id: string): AgentMessage[];
  listSessions(): SessionRecordLite[];
  searchSessions(query: string): SessionRecordLite[];
  renameSession(id: string, title: string): void;
  tagSession(id: string, tags: string): void;
  getSession?(id: string): SessionRecordLite | undefined;
  /** Concurrency support (#388) — present on the sqlite store. */
  claimSession?(id: string): void;
  activeOwner?(id: string, staleSeconds?: number): number | null;
  close?(): void;
}

/** Unified MCP tool client — both the HTTP and stdio transports satisfy this. */
interface McpToolClient {
  callTool(name: string, input: unknown): Promise<string>;
  /** Present on the stdio client: false once the server process has exited (#378). */
  isHealthy?(): boolean;
  // Optional resource/prompt support (#219) — present on the HTTP client.
  listResources?(): Promise<Array<{ uri: string; name?: string; description?: string }>>;
  readResource?(uri: string): Promise<string>;
  listPrompts?(): Promise<Array<{ name: string; description?: string }>>;
  getPrompt?(name: string, args?: Record<string, unknown>): Promise<string>;
}
import { zodToJsonSchema } from "./zod-to-json.js";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, join, dirname, extname, relative } from "node:path";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { AgentMessage, MetalmindConfig } from "@metalmind/schemas";
import type { ModelProvider, RouteDecision, TriageLabel, ModelCapabilities, ModelStreamEvent, SafetyViolation } from "@metalmind/core";
import type { ToolAuditEntry } from "@metalmind/tools";
import { ModelRouter, estimateTokens, evaluateQuality, Coordinator, SafetyValidator, LatencyTracker } from "@metalmind/core";
import type { CoordinatorPhase, PlanStep } from "@metalmind/core";
import type { ModelRoutingDecision } from "@metalmind/schemas";
import type { ChatStreamEvent } from "./hooks/useChat.js";
import { providerCredentials, type TuiConfig } from "./config.js";
import { Redactor, StreamRedactor, collectSecrets } from "./redact.js";
import { loadHooks, runHooks, type HookDef, type HookEvent } from "./lifecycle-hooks.js";
import { isWorkspaceTrusted, trustWorkspace, revokeWorkspaceTrust, declaredCapabilities } from "./workspace-trust.js";
import { retrieveContext } from "./rag/manager.js";
import { mentionsContextBlock } from "./mentions.js";
import { isAllowlisted } from "./approval-allowlist.js";
import { logError } from "./error-log.js";
import { loadTokens, getValidAccessToken } from "./mcp/oauth.js";

interface BufferedAttempt {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; argumentsJson: string }>;
  errored: boolean;
  errorMessage?: string;
}

function buildRegistry(projectRoot: string, tools?: MetalmindConfig["tools"]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allReadOnlyTools) registry.register(tool);
  // metalmind.yaml `tools` section (#347): a group explicitly set to false is
  // never registered, so the model doesn't see those tools at all.
  if (tools?.filesystem !== false) {
    for (const tool of allWriteTools) registry.register(tool);
    // Document tools: write Office/ODF/HTML/LaTeX/Markdown via writeDocument + format-specific tools.
    for (const tool of allDocumentTools) registry.register(tool);
  }
  if (tools?.git !== false) for (const tool of allGitTools) registry.register(tool);
  if (tools?.shell !== false) {
    for (const tool of runShellTools) registry.register(tool);
    // Background process tools: run/poll/stop long-running commands.
    for (const tool of backgroundShellTools) registry.register(tool);
  }
  // Code-intelligence tools: symbol/reference/call-graph navigation + LSP diagnostics.
  for (const tool of allSymbolTools) registry.register(tool);
  registry.register(createDiagnosticsTool(projectRoot));
  // Web tools: fetch a URL / search the web.
  for (const tool of allWebTools) registry.register(tool);
  return registry;
}

/** metalmind.yaml `permissions` (#347): a category explicitly set to `true`
 *  pre-approves that category's tools for this project ("ask"/false keep the
 *  normal approval gate). */
const YAML_PERM_CATEGORIES: Array<{ key: "allowWriteFiles" | "allowDeleteFiles" | "allowShellCommands" | "allowGitCommit"; tools: Set<string> }> = [
  { key: "allowWriteFiles", tools: new Set(["writeFile", "createFile", "editFile", "moveFile", "multiEdit", "replaceInProject", "createDirectory", "writeDocument"]) },
  { key: "allowDeleteFiles", tools: new Set(["deleteFile", "deleteDirectory"]) },
  { key: "allowShellCommands", tools: new Set(["runCommand", "runBackground"]) },
  { key: "allowGitCommit", tools: new Set(["gitAdd", "gitCommit", "gitPush"]) },
];
function yamlPreapproved(perms: MetalmindConfig["permissions"], toolName: string): boolean {
  if (!perms) return false;
  return YAML_PERM_CATEGORIES.some((c) => perms[c.key] === true && c.tools.has(toolName));
}

/** Identity of the slice a readFile call returned, for stale-read superseding (#362).
 *  A read with neither offset nor limit covers the whole file ("full") and so
 *  supersedes every earlier window; a windowed read only supersedes itself. */
function readWindowKey(input: Record<string, unknown>): string {
  const hasOffset = typeof input.offset === "number";
  const hasLimit = typeof input.limit === "number";
  if (!hasOffset && !hasLimit) return "full";
  return `${hasOffset ? input.offset : 0}:${hasLimit ? input.limit : "default"}`;
}

/** Shrink an oversized single message instead of deleting it (#421).
 *  A single huge tool result (e.g. gitDiff of a large change) could otherwise
 *  drive the trim loop past the last user message and leave history = [system]:
 *  the model then answered a question it could no longer see, and the
 *  conversation was destroyed for the rest of the session. */
function truncateMessageToFit(m: AgentMessage, maxTokens: number): AgentMessage {
  const maxChars = Math.max(400, maxTokens * 4);
  if (m.content.length <= maxChars) return m;
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  return {
    ...m,
    content:
      m.content.slice(0, head) +
      `\n\n…[${(m.content.length - maxChars).toLocaleString()} characters omitted — this result was too large for the context window]…\n\n` +
      m.content.slice(m.content.length - tail),
  };
}

/** Whether the provider backing `tier` can actually execute tool calls (#422).
 *  PROVIDER_CAPABILITIES mirrors the provider classes' own constants. */
function tierCanCallTools(router: ModelRouter, tier: "tier1-local" | "tier2-medium" | "tier3-cloud"): boolean {
  try {
    const d = router.decisionForTier(tier, "capability probe", false);
    return PROVIDER_CAPABILITIES[d.provider]?.supportsToolCalling !== false;
  } catch {
    return true; // never block routing on a probe failure
  }
}

/** Exponential backoff for transient retries: 0.5s, 1s, 2s, … capped at 8s. */
function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

/** Cancellable sleep — resolves early if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonTypeMatches(v: unknown, t: string): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "number":
    case "integer": return typeof v === "number";
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: return true;
  }
}

/** Minimal JSON-Schema check for MCP tool args: required fields + top-level types (#240). */
function validateAgainstJsonSchema(args: Record<string, unknown>, schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { type?: string; required?: string[]; properties?: Record<string, { type?: string }> };
  if (s.type && s.type !== "object") return null;
  for (const req of s.required ?? []) {
    if (!(req in args) || args[req] === undefined) return `missing required argument "${req}"`;
  }
  for (const [k, v] of Object.entries(args)) {
    const expected = s.properties?.[k]?.type;
    if (expected && !jsonTypeMatches(v, expected)) return `argument "${k}" should be of type ${expected}`;
  }
  return null;
}

/** Map over items with bounded concurrency, preserving input order in the result. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

/** File-mutating tools whose targets are snapshotted before execution for /undo. */
const MUTATING_FILE_TOOLS = new Set(["writeFile", "createFile", "editFile", "deleteFile"]);
/** Document/spreadsheet writers: they take a `path` and overwrite it, so they
 *  need the same checkpoint + /undo snapshot + re-index treatment as the plain
 *  file writers — previously they had none of it (#376). */
const DOCUMENT_WRITE_TOOLS = new Set([
  "writeDocument", "createHtml", "createLatex", "createMarkdown", "createDocx",
  "createOdt", "createPptx", "createOdp", "createXlsx", "createOds", "createCsv",
]);
/** Tools that execute a model-overridable shell command — all must be validated (#252). */
const SHELL_COMMAND_TOOLS = new Set(["runCommand", "runBackground", "runTests", "runBuild", "runLint", "runFormat"]);
/** Numeric rank of a tier so escalation can detect when it isn't moving up (#249). */
function tierRank(t: string): number {
  return t === "tier1-local" ? 1 : t === "tier2-medium" ? 2 : 3;
}

/** Providers that require an API key (so a missing key gets a clear error, #231). */
const PROVIDERS_NEEDING_KEY = new Set(["anthropic", "openai", "ollama-cloud"]);
const PROVIDER_ENV_VAR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
};

/** Side-effect-free built-in tools that are safe to execute concurrently in one turn (#206). */
const READ_ONLY_PARALLEL_TOOLS = new Set([
  "readFile",
  "listDirectory",
  "findFiles",
  "searchInFiles",
  "findSymbol",
  "findReferences",
  "getCallGraph",
  "getDiagnostics",
  "webFetch",
  "webSearch",
  "gitStatus",
  "gitDiff",
  "gitDiffFile",
  "gitCurrentBranch",
]);

/** Project memory/rules files auto-loaded into the system prompt, in priority order. */
const PROJECT_MEMORY_FILES = ["AGENTS.md", "CLAUDE.md", ".metalmind/MEMORY.md", "CONVENTIONS.md", ".cursorrules"];

/** Directories skipped by the startup symbol-index crawl. */
const INDEX_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "target", ".venv", "__pycache__"]);
/** Source extensions the symbol indexer understands. */
const INDEXABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp"]);
const INDEX_MAX_FILES = 400;

/** Model-facing definition for the cloud→local delegation tool (#186/#187). */
const DELEGATE_TO_LOCAL_DEF = {
  name: "delegateToLocal",
  description:
    "Offload bounded, repetitive subtasks to the fast LOCAL model — they run in parallel and are cached. " +
    "Use this in remote-brain mode to process many files or items cheaply before you reason over the results. " +
    "taskType is one of: summarizeFile, extractSymbols, extractImports, rankRelevantFiles, summarizeDiff, summarizeCommandOutput. " +
    "Each item of `inputs` is one task's input object: summarizeFile/extractSymbols/extractImports take { filePath } " +
    "(file contents are read for you), rankRelevantFiles takes { userGoal, candidateFiles }, summarizeDiff takes " +
    "{ diff }, summarizeCommandOutput takes { command, output }.",
  inputSchema: {
    type: "object",
    properties: {
      taskType: { type: "string", description: "The local worker task to run for each input." },
      inputs: {
        type: "array",
        items: { type: "object" },
        description: "One input object per delegated subtask (up to 16).",
      },
    },
    required: ["taskType", "inputs"],
  },
};

/** Model-facing definition for the general sub-agent delegation tool (#210). */
const TASK_TOOL_DEF = {
  name: "task",
  description:
    "Delegate a focused, self-contained subtask to a fresh sub-agent that has its own short tool loop and " +
    "an isolated history, and returns a concise result. Use this to keep your main context clean — e.g. " +
    '"find where X is configured and summarize", "investigate why test Y fails". The sub-agent cannot spawn ' +
    "further sub-agents. Give it a complete, unambiguous objective; it cannot ask follow-up questions.",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "A complete, self-contained description of the subtask." },
    },
    required: ["objective"],
  },
};

/** Model-facing definition for the long-term memory tool (#218). */
/** A single item on the model-managed task list (#276). */
export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

const SET_TODOS_TOOL_DEF = {
  name: "setTodos",
  description:
    "Maintain a visible task list for multi-step work. Call with the FULL list each time (it replaces the " +
    "previous one): mark the current step in_progress, finished steps completed, and the rest pending. " +
    "Use it whenever a request takes 3+ distinct steps, and update it as you complete each step.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Short imperative step description." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["text", "status"],
        },
        description: "The complete, ordered task list (replaces the previous list).",
      },
    },
    required: ["todos"],
  },
};

const REMEMBER_TOOL_DEF = {
  name: "remember",
  description:
    "Save a durable fact to long-term memory (.metalmind/MEMORY.md) so it's available in future sessions. " +
    "Use sparingly for things worth persisting: project conventions, the user's stable preferences, or hard-won " +
    "context that isn't obvious from the code. Don't save transient or easily-rediscovered details.",
  inputSchema: {
    type: "object",
    properties: { fact: { type: "string", description: "A concise, self-contained fact to remember." } },
    required: ["fact"],
  },
};

interface EditSet {
  turn: number;
  /** `before` is the pre-edit content (null = the file did not exist).
   *  `afterHash` is the content hash right AFTER the agent's write, so /undo can
   *  tell "unchanged since the agent touched it" from "the user edited it
   *  afterwards" and refuse to clobber the user's work (#382). */
  files: Array<{ path: string; before: string | null; afterHash?: string | null }>;
}

/** Content hash for undo-safety comparisons; null when the file is absent. */
function contentHash(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

interface TierTarget {
  provider: string;
  model: string;
  baseUrl?: string;
}

/** Known per-provider capabilities (mirrors the provider classes' constants). */
const PROVIDER_CAPABILITIES: Record<string, ModelCapabilities> = {
  mlx: {
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsJsonMode: false,
    maximumContextTokens: 32_768,
  },
  ollama: {
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsJsonMode: true,
    maximumContextTokens: 128_000,
  },
  "ollama-cloud": {
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsJsonMode: true,
    maximumContextTokens: 128_000,
  },
  anthropic: {
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsJsonMode: false,
    maximumContextTokens: 200_000,
  },
  openai: {
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsJsonMode: true,
    maximumContextTokens: 256_000,
  },
};

export function isAppleSilicon(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/** Resolve a metalmind.yaml named-model reference to a provider/model target. */
export function resolveNamedTier(
  name: string | undefined,
  models: MetalmindConfig["models"],
): TierTarget | undefined {
  if (!name) return undefined;
  const entry = models?.[name];
  return entry ? { provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl } : undefined;
}

/** Default local tier: MLX on Apple Silicon (GPU), Ollama elsewhere. */
export function defaultLocalTier(appleSilicon: boolean): TierTarget {
  return appleSilicon
    ? { provider: "mlx", model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit" }
    : { provider: "ollama", model: "deepseek-coder:1.3b" };
}

function tierCapabilities(targets: TierTarget[]): Record<string, ModelCapabilities> {
  const registry: Record<string, ModelCapabilities> = {};
  for (const t of targets) {
    const caps = PROVIDER_CAPABILITIES[t.provider];
    if (caps) registry[`${t.provider}/${t.model}`] = caps;
  }
  return registry;
}

async function mlxSidecarReady(target: TierTarget): Promise<boolean> {
  const baseUrl = target.baseUrl ?? "http://127.0.0.1:8742";
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    // If the sidecar is up but no model is loaded yet, don't treat it as
    // ready — skip to tier 2 instead of returning a 503 to the user.
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (body.model_loaded === false) return false;
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalTier(fileConfig: MetalmindConfig, userConfig: TuiConfig): Promise<TierTarget> {
  const models = fileConfig.models ?? {};
  const routing = fileConfig.routing;
  
  // 1. Try project-local metalmind.yaml
  const namedLocal = resolveNamedTier(routing?.defaultLocalModel, models);
  if (namedLocal) {
    if (namedLocal.provider !== "mlx" || await mlxSidecarReady(namedLocal)) return namedLocal;
  }

  // 2. Try global config.json routing — only search LOCAL providers (mlx, ollama).
  //    Never resolve a local tier from cloud providers like openai/anthropic/ollama-cloud,
  //    even if the user's XDG config lists the same model name there (e.g. from LM Studio).
  const LOCAL_PROVIDERS = new Set(["mlx", "ollama"]);
  const globalRouting = userConfig.routing;
  if (globalRouting?.defaultLocalModel) {
    for (const [provider, modelList] of Object.entries(userConfig.models || {})) {
      if (!LOCAL_PROVIDERS.has(provider)) continue; // skip openai, anthropic, ollama-cloud, etc.
      if ((modelList as string[]).includes(globalRouting.defaultLocalModel)) {
        const globalNamed = { provider, model: globalRouting.defaultLocalModel };
        if (globalNamed.provider !== "mlx" || await mlxSidecarReady(globalNamed)) return globalNamed;
      }
    }
    // If the model string is an absolute path, treat it as an MLX model.
    if (globalRouting.defaultLocalModel.startsWith("/")) {
      const globalNamed = { provider: "mlx", model: globalRouting.defaultLocalModel };
      if (await mlxSidecarReady(globalNamed)) return globalNamed;
    }
  }

  // 3. Fallback to hardcoded defaults
  const fallback = defaultLocalTier(isAppleSilicon());
  if (fallback.provider !== "mlx" || await mlxSidecarReady(fallback)) return fallback;

  return defaultLocalTier(false);
}

/**
 * Build a three-tier router:
 *   Tier 1 — MLX (Apple Silicon GPU, HuggingFace model via sidecar)
 *   Tier 2 — Local Ollama (CPU/GPU fallback, no API key needed)
 *   Tier 3 — Ollama Cloud (large remote models, API key required)
 *
 * All tiers are configurable via metalmind.yaml. If the MLX sidecar is
 * unreachable the quality gate escalates to the next tier automatically.
 */
export function createDefaultRouter(
  config: TuiConfig,
  fileConfig: MetalmindConfig = loadConfigFromFile(),
): Promise<ModelRouter> {
  return (async () => {
    const models = { ...(fileConfig.models ?? {}) };
    const routing = fileConfig.routing;

    // Tier 1: MLX on Apple Silicon, or local Ollama on other hardware.
    const tier1 = await resolveLocalTier(fileConfig, config);

    // Tier 2: local Ollama fallback (named via defaultFallbackModel in yaml,
    // or a sensible built-in default).
    const tier2 = routing?.defaultFallbackModel
      ? (resolveNamedTier(routing.defaultFallbackModel, models) ?? { provider: "ollama", model: "ministral-3:3b" })
      : { provider: "ollama", model: "ministral-3:3b" };

    // Tier 3: cloud model for complex tasks.
    const defaultReasoning = { provider: config.provider, model: config.model };
    const tier3 = resolveNamedTier(routing?.defaultReasoningModel, models) ?? defaultReasoning;

    return new ModelRouter({
      tier1Provider: tier1.provider,
      tier1Model: tier1.model,
      tier2Provider: tier2.provider,
      tier2Model: tier2.model,
      tier3Provider: tier3.provider,
      tier3Model: tier3.model,
      localFirst: true,
      capabilities: tierCapabilities([tier1, tier2, tier3]),
      // Soft spend cap: cloud routing downgrades to local once reached (#182).
      budgetUsd: loadXdgConfig().budgetUsd,
    });
  })();
}

export type ForcedTier = 1 | 2 | 3 | null;

/** A pending human-in-the-loop approval for a side-effecting tool call (#138). */
export interface ApprovalRequest {
  toolName: string;
  kind: "write" | "shell" | "git" | "mcp" | "other";
  summary: string;
  /** Unified diff for write/edit tools (rendered by DiffView). */
  diff?: string;
  /** Shell command for runCommand/runBackground. */
  command?: string;
  filePath?: string;
  /** Human-readable description of what an "always allow" would cover (#377). */
  scopeLabel?: string;
}

/** Render an approval scope key as something a human can judge (#377). */
function scopeLabel(scope: string): string {
  const idx = scope.indexOf(":");
  if (idx === -1) return `every "${scope}" call this session`;
  const tool = scope.slice(0, idx);
  const target = scope.slice(idx + 1);
  const shown = target.length > 90 ? target.slice(0, 89) + "…" : target;
  return `"${tool}" with exactly these arguments: ${shown}`;
}

export type ApprovalDecision = "approve" | "reject" | "always";

export interface AgentLoopOptions {
  /** When provided, the loop routes each turn via the router instead of a fixed provider. */
  router?: ModelRouter;
  /** Called whenever a turn is routed, so the UI can show the active tier/model. */
  onRoute?: (decision: RouteDecision) => void;
  /** Called when the coordinator phase changes. */
  onCoordinatorPhase?: (phase: CoordinatorPhase) => void;
  /** Called when the coordinator makes a routing decision. */
  onCoordinatorRouting?: (decision: ModelRoutingDecision) => void;
  /** Called when the coordinator plan changes. */
  onCoordinatorPlan?: (steps: PlanStep[]) => void;
  /** Model-managed task list updates (setTodos tool) (#276). */
  onTodos?: (todos: TodoItem[]) => void;
  /** Live output chunks from long-running tools (shell), already redacted. */
  onToolProgress?: (toolName: string, chunk: string) => void;
  /** Persistence problems the user MUST see (corrupt db, disabled store, failed saves) (#332). */
  onPersistenceIssue?: (message: string) => void;
  /** Called before each turn with the history token usage vs the active model's limit. */
  onContextUsage?: (used: number, limit: number) => void;
  /** Called when real token usage is reported by a provider (#157). */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Override the project root (defaults to process.cwd()); used for tests. */
  projectRoot?: string;
  /** Called before a side-effecting tool runs; resolves with the user's decision (#138). */
  onApprovalRequest?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export class AgentLoop {
  private config: TuiConfig;
  private router?: ModelRouter;
  private onRoute?: (decision: RouteDecision) => void;
  private onCoordinatorPhase?: (phase: CoordinatorPhase) => void;
  private onCoordinatorRouting?: (decision: ModelRoutingDecision) => void;
  private onCoordinatorPlan?: (steps: PlanStep[]) => void;
  private onTodos?: (todos: TodoItem[]) => void;
  private onToolProgress?: (toolName: string, chunk: string) => void;
  private onPersistenceIssue?: (message: string) => void;
  /** Surface a persistence/history-loss event: toast AND crash log (#412).
   *  A 6-second toast was the only trace, so /diagnostics could never explain
   *  why a conversation went missing. */
  private reportPersistenceIssue(message: string): void {
    logError("persistence", message);
    this.onPersistenceIssue?.(message);
  }
  private lastPersistError = "";
  private todos: TodoItem[] = [];
  private onContextUsage?: (used: number, limit: number) => void;
  private onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  private sessionUsage = { inputTokens: 0, outputTokens: 0 };
  private lastRoute = { provider: "", model: "" };
  private attemptTier = "";
  private attemptStartMs = 0;
  private latencyByTier = new Map<string, LatencyTracker>();
  private routingLog: Array<{ tier: string; provider: string; model: string; reason: string; at: string }> = [];
  private registry: ToolRegistry;
  private history: AgentMessage[] = [];
  private projectRoot: string;
  private turnCount = 0;
  private providerCache = new Map<string, ModelProvider>();
  private mcpTools = new Map<string, { client: McpToolClient; def: McpToolDef }>();
  private mcpStdioClients: McpClient[] = [];
  private mcpServerStatus = new Map<string, { connected: boolean; toolCount: number; error?: string }>();
  private workspaceRoots: string[] = [];
  private coordinator: Coordinator | null = null;
  private safetyValidator: SafetyValidator;
  private _forcedTier: ForcedTier = null;
  private tierOverrides = new Map<1 | 2 | 3, { provider: string; model: string; baseUrl?: string }>();
  /** Transient "you're near the tool-use iteration cap" notice, injected into the
   *  next model request only (never persisted to history) (#248). */
  private iterationCapNotice: string | null = null;
  /** Per-turn @-mention/RAG context blocks, injected into this turn's requests only
   *  (never persisted to history, so they don't accumulate every turn) (#260). */
  private turnContext: string[] = [];
  /** Set when the project changed (edits, restore) so the system prompt — repo map
   *  included — is rebuilt at the next turn instead of staying stale (#302). */
  private systemPromptDirty = false;
  /** True once this turn edited a file — end-of-turn verification runs then (#282). */
  private editedThisTurn = false;
  /** Remaining fix-it retries for a failing end-of-turn check (#282). */
  private verifyRetriesLeft = 2;
  /** Memoized repo-map string (repo walks are expensive); refreshed in the
   *  background after edits rather than on the next turn's critical path (#340). */
  private repoMapCache: string | null | undefined;
  private repoMapRebuildQueued = false;
  /** User lifecycle hooks: pre/post-tool, sessionStart, stop (#346). */
  private lifecycleHooks: Partial<Record<HookEvent, HookDef[]>> = {};
  /** Execute-on-open features this project declares but is not trusted for (#442). */
  private untrustedCapabilities: string[] = [];
  /** metalmind.yaml permissions/tools sections, honored since #347. */
  private yamlPermissions: MetalmindConfig["permissions"];
  private yamlTools: MetalmindConfig["tools"];
  /** Build vs Plan agent mode. In "plan" mode the agent investigates and proposes
   *  a plan but cannot mutate files/repo (mutating tools are hidden + refused) (#11). */
  private mode: "build" | "plan" = "build";
  private remoteBrain = false;
  private subagentDepth = 0;
  private pendingImages: string[] = [];
  private pendingReplaceTargets: string[] = []; // files a replaceInProject is about to change (#226)
  private auditLog = new AuditLog();
  /** Audit-log sink that scrubs secrets from tool inputs/outputs before recording (#238). */
  private auditLogRedacted = (entry: ToolAuditEntry): void => {
    this.auditLog.log({
      ...entry,
      input: this.redactValue(entry.input) as Record<string, unknown>,
      output: typeof entry.output === "string" ? this.redactor.redact(entry.output) : this.redactValue(entry.output),
      ...(entry.error ? { error: this.redactor.redact(entry.error) } : {}),
    });
  };
  private editStack: EditSet[] = [];
  private redoStack: EditSet[] = [];
  private redactor = new Redactor([]);
  private onApprovalRequest?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  private alwaysAllow = new Set<string>();
  private autoApprove = false;
  private skillLoader = new SkillLoader();
  private skillManager = new SkillManager();
  private sessionStore: SessionStore | null = null;
  private sessionId: string | null = null;

  constructor(config: TuiConfig, options: AgentLoopOptions = {}) {
    this.config = config;
    this.router = options.router;
    this.onRoute = options.onRoute;
    this.onCoordinatorPhase = options.onCoordinatorPhase;
    this.onCoordinatorRouting = options.onCoordinatorRouting;
    this.onCoordinatorPlan = options.onCoordinatorPlan;
    this.onTodos = options.onTodos;
    this.onToolProgress = options.onToolProgress;
    this.onPersistenceIssue = options.onPersistenceIssue;
    this.onContextUsage = options.onContextUsage;
    this.onUsage = options.onUsage;
    this.onApprovalRequest = options.onApprovalRequest;
    const xdg = loadXdgConfig();
    this.autoApprove = xdg.permissions?.autoApprove ?? false;
    this.remoteBrain = xdg.remoteBrain ?? false;
    // Restore persisted per-tier model overrides (#185).
    for (const [tier, tm] of Object.entries(xdg.tierModels ?? {})) {
      const t = Number(tier);
      if ((t === 1 || t === 2 || t === 3) && tm?.provider && tm?.model) {
        this.tierOverrides.set(t as 1 | 2 | 3, { provider: tm.provider, model: tm.model, baseUrl: tm.baseUrl });
      }
    }
    this.rebuildRedactor();
    this.projectRoot = options.projectRoot ?? process.cwd();
    // metalmind.yaml permissions/tools now shape the registry + approval gate (#347).
    const yamlCfg = loadConfigFromFile(this.projectRoot);
    // A repo must not be able to switch OFF the approval gate just by shipping a
    // metalmind.yaml (#443) — permission grants require trust. tools:* (which
    // only ever REMOVES tools) stays honoured, since it cannot escalate.
    this.yamlPermissions = isWorkspaceTrusted(this.projectRoot) ? yamlCfg.permissions : undefined;
    this.yamlTools = yamlCfg.tools;
    this.registry = buildRegistry(this.projectRoot, yamlCfg.tools);
    this.workspaceRoots = loadXdgConfig().workspacePaths ?? [];
    // The validator must KNOW the added roots (#410), otherwise every
    // "../other-repo/src/x.ts" path the search tools legitimately return is
    // rejected as traversal and /workspace is decorative.
    this.safetyValidator = new SafetyValidator(this.projectRoot, this.workspaceRoots);
    // Warm the symbol/reference index in the background so findSymbol/findReferences
    // return results without blocking startup (#149).
    this.indexProjectInBackground();
    // Discover skills; activating one updates the live system prompt (#156).
    this.skillManager.setToolRegistry(this.registry);
    // Skills may require/bind MCP tools, which live outside the built-in
    // registry; give the manager a live view of them (#380).
    this.skillManager.setExternalToolSource(() => this.mcpTools.keys());
    this.skillManager.onSystemPromptChange(() => {
      if (this.history[0]?.role === "system") {
        this.history[0] = { role: "system", content: this.buildSystemPrompt() };
      }
    });
    try {
      this.skillLoader.loadAll(this.projectRoot);
    } catch {
      // skill discovery failure must never block startup
    }
    // User lifecycle hooks (#346), gated by workspace trust (#442): a cloned
    // repo's .metalmind/hooks.json used to run its sessionStart command as soon
    // as the agent was constructed — opening a project was enough to execute
    // that project's code. The GLOBAL hooks file is always honoured (the user
    // wrote it); the PROJECT one requires trust.
    const trusted = isWorkspaceTrusted(this.projectRoot);
    this.lifecycleHooks = loadHooks(this.projectRoot, { includeProject: trusted });
    this.untrustedCapabilities = trusted ? [] : declaredCapabilities(this.projectRoot);
    if (this.untrustedCapabilities.length > 0) {
      this.onPersistenceIssue?.(
        `This project declares ${this.untrustedCapabilities.length} startup hook(s)/server(s) that are NOT running because the workspace is untrusted. Review them, then run /trust to enable.`,
      );
    }
    void runHooks(this.lifecycleHooks, "sessionStart", this.projectRoot).catch(() => {});
  }

  /** Workspace trust state, for /trust (#442/#443). */
  trustStatus(): { trusted: boolean; declared: string[] } {
    return { trusted: isWorkspaceTrusted(this.projectRoot), declared: declaredCapabilities(this.projectRoot) };
  }

  /** Trust this project's execute-on-open features; takes effect on reload. */
  trustThisWorkspace(): string {
    trustWorkspace(this.projectRoot);
    return `Trusted ${this.projectRoot}. Project hooks and metalmind.yaml servers/permissions apply from the next session (/clear or restart to apply now).`;
  }

  /** Revoke trust for this project. */
  revokeThisWorkspace(): string {
    revokeWorkspaceTrust(this.projectRoot);
    return `Revoked trust for ${this.projectRoot}. Project hooks and metalmind.yaml servers/permissions are disabled again.`;
  }

  /** List discovered skills with their active state, for `/skill list` (#156). */
  listSkills(): string {
    const all = this.skillLoader.getSkills();
    if (all.length === 0) {
      return "No skills found. Add one at .metalmind/skills/<name>/SKILL.md (project) or ~/.metalmind/skills/<name>/SKILL.md (global).";
    }
    return all
      .map((s) => `${this.skillManager.isActive(s.metadata.name) ? "● active " : "○ inactive"}  ${s.metadata.name} v${s.metadata.version} — ${s.metadata.description}`)
      .join("\n");
  }

  activateSkill(name: string): string {
    const skill = this.skillLoader.getSkill(name);
    if (!skill) return `Skill "${name}" not found. Run /skill list.`;
    const res = this.skillManager.activate(skill);
    return res.success
      ? `Activated skill "${name}" — its instructions now apply to subsequent turns.`
      : `Could not activate "${name}": ${res.error}`;
  }

  deactivateSkill(name: string): string {
    return this.skillManager.deactivate(name) ? `Deactivated skill "${name}".` : `Skill "${name}" was not active.`;
  }

  get coordinatorInstance(): Coordinator | null {
    return this.coordinator;
  }

  /** The project root the agent operates in (for the /rag index path) (#200). */
  get projectRootPath(): string {
    return this.projectRoot;
  }

  /** Force every subsequent turn to use a specific tier (1=MLX, 2=local Ollama, 3=cloud).
   *  Pass null to restore automatic routing. */
  setForcedTier(tier: ForcedTier): void {
    this._forcedTier = tier;
  }

  get forcedTier(): ForcedTier {
    return this._forcedTier;
  }

  /** Override the provider/model used when a specific tier is active, and persist it (#185).
   *  Tier 2 = the local Ollama model, tier 3 = the remote (Ollama Cloud) model. */
  setTierModel(tier: 1 | 2 | 3, provider: string, model: string, baseUrl?: string): void {
    this.tierOverrides.set(tier, { provider, model, baseUrl });
    try {
      const xdg = loadXdgConfig();
      saveXdgConfig({ ...xdg, tierModels: { ...(xdg.tierModels ?? {}), [tier]: { provider, model, ...(baseUrl ? { baseUrl } : {}) } } });
    } catch {
      // persistence is best-effort
    }
  }

  getTierModel(tier: 1 | 2 | 3): { provider: string; model: string; baseUrl?: string } | undefined {
    return this.tierOverrides.get(tier);
  }

  /** Remote-brain mode: the cloud model coordinates; bounded subtasks go to the local model (#186). */
  isRemoteBrain(): boolean {
    return this.remoteBrain;
  }

  setRemoteBrain(on: boolean): void {
    this.remoteBrain = on;
    try {
      const xdg = loadXdgConfig();
      saveXdgConfig({ ...xdg, remoteBrain: on });
    } catch {
      // best-effort
    }
  }

  /** Validate + store the model's task list and mirror it to the UI (#276). */
  private handleSetTodos(input: Record<string, unknown>): string {
    const raw = Array.isArray(input.todos) ? input.todos : null;
    if (!raw) return "setTodos requires { todos: [{ text, status }] }.";
    const valid: TodoItem[] = [];
    for (const t of raw.slice(0, 30)) {
      const text = typeof (t as TodoItem).text === "string" ? (t as TodoItem).text.trim() : "";
      const status = (t as TodoItem).status;
      if (!text || !["pending", "in_progress", "completed"].includes(status)) continue;
      valid.push({ text: text.slice(0, 200), status });
    }
    this.todos = valid;
    this.onTodos?.(valid);
    const done = valid.filter((t) => t.status === "completed").length;
    return `Task list updated: ${done}/${valid.length} completed.`;
  }

  /** Current model-managed task list (#276). */
  getTodos(): TodoItem[] {
    return [...this.todos];
  }

  /** `git status --porcelain` snapshot; null when not a git repo (#296/#297). */
  private gitStatusSnapshot(): string | null {
    try {
      return execFileSync("git", ["status", "--porcelain"], {
        cwd: this.projectRoot, encoding: "utf-8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  }

  /** After an MCP/shell tool ran, detect files it changed (git-status diff) and
   *  put them through the same post-edit pipeline as built-in edits: re-index,
   *  prompt refresh, end-of-turn verification, and diagnostics (#296). */
  private async postMutationScan(preStatus: string | null, output: string): Promise<string> {
    if (preStatus === null) return output;
    const post = this.gitStatusSnapshot();
    if (post === null || post === preStatus) return output;
    const pre = new Set(preStatus.split("\n").filter(Boolean));
    const changed = post
      .split("\n")
      .filter((l) => l && !pre.has(l))
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20);
    if (changed.length === 0) return output;
    this.systemPromptDirty = true;
    this.scheduleRepoMapRebuild();
    this.editedThisTurn = true;
    for (const p of changed) {
      try { indexFile(this.resolveProjectPath(p)); } catch { /* unparseable */ }
    }
    const diag = await this.diagnosticsFor(changed[0]);
    return diag ? `${output}\n\n[diagnostics: ${changed[0]}]\n${diag}` : output;
  }

  // --- Turn-level git checkpoints (#297): a worktree snapshot before the first
  // mutating tool of a turn, restorable with /rollback even after shell/git
  // mutations that the file-level undo stack can't see. Uses a TEMP index so the
  // user's real index/staging area is never touched.
  private turnCheckpoints: Array<{ turn: number; sha: string; at: string }> = [];
  private checkpointedThisTurn = false;

  private gitCheckpoint(): void {
    if (this.checkpointedThisTurn) return;
    const tmpIndex = join(tmpdir(), `mm-ckpt-${process.pid}-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      execFileSync("git", ["add", "-A"], { cwd: this.projectRoot, env, timeout: 30_000 });
      const tree = execFileSync("git", ["write-tree"], { cwd: this.projectRoot, env, encoding: "utf-8", timeout: 10_000 }).trim();
      const sha = execFileSync(
        "git", ["commit-tree", tree, "-m", `metalmind checkpoint (turn ${this.turnCount})`],
        { cwd: this.projectRoot, env, encoding: "utf-8", timeout: 10_000 },
      ).trim();
      this.turnCheckpoints.push({ turn: this.turnCount, sha, at: new Date().toISOString() });
      if (this.turnCheckpoints.length > 50) this.turnCheckpoints.shift();
      this.checkpointedThisTurn = true;
    } catch {
      // not a git repo / git unavailable — checkpointing silently disabled
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  /** List turn checkpoints for /checkpoints (#297). */
  listCheckpoints(): string {
    if (this.turnCheckpoints.length === 0) return "No checkpoints yet — one is taken before each turn's first mutating tool.";
    return this.turnCheckpoints
      .map((c) => `  turn ${c.turn}  ${c.sha.slice(0, 10)}  ${c.at}`)
      .join("\n");
  }

  /** Restore the worktree to a checkpoint (#297). Files created after the
   *  checkpoint are left in place; tracked files are restored to the snapshot. */
  rollbackToCheckpoint(turn?: number): string {
    const ckpt = turn != null ? this.turnCheckpoints.find((c) => c.turn === turn) : this.turnCheckpoints.at(-1);
    if (!ckpt) return turn != null ? `No checkpoint for turn ${turn}. See /checkpoints.` : "No checkpoints to roll back to.";
    const tmpIndex = join(tmpdir(), `mm-restore-${process.pid}-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      execFileSync("git", ["read-tree", ckpt.sha], { cwd: this.projectRoot, env, timeout: 30_000 });
      execFileSync("git", ["checkout-index", "-af"], { cwd: this.projectRoot, env, timeout: 60_000 });
      this.systemPromptDirty = true;
      this.scheduleRepoMapRebuild();
      // The file-level /undo//redo snapshots describe a timeline that no longer
      // exists — /undo after a rollback would silently RE-APPLY the rolled-back
      // edits. Invalidate both stacks so the two restore systems can't fight.
      this.editStack.length = 0;
      this.redoStack.length = 0;
      return `Restored the worktree to the turn-${ckpt.turn} checkpoint (${ckpt.sha.slice(0, 10)}). Files created since remain; delete them manually if unwanted. (File-level /undo history was cleared — it predates this rollback.)`;
    } catch (err) {
      return `Rollback failed: ${errText(err)}`;
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  /** Resolve the project check command: config editor.checkCommand, else tsc when
   *  a tsconfig exists; empty string / checkOnEdit:false disables (#282). */
  private checkCommand(): string | null {
    const cfg = loadXdgConfig().editor;
    if (cfg?.checkOnEdit === false) return null;
    if (typeof cfg?.checkCommand === "string") return cfg.checkCommand.trim() || null;
    return existsSync(join(this.projectRoot, "tsconfig.json")) ? "npx tsc --noEmit" : null;
  }

  /** Run the project check ASYNCHRONOUSLY — the UI keeps rendering, Esc cancels
   *  (process-group kill), and output streams to the live panel. Returns null on
   *  pass/no-command/abort, else the bounded failure TAIL (#282, async per #333). */
  private async runProjectCheck(signal?: AbortSignal): Promise<string | null> {
    const cmd = this.checkCommand();
    if (!cmd) return null;
    const red = new StreamRedactor(this.redactor);
    const r = await runShellAsync(cmd, this.projectRoot, 60_000, signal, (c) => {
      const safe = red.push(c);
      if (safe) this.onToolProgress?.("project check", safe);
    });
    if (r.exitCode === 0 || signal?.aborted) return null;
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return (out || "check command failed").slice(-4_000);
  }

  /** /test, /check, /lint (#295): run the verification tool through the approval
   *  gate and record the result in history so the model sees it next turn.
   *  `signal` makes Esc actually cancel the run (the shell tools honour it). */
  async verifyFlow(kind: "test" | "check" | "lint", cmdOverride?: string, signal?: AbortSignal): Promise<string> {
    const progressRedactor = new StreamRedactor(this.redactor);
    const ctx = {
      projectRoot: this.projectRoot,
      workspaceRoots: this.workspaceRoots,
      auditLog: this.auditLogRedacted,
      signal,
      onOutput: (chunk: string) => {
        const safe = progressRedactor.push(chunk);
        if (safe) this.onToolProgress?.(`/${kind}`, safe);
      },
    };
    let toolName: string;
    let input: Record<string, unknown>;
    if (kind === "check") {
      const cmd = cmdOverride?.trim() || this.checkCommand();
      if (!cmd) return "No check command available — set editor.checkCommand in ~/.config/metalmind/config.json.";
      toolName = "runCommand";
      input = { command: cmd };
    } else {
      toolName = kind === "test" ? "runTests" : "runLint";
      input = cmdOverride?.trim() ? { command: cmdOverride.trim() } : {};
    }
    // Respect the persisted /allow allowlist like model-initiated calls do.
    if (this.needsApproval(toolName, input) && (await this.requestApproval(toolName, input)) === "reject") {
      return `/${kind} cancelled.`;
    }
    let out: string;
    try {
      out = String(await this.registry.execute(toolName, input, ctx));
    } catch (err) {
      out = `Error: ${errText(err)}`;
    }
    if (signal?.aborted) return `/${kind} cancelled.`;
    // Keep the TAIL: test/lint failures and the pass/fail trailer are at the END
    // of the output — head-truncation cut exactly the part that matters.
    out = this.redactor.redact(out);
    if (out.length > 8_000) out = `…(earlier output truncated)\n${out.slice(-8_000)}`;
    // Feed the result into history so the model can act on failures next turn (#295).
    // On a fresh session, build the REAL system prompt first — otherwise this
    // push makes history non-empty and runInner would never install it, leaving
    // the model without its instructions/tools context for the whole session.
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: this.buildSystemPrompt() });
    }
    this.history.push({ role: "system", content: `[/${kind} result]\n${out}` });
    this.saveSession();
    return out;
  }

  /** Deterministic /commit flow (#274): stage everything, generate a Conventional
   *  Commit message from the staged diff via the active model, then commit —
   *  both mutations pass through the normal approval gate. */
  async commitFlow(extraContext = "", signal?: AbortSignal): Promise<string> {
    const ctx = { projectRoot: this.projectRoot, workspaceRoots: this.workspaceRoots, auditLog: this.auditLogRedacted, signal };
    const status = String(await this.registry.execute("gitStatus", {}, ctx));
    if (status.includes("git exit")) return `Not a git repository?\n${status}`;
    // gitStatus uses --branch, so a "## main..." header line is ALWAYS present —
    // clean-tree detection must look for entries beyond it.
    const dirty = status.split("\n").some((l) => l.trim() && !l.startsWith("##"));
    if (!dirty) return "Working tree clean — nothing to commit.";

    // Stage all changes (approval-gated like a model-initiated call, honouring
    // the persisted /allow allowlist).
    if (this.needsApproval("gitAdd", { paths: ["."] }) && (await this.requestApproval("gitAdd", { paths: ["."] })) === "reject") {
      return "Commit cancelled (staging rejected).";
    }
    const addOut = String(await this.registry.execute("gitAdd", { paths: ["."] }, ctx));
    if (addOut.includes("git exit")) return `Staging failed:\n${addOut}`;

    // Redact BEFORE the diff reaches the (possibly cloud) model — the diff can
    // quote secrets straight out of config files.
    const diff = this.redactor.redact(String(await this.registry.execute("gitDiff", { staged: true }, ctx))).slice(0, 12_000);
    if (!diff.trim()) return "Nothing staged after git add — nothing to commit.";
    if (signal?.aborted) return "Commit cancelled.";

    // Generate a Conventional Commit message from the diff.
    let message = "chore: update";
    let generationFailed = false;
    try {
      const provider = this.getProvider(this.config.provider, this.config.model);
      const res = await this.completeChatWithRetry(provider, {
        messages: [
          {
            role: "system",
            content:
              "Write a Conventional Commit message for this diff: a `type: summary` line (feat/fix/chore/refactor/test/docs, " +
              "imperative, ≤72 chars), then a blank line and a concise body explaining what and why. Output ONLY the message.",
          },
          { role: "user", content: `${extraContext ? `Context from the user: ${extraContext}\n\n` : ""}Diff:\n${diff}` },
        ],
        signal,
      });
      const m = res.message.content.trim();
      if (m) message = m.replace(/^```[a-z]*\n?|```$/g, "").trim();
      else generationFailed = true;
    } catch {
      generationFailed = true; // fall back to the default message, but SAY so
    }
    if (signal?.aborted) return "Commit cancelled.";

    if (this.needsApproval("gitCommit", { message }) && (await this.requestApproval("gitCommit", { message })) === "reject") {
      return "Commit cancelled.";
    }
    const out = String(await this.registry.execute("gitCommit", { message }, ctx));
    // Redact: the message is model-generated FROM the diff, which can quote
    // secrets out of config files; scrub before it reaches the terminal.
    const note = generationFailed ? "\n(note: message generation failed — used a generic message; amend with git commit --amend if needed)" : "";
    return this.redactor.redact(
      out.includes("git exit") ? `Commit failed:\n${out}` : `Committed:\n${message.split("\n")[0]}${note}\n\n${out}`,
    );
  }

  /** /pr flow (#275): push the branch, generate a PR title/body from its commits,
   *  create the PR with gh — push and PR creation are approval-gated. */
  async prFlow(extraContext = "", signal?: AbortSignal): Promise<string> {
    const ctx = { projectRoot: this.projectRoot, workspaceRoots: this.workspaceRoots, auditLog: this.auditLogRedacted, signal };
    const branch = String(await this.registry.execute("gitCurrentBranch", {}, ctx)).trim();
    if (!branch || branch.includes("git exit")) return `Could not determine the current branch:\n${branch}`;
    if (branch === "main" || branch === "master") {
      return `You are on ${branch} — create a feature branch first (e.g. ask the agent: "create a branch for this change").`;
    }

    if (this.needsApproval("gitPush", {}) && (await this.requestApproval("gitPush", {})) === "reject") {
      return "PR cancelled (push rejected).";
    }
    const pushOut = String(await this.registry.execute("gitPush", {}, ctx));
    if (pushOut.includes("git exit")) return `Push failed:\n${pushOut}`;
    if (signal?.aborted) return "PR cancelled.";

    // Redact BEFORE the log reaches the (possibly cloud) model — commit subjects
    // can quote secrets.
    const log = this.redactor.redact(String(await this.registry.execute("gitLog", { count: 15 }, ctx))).slice(0, 4_000);
    let title = `${branch}`;
    let body = "";
    try {
      const provider = this.getProvider(this.config.provider, this.config.model);
      const res = await this.completeChatWithRetry(provider, {
        messages: [
          {
            role: "system",
            content:
              'Write a GitHub PR title and body for these commits. Reply as exactly:\nTITLE: <one line>\nBODY:\n<markdown summary of the changes>',
          },
          { role: "user", content: `Branch: ${branch}\n${extraContext ? `Context: ${extraContext}\n` : ""}Recent commits:\n${log}` },
        ],
        signal,
      });
      const text = res.message.content;
      const tm = /TITLE:\s*(.+)/.exec(text);
      const bm = /BODY:\s*\n?([\s\S]+)/.exec(text);
      if (tm) title = tm[1].trim().slice(0, 200);
      if (bm) body = bm[1].trim();
    } catch {
      body = `Commits:\n${log}`;
    }
    if (signal?.aborted) return "PR cancelled.";

    if (this.needsApproval("createPullRequest", { title, body }) && (await this.requestApproval("createPullRequest", { title, body })) === "reject") {
      return "PR cancelled.";
    }
    try {
      const out = String(await this.registry.execute("createPullRequest", { title, body }, ctx));
      return this.redactor.redact(`PR created: ${out}`);
    } catch (err) {
      return `PR creation failed: ${errText(err)}`;
    }
  }

  /** Build vs Plan mode (#11). Plan mode hides + refuses mutating tools and tells
   *  the model to produce a plan rather than edit. Refreshes the system prompt so
   *  the change takes effect on the next turn. */
  getMode(): "build" | "plan" {
    return this.mode;
  }

  setMode(mode: "build" | "plan"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.history[0]?.role === "system") {
      this.history[0] = { role: "system", content: this.buildSystemPrompt() };
    }
  }

  /** Stage an image (data URL or https URL) to attach to the next user turn (#177). */
  stageImage(url: string): void {
    this.pendingImages.push(url);
  }

  /** How many images are staged for the next turn (#177). */
  pendingImageCount(): number {
    return this.pendingImages.length;
  }

  get safety(): SafetyValidator {
    return this.safetyValidator;
  }

  addWorkspaceRoot(path: string): void {
    if (!this.workspaceRoots.includes(path)) {
      this.workspaceRoots = [...this.workspaceRoots, path];
      // Rebuild the validator so the new root is immediately usable (#410).
      this.safetyValidator = new SafetyValidator(this.projectRoot, this.workspaceRoots);
      this.systemPromptDirty = true; // the prompt lists the roots
      const cfg = loadXdgConfig();
      const existing = cfg.workspacePaths ?? [];
      if (!existing.includes(path)) {
        saveXdgConfig({ ...cfg, workspacePaths: [...existing, path] });
      }
    }
  }

  /** Connect to all enabled HTTP MCP servers and discover their tools. */
  /** Find a connected client for a server id (matches namespaced tool keys) (#219). */
  private mcpClientFor(id: string): McpToolClient | null {
    for (const [key, { client }] of this.mcpTools) {
      if (key.startsWith(`${id}:`)) return client;
    }
    return null;
  }

  /** List an MCP server's resources, read one, or list its prompts (#219). */
  async mcpResourcesReport(id: string): Promise<string> {
    const c = this.mcpClientFor(id);
    if (!c?.listResources) return `No connected MCP server "${id}" exposing resources.`;
    const resources = await c.listResources().catch((e) => { throw e; });
    if (resources.length === 0) return `"${id}" exposes no resources.`;
    return [`Resources on "${id}":`, ...resources.map((r) => `  ${r.uri}${r.name ? ` — ${r.name}` : ""}`)].join("\n");
  }

  async mcpReadResource(id: string, uri: string): Promise<string> {
    const c = this.mcpClientFor(id);
    if (!c?.readResource) return `No connected MCP server "${id}" exposing resources.`;
    const text = await c.readResource(uri);
    return this.redactor.redact(text || "(empty resource)");
  }

  async mcpPromptsReport(id: string): Promise<string> {
    const c = this.mcpClientFor(id);
    if (!c?.listPrompts) return `No connected MCP server "${id}" exposing prompts.`;
    const prompts = await c.listPrompts();
    if (prompts.length === 0) return `"${id}" exposes no prompts.`;
    return [`Prompts on "${id}":`, ...prompts.map((p) => `  ${p.name}${p.description ? ` — ${p.description}` : ""}`)].join("\n");
  }

  async initMcp(): Promise<void> {
    // metalmind.yaml `tools.mcp: false` disables MCP for this project (#347).
    if (this.yamlTools?.mcp === false) return;
    // Merged view: project metalmind.yaml `mcp` servers appear alongside the
    // globally configured ones (#347).
    // Project metalmind.yaml can declare an stdio "MCP server" — an arbitrary
    // command spawned at startup. Only honour those for a TRUSTED workspace
    // (#443); the user's own global config is always honoured.
    const userConfig = isWorkspaceTrusted(this.projectRoot)
      ? loadMergedConfig(this.projectRoot)
      : loadXdgConfig();
    for (const [id, srv] of Object.entries(userConfig.mcpServers || {})) {
      if (!srv.enabled) continue;
      try {
        if (srv.url) {
          // HTTP/SSE transport. For OAuth servers, attach a bearer — refreshing an
          // expired token first when the server's oauth endpoints are known (#199/#225).
          const headers = { ...(srv.headers ?? {}) };
          if (srv.authType === "oauth2") {
            let token: string | null = null;
            if (srv.oauth?.tokenEndpoint && srv.oauth?.clientId) {
              token = await getValidAccessToken(id, {
                tokenEndpoint: srv.oauth.tokenEndpoint,
                clientId: srv.oauth.clientId,
              }).catch(() => null);
            }
            if (!token) token = (await loadTokens(id).catch(() => null))?.accessToken ?? null;
            if (token) headers.Authorization = `Bearer ${token}`;
          }
          const client = new McpHttpClient(srv.url, headers);
          await client.initialize();
          let count = 0;
          for (const tool of await client.listTools()) {
            // Namespace by server id so two servers' same-named tools don't collide (#161).
            this.mcpTools.set(`${id}:${tool.name}`, { client, def: tool });
            count++;
          }
          this.mcpServerStatus.set(id, { connected: true, toolCount: count });
        } else if (srv.command) {
          // Stdio transport — spawn a command-based MCP server (#155).
          const stdio = new McpClient({ name: id, command: srv.command, args: srv.args, env: srv.env, cwd: srv.cwd });
          await stdio.connect();
          this.mcpStdioClients.push(stdio);
          const adapter: McpToolClient = {
            callTool: async (name, input) =>
              normalizeMcpResult(await stdio.callTool(name, (input ?? {}) as Record<string, unknown>)),
            // Liveness so a dead server is detected before the next call (#378).
            isHealthy: () => stdio.isHealthy(),
          };
          let count = 0;
          for (const tool of stdio.tools) {
            this.mcpTools.set(`${id}:${tool.name}`, { client: adapter, def: tool });
            count++;
          }
          this.mcpServerStatus.set(id, { connected: true, toolCount: count });
          // React the moment the process exits instead of waiting for a call to
          // time out: retire its tools and mark it disconnected in /mcp status (#378).
          stdio.on("disconnect", (code: unknown) => {
            const dropped = this.retireMcpClient(adapter);
            this.mcpServerStatus.set(id, {
              connected: false,
              toolCount: 0,
              error: `server exited (code ${String(code)}) — ${dropped} tool(s) withdrawn; /mcp reconnect to retry`,
            });
            this.reportPersistenceIssue(`MCP server "${id}" exited — ${dropped} tool(s) withdrawn. Run /mcp reconnect to bring it back.`);
          });
        }
        // else: neither url nor command configured — nothing to connect.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.mcpServerStatus.set(id, { connected: false, toolCount: 0, error: message });
        logError(`mcp:${id}`, err);
      }
    }
  }

  /** Per-server MCP connection status for /mcp status (#169). */
  getMcpStatus(): Array<{ id: string; connected: boolean; toolCount: number; error?: string }> {
    return [...this.mcpServerStatus.entries()].map(([id, s]) => ({ id, ...s }));
  }

  /** Tear down and re-establish all MCP connections (#169). */
  async reconnectMcp(): Promise<void> {
    for (const c of this.mcpStdioClients) await c.disconnect?.().catch(() => undefined);
    this.mcpStdioClients = [];
    this.mcpTools.clear();
    this.mcpServerStatus.clear();
    await this.initMcp();
  }

  /** Initialize the multi-agent coordinator with a local worker provider. */
  async initCoordinator(localWorkerProvider?: import("@metalmind/core").WorkerProvider): Promise<void> {
    if (!this.router) return;

    let workerProvider = localWorkerProvider ?? null;

    if (!workerProvider) {
      const detected = await AgentLoop.detectOllamaWorker();
      if (detected) workerProvider = detected;
    }

    this.coordinator = new Coordinator(
      this.getProvider(this.config.provider, this.config.model),
      workerProvider,
      {
        cacheEnabled: true,
        cacheTtlMs: 300_000,
        router: {},
        runner: {},
      },
    );

    this.coordinator.on("coordinator:status", ((event: { phase: CoordinatorPhase; message: string }) => {
      this.onCoordinatorPhase?.(event.phase);
    }) as (...args: unknown[]) => void);

    this.coordinator.on("coordinator:routing", ((event: { decision: ModelRoutingDecision }) => {
      this.onCoordinatorRouting?.(event.decision);
    }) as (...args: unknown[]) => void);

    this.coordinator.on("coordinator:plan", ((event: { plan: import("@metalmind/core").CoordinatorPlan }) => {
      this.onCoordinatorPlan?.(event.plan.steps);
    }) as (...args: unknown[]) => void);
  }

  /** Probe Ollama for a small local model suitable for worker tasks. */
  static async detectOllamaWorker(
    preferredModel?: string,
    baseUrl = "http://127.0.0.1:11434",
    apiKey?: string,
  ): Promise<OllamaWorkerProvider | null> {
    const candidateModels = preferredModel
      ? [preferredModel]
      : ["ministral-3:3b", "deepseek-coder:1.3b", "deepseek-coder:6.7b", "qwen2.5-coder:1.5b", "qwen2.5-coder:7b", "codellama:7b"];

    for (const modelId of candidateModels) {
      const provider = new OllamaWorkerProvider(modelId, baseUrl, apiKey);
      const available = await provider.isAvailable().catch(() => false);
      if (available) return provider;
    }

    return null;
  }

  get providerLabel(): string {
    return `${this.config.provider}/${this.config.model}`;
  }

  private getProvider(provider: string, model: string, baseUrlOverride?: string): ModelProvider {
    // A per-tier override may pin a specific host for this provider/model (#248).
    let baseUrl = baseUrlOverride;
    if (!baseUrl) {
      for (const ov of this.tierOverrides.values()) {
        if (ov.provider === provider && ov.model === model && ov.baseUrl) { baseUrl = ov.baseUrl; break; }
      }
    }
    const creds =
      provider === this.config.provider
        ? { apiKey: this.config.apiKey, baseUrl: baseUrl ?? this.config.baseUrl }
        : { ...providerCredentials(provider), ...(baseUrl ? { baseUrl } : {}) };
    // Key by baseUrl too — two tiers can share a provider/model but target
    // different hosts, and they must not collide in the cache (#248).
    const key = `${provider}/${model}@${creds.baseUrl ?? ""}`;
    let cached = this.providerCache.get(key);
    if (!cached) {
      // Clear, actionable error when the active cloud provider has no key (#231).
      // Scoped to the active provider — auto-escalation to other tiers keeps its
      // own fallback handling rather than hard-failing here.
      if (provider === this.config.provider && PROVIDERS_NEEDING_KEY.has(provider) && !creds.apiKey) {
        const envVar = PROVIDER_ENV_VAR[provider] ?? `${provider.toUpperCase()}_API_KEY`;
        throw new Error(
          `No API key for "${provider}". Set ${envVar} in your environment, or run /apikey <key> after switching to ${provider}.`,
        );
      }
      cached = createProvider(provider, model, creds);
      this.providerCache.set(key, cached);
    }
    return cached;
  }

  private toolDefs() {
    // Plan mode: expose only non-mutating tools so the model investigates and
    // proposes rather than edits (#11).
    const planMode = this.mode === "plan";
    const builtIn = this.registry
      .list()
      .filter((t) => !planMode || !t.requiresConfirmation)
      .map((t) => ({
        name: t.toolName,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      }));
    // Expose the namespaced key (serverId:toolName) to the model so collisions
    // across servers stay distinct; dispatch maps it back to the original name.
    // MCP tools can do anything the server implements — writes, network calls,
    // deployments. Plan mode claims to be read-only, so they must be withheld
    // there too; they used to be advertised AND executable, contradicting the
    // prompt's own statement (#391).
    const mcp = planMode
      ? []
      : [...this.mcpTools.entries()].map(([namespacedName, { def }]) => ({
          name: namespacedName,
          description: def.description,
          inputSchema: def.inputSchema,
        }));
    // In remote-brain mode the cloud model can offload bounded subtasks to the
    // small local model — but only expose it when a local worker actually exists,
    // so the model can't call into a runtime failure (#186/#187/#233).
    const delegate =
      this.remoteBrain && this.coordinator && this.coordinator.getRunner().hasProvider
        ? [DELEGATE_TO_LOCAL_DEF]
        : [];
    // General sub-agent delegation, but only at the top level — a sub-agent can't
    // spawn more sub-agents (prevents unbounded recursion) (#210). A sub-agent can
    // write, so it's withheld in plan mode (#11).
    const task = this.subagentDepth === 0 && !planMode ? [TASK_TOOL_DEF] : [];
    // Long-term memory tool, top-level only (#218); it writes, so not in plan mode.
    const remember = this.subagentDepth === 0 && !planMode ? [REMEMBER_TOOL_DEF] : [];
    // Task-list tool, top-level only; non-mutating, so plan mode keeps it (#276).
    const todos = this.subagentDepth === 0 ? [SET_TODOS_TOOL_DEF] : [];
    return [...builtIn, ...mcp, ...delegate, ...task, ...remember, ...todos];
  }

  /** /doctor: actionable environment diagnosis for onboarding and debugging.
   *  Each check is independent and never throws — ✓/✗ per line with the fix. */
  async doctorReport(): Promise<string> {
    const lines: string[] = ["MetalMind doctor:"];
    const check = (ok: boolean, label: string, detail: string) => lines.push(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);

    lines.push(`  · node ${process.version} on ${process.platform}`);

    // Project metalmind.yaml: a file that fails to parse/validate is discarded
    // WHOLE, so say so instead of letting every section vanish silently (#383).
    loadConfigFromFile(this.projectRoot);
    const cfgIssue = getConfigLoadIssue();
    if (cfgIssue) {
      check(false, "metalmind.yaml", `IGNORED (${cfgIssue.path}): ${cfgIssue.reason} — every section in it is inactive until this is fixed`);
    } else {
      const yaml = loadConfigFromFile(this.projectRoot);
      const sections = ["models", "routing", "permissions", "tools", "ui", "mcp"].filter(
        (k) => (yaml as Record<string, unknown>)[k] && Object.keys((yaml as Record<string, Record<string, unknown>>)[k] ?? {}).length > 0,
      );
      check(true, "metalmind.yaml", sections.length ? `active sections: ${sections.join(", ")}` : "none found (using defaults)");
    }

    // Local Ollama daemon
    try {
      const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
      const models = res.ok ? (((await res.json()) as { models?: unknown[] }).models?.length ?? 0) : 0;
      check(res.ok, "local ollama", res.ok ? `running, ${models} model(s) installed` : `responded ${res.status}`);
    } catch {
      check(false, "local ollama", "not reachable at 127.0.0.1:11434 — install/start Ollama for local tiers");
    }

    // Ollama Cloud key
    const cloudKey = process.env.OLLAMA_API_KEY || loadXdgConfig().apiKeys?.["ollama"] || loadXdgConfig().apiKeys?.["ollama-cloud"];
    if (!cloudKey) {
      check(false, "ollama cloud", "no API key — set OLLAMA_API_KEY (or /apikey) to enable the cloud tier");
    } else {
      try {
        const res = await fetch("https://api.ollama.com/api/tags", {
          headers: { Authorization: `Bearer ${cloudKey}` },
          signal: AbortSignal.timeout(5000),
        });
        const models = res.ok ? (((await res.json()) as { models?: unknown[] }).models?.length ?? 0) : 0;
        check(res.ok, "ollama cloud", res.ok ? `key valid, ${models} model(s) available` : `key rejected (${res.status}) — check OLLAMA_API_KEY`);
      } catch {
        check(false, "ollama cloud", "api.ollama.com not reachable (network?)");
      }
    }

    // Active provider/model
    try {
      const h = await this.checkHealth();
      check(h.ok, `active model (${this.config.provider}/${this.config.model})`, h.ok ? "healthy" : h.message);
    } catch (err) {
      check(false, `active model (${this.config.provider}/${this.config.model})`, errText(err));
    }

    // CLI dependencies
    const cli = (cmd: string, args: string[], label: string, why: string) => {
      try {
        const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 5000 }).split("\n")[0].trim();
        check(true, label, out);
      } catch {
        check(false, label, why);
      }
    };
    cli("rg", ["--version"], "ripgrep", "not found — brew install ripgrep (search falls back to a slower walk)");
    cli("gh", ["--version"], "gh CLI", "not found — brew install gh (needed for /pr)");
    cli("git", ["--version"], "git", "not found — required for /commit, checkpoints, and git tools");
    try {
      execFileSync("which", ["typescript-language-server"], { encoding: "utf-8", timeout: 5000 });
      check(true, "typescript-language-server", "installed (live diagnostics enabled)");
    } catch {
      check(false, "typescript-language-server", "not found — npm i -g typescript-language-server for live diagnostics");
    }

    // Project check command
    const cc = this.checkCommand();
    check(cc !== null, "project check", cc ? `"${cc}" runs after edited turns (/check)` : "none — set editor.checkCommand or add a tsconfig.json");

    // Persistence
    check(this.sessionStore !== null, "session persistence", this.sessionStore ? "sqlite store open" : "disabled (better-sqlite3 failed to load — npm rebuild better-sqlite3)");

    return lines.join("\n");
  }

  /** completeChat with bounded retries on TRANSIENT provider errors (429/5xx/
   *  network). streamResilient already retries streams; the non-streaming flows
   *  (/commit message, /pr body, triage, compaction) previously failed on the
   *  first blip. Honours Retry-After and never retries a user abort. */
  private async completeChatWithRetry(
    provider: ModelProvider,
    req: Parameters<ModelProvider["completeChat"]>[0],
  ): Promise<Awaited<ReturnType<ModelProvider["completeChat"]>>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        return await provider.completeChat(req);
      } catch (err) {
        lastErr = err;
        if (req.signal?.aborted || isAbortError(err) || !isRetryableError(err) || attempt === 2) throw err;
        const wait = err instanceof ProviderError && err.retryAfterMs ? err.retryAfterMs : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  /** Provider for the cheap triage classification — prefer a local model so an
   *  ambiguous task isn't classified by the (possibly metered cloud) active
   *  provider (#248). Local providers need no key, and buildTriage already
   *  falls back to heuristic routing if the call fails. */
  private triageProvider(): ModelProvider {
    const localOverride = this.tierOverrides.get(1) ?? this.tierOverrides.get(2);
    if (localOverride) {
      return this.getProvider(localOverride.provider, localOverride.model, localOverride.baseUrl);
    }
    if (this.router) {
      try {
        const d = this.router.decisionForTier("tier1-local", "triage", false);
        return this.getProvider(d.provider, d.modelId);
      } catch {
        /* fall through to the active provider */
      }
    }
    return this.getProvider(this.config.provider, this.config.model);
  }

  /** A triage function that buckets a request by complexity.
   *
   * Short conversational messages are classified locally without calling any
   * model (saves a full round-trip).  Longer or code-heavy requests fall
   * through to a local-model triage call. */
  private buildTriage() {
    return async (request: string): Promise<TriageLabel | null> => {
      const words = request.trim().split(/\s+/).length;
      const lower = request.toLowerCase();

      // Fast-path: very short questions are almost always SIMPLE.
      const simplePatterns = /^(what|who|when|where|how|why|is|are|was|were|vad|vem|när|var|hur|varför)\b/i;
      if (words <= 8 && simplePatterns.test(lower) && !lower.includes("file") && !lower.includes("code")) {
        return "SIMPLE";
      }

      // Fast-path: greetings / single words.
      if (words <= 3) return "SIMPLE";

      try {
        const local = this.triageProvider();
        const res = await this.completeChatWithRetry(local, {
          messages: [
            {
              role: "system",
              content:
                "Classify the developer task's complexity. Reply with exactly one word: SIMPLE, MEDIUM, or COMPLEX.",
            },
            { role: "user", content: request },
          ],
        });
        const text = res.message.content.toUpperCase();
        if (text.includes("COMPLEX")) return "COMPLEX";
        if (text.includes("MEDIUM")) return "MEDIUM";
        if (text.includes("SIMPLE")) return "SIMPLE";
        return null;
      } catch {
        return null;
      }
    };
  }

  /** Run a single model response fully into a buffer (no streaming to the user). */
  /** History + transient per-turn context (@-mentions/RAG) for a model request.
   *  Every request path must use this — collectAttempt previously sent bare
   *  history, so quality-gated tier attempts never saw the turn context (#289). */
  private requestMessages(): AgentMessage[] {
    const messages = [...this.history];
    for (const block of this.turnContext) messages.push({ role: "system", content: block });
    return messages;
  }

  private async collectAttempt(
    provider: ModelProvider,
    toolDefs: unknown[],
    signal?: AbortSignal,
  ): Promise<BufferedAttempt> {
    const attempt: BufferedAttempt = { text: "", toolCalls: [], errored: false };
    this.enforceContextBudget(provider);
    try {
      for await (const event of provider.streamChatCompletion({
        messages: this.requestMessages(),
        tools: toolDefs,
        signal,
      })) {
        if (event.type === "text") attempt.text += event.text;
        else if (event.type === "tool-call") attempt.toolCalls.push(event.toolCall);
        else if (event.type === "usage") this.recordUsage(event.usage);
        else if (event.type === "error") {
          attempt.errored = true;
          attempt.errorMessage = event.message;
          break;
        } else if (event.type === "done") break;
      }
    } catch (err) {
      attempt.errored = true;
      attempt.errorMessage = errText(err);
    }
    return attempt;
  }

  /**
   * Stream one model response with resilience: retry transient failures
   * (429/5xx/network) with backoff on the same provider, then fall back to the
   * next provider in the chain. Retry/fallback only happens before any content
   * has been emitted for the current attempt — a partially-streamed turn is not
   * retried. A provider `error` event is treated as a thrown error. User aborts
   * stop cleanly without retry.
   */
  private async *streamResilient(
    providers: ModelProvider[],
    toolDefs: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent> {
    const maxRetries = 2;
    let lastErr: unknown;

    for (let p = 0; p < providers.length; p++) {
      const provider = providers[p];
      const moreProviders = p < providers.length - 1;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) return;
        let emitted = false;
        try {
          // Transient per-request context (turn @-mention/RAG blocks via
          // requestMessages, plus the iteration-cap notice) — never persisted
          // to history (#248, #260, #289).
          const messages = this.fitMessagesTo(provider, this.requestMessages());
          if (this.iterationCapNotice) messages.push({ role: "system", content: this.iterationCapNotice });
          for await (const ev of provider.streamChatCompletion({
            messages,
            tools: toolDefs,
            signal,
          })) {
            if (ev.type === "error") throw new ProviderError(ev.message);
            if (ev.type === "text" || ev.type === "tool-call") emitted = true;
            yield ev;
            if (ev.type === "done") return;
          }
          return; // stream ended without an explicit done
        } catch (err) {
          lastErr = err;
          if (isAbortError(err) || signal?.aborted) return; // user cancelled
          // Already streamed content this attempt → cannot safely retry.
          if (emitted) {
            logError(`provider:${provider.providerName}`, err); // mid-stream failure (#413)
            yield { type: "error", message: errText(err) };
            return;
          }
          const retryable = isRetryableError(err);
          if (retryable && attempt < maxRetries) {
            // Cap Retry-After: a hostile/buggy 429 header must not park the turn
            // for minutes; and TELL the user — an invisible retry looks like a
            // hang (#336).
            const waitMs = Math.min(
              err instanceof ProviderError && err.retryAfterMs ? err.retryAfterMs : backoffMs(attempt),
              15_000,
            );
            // A local model that hasn't answered yet is almost always LOADING,
            // not failing — say so, because "busy, retrying" reads like an error
            // and hides the real cause (a big model on a tight machine).
            const isLocalStall = /127\.0\.0\.1|localhost/.test(errText(err)) && /timed out/i.test(errText(err));
            yield {
              // A NOTICE, not model output (#404): emitting these as `text` made
              // agenticLoop accumulate them into assistantText, so a transient
              // 429 permanently prefixed the stored assistant turn with the
              // retry banner — replayed to the model on every later request.
              type: "notice",
              text: isLocalStall
                ? `\n[${provider.providerName} is still loading the model — this can take minutes the first time a large model is used. Waiting…]\n`
                : `\n[${provider.providerName} busy (${errText(err).slice(0, 80)}) — retrying in ${Math.ceil(waitMs / 1000)}s, attempt ${attempt + 2}/${maxRetries + 1}]\n`,
            };
            await sleep(waitMs, signal);
            continue; // retry same provider
          }
          // 401/402/403/404 are fatal for THIS provider (no point retrying it)
          // but the whole reason a fallback chain exists is that another tier may
          // work — a bad cloud key used to end the turn with local models idle (#384).
          if (moreProviders && (retryable || isProviderScopedError(err))) {
            yield {
              type: "notice", // agent status, not the model's words (#404)
              text: `\n[${provider.providerName} unavailable (${errText(err).slice(0, 120)}); falling back to ${providers[p + 1].providerName}]\n`,
            };
            break; // advance to next provider in the chain
          }
          // Fatal, or all retries/providers exhausted. Log HERE (#413): the
          // tail-of-function logError was unreachable because every failure
          // path returns, so provider outages never reached errors.log and
          // /diagnostics showed nothing after a failed turn.
          logError(`provider:${provider.providerName}`, err);
          yield { type: "error", message: errText(err) };
          return;
        }
      }
    }

    if (lastErr) logError("provider", lastErr);
    yield { type: "error", message: lastErr ? errText(lastErr) : "all providers failed" };
  }

  async *run(userInput: string, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    this.beginAttempt(""); // reset latency context; real tiers set it at recordRoute/plan-step time
    try {
      yield* this.runInner(userInput, signal);
    } finally {
      // Mark any active plan steps completed once the turn ends (#166).
      this.coordinator?.markAllSteps("completed");
      // Persist after every turn, including on cancel/abort (#140).
      this.saveSession();
      // User stop hooks (#346): the turn is over — fire-and-forget (e.g. a
      // notification sound); never delays or fails the turn itself.
      if (this.lifecycleHooks.stop?.length) {
        void runHooks(this.lifecycleHooks, "stop", this.projectRoot).catch(() => {});
      }
    }
  }

  /** Heuristic: is this request clearly multi-step and worth a decomposition plan? */
  private shouldPlan(input: string): boolean {
    const words = input.trim().split(/\s+/).length;
    if (words < 12) return false;
    if (/\b(and then|then|after that|first|second|next|step|also|finally)\b/i.test(input)) return true;
    return (input.match(/\band\b/gi)?.length ?? 0) >= 2;
  }

  private async *runInner(userInput: string, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: this.buildSystemPrompt() });
    } else if (this.systemPromptDirty && this.history[0]?.role === "system") {
      // The project changed since the prompt was built (edits/restore) — refresh
      // it so the model isn't navigating a stale tree (#302). The repo map itself
      // is rebuilt in the background after edits (#340); if that rebuild hasn't
      // landed yet this turn reuses the previous map (one turn stale) instead of
      // paying a repo walk before the first token.
      this.history[0] = { role: "system", content: this.buildSystemPrompt() };
      this.systemPromptDirty = false;
    }
    // Auto-compact: when the conversation nears the context window, summarize the
    // older turns (compactHistory) instead of letting enforceContextBudget silently
    // drop them mid-turn. Runs before this turn's user message is added (#273).
    const compactNote = await this.maybeAutoCompact();
    if (compactNote) yield { type: "text", text: `${compactNote}\n` };
    // @-file mentions and RAG are PER-TURN context: inject them into this turn's
    // request only (via this.turnContext, like the iteration-cap notice) instead
    // of pushing them into this.history, where they'd persist and accumulate a new
    // copy every turn — bloating context and the saved session (#260).
    const turnContext: string[] = [];
    const mentionBlock = mentionsContextBlock(userInput, this.projectRoot, this.workspaceRoots);
    if (mentionBlock) turnContext.push(mentionBlock);
    // RAG: if documents have been indexed, retrieve the most relevant chunks for
    // this turn (#200). No-ops cheaply when no index exists.
    const ragContext = await retrieveContext(this.projectRoot, userInput).catch(() => null);
    if (ragContext) turnContext.push(ragContext);
    this.turnContext = turnContext;

    // Attach any staged image(s) to this user turn for vision models (#177).
    const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
    this.pendingImages = [];
    this.history.push({ role: "user", content: userInput, images });
    this.turnCount++;
    this.editedThisTurn = false;
    this.verifyRetriesLeft = 2;
    this.checkpointedThisTurn = false;
    const toolDefs = this.toolDefs();

    if (!this.router) {
      yield* this.agenticLoop([this.getProvider(this.config.provider, this.config.model)], toolDefs, { signal });
      return;
    }

    // If the user has locked a specific tier, bypass triage and route directly.
    if (this._forcedTier !== null) {
      const tierKey =
        this._forcedTier === 1 ? "tier1-local"
        : this._forcedTier === 2 ? "tier2-medium"
        : "tier3-cloud";

      // Check if the user has also overridden the model for this tier.
      const override = this.tierOverrides.get(this._forcedTier);
      const decision: RouteDecision = override
        ? { tier: tierKey as import("@metalmind/core").TaskTier, modelId: override.model, provider: override.provider, reason: `forced tier ${this._forcedTier} (model override)` }
        : this.router.decisionForTier(tierKey, `forced tier ${this._forcedTier}`, false); // explicit choice → ignore budget

      this.recordRoute(decision);
      const provider = this.getProvider(decision.provider, decision.modelId);
      // Forced tier: respect the user's explicit choice — retry, but no auto-fallback.
      yield* this.agenticLoop([provider], toolDefs, { signal });
      return;
    }

    if (this.coordinator) {
      yield* this.runWithCoordinator(userInput, toolDefs, signal);
      return;
    }

    // Fallback: use ModelRouter directly (no coordinator).
    const historyTokens = this.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    let decision = await this.router.routeWithTriage(
      userInput,
      0,
      { conversationDepth: this.turnCount, historyTokens },
      this.buildTriage(),
    );
    this.recordRoute(decision);

    let provider = this.getProvider(decision.provider, decision.modelId);
    let attempt = await this.collectAttempt(provider, toolDefs, signal);
    let verdict = evaluateQuality({
      text: attempt.text,
      toolCalls: attempt.toolCalls,
      errored: attempt.errored,
    });

    let escalations = 0;
    while (!verdict.passed && decision.tier !== "tier3-cloud" && escalations < 3) {
      escalations++;
      const nextTier = this.router.escalateTier(decision.tier);
      const next = this.router.decisionForTier(nextTier, `escalated (${verdict.reason})`);
      // A session budget can downgrade the cloud target back to local; if escalation
      // can't actually move up a tier, stop instead of looping forever (#249).
      if (tierRank(next.tier) <= tierRank(decision.tier)) break;
      decision = next;
      this.recordRoute(decision);
      yield {
        type: "notice", // agent status, not model output (#404)
        text: `\n[escalating to ${decision.provider}/${decision.modelId} — ${verdict.reason}]\n`,
      };
      provider = this.getProvider(decision.provider, decision.modelId);
      attempt = await this.collectAttempt(provider, toolDefs, signal);
      verdict = evaluateQuality({
        text: attempt.text,
        toolCalls: attempt.toolCalls,
        errored: attempt.errored,
      });
    }

    if (attempt.errored) {
      yield { type: "error", message: attempt.errorMessage ?? "provider error" };
      yield { type: "done" };
      return;
    }

    yield* this.agenticLoop([provider], toolDefs, { primed: attempt, signal });
  }

  /** Run a turn through the multi-agent Coordinator.
   *
   * The coordinator's local worker runs intent classification only —
   * the result is routing metadata, never a user-facing response.
   * After classification the real work always goes to the appropriate tier.
   */
  private async *runWithCoordinator(userInput: string, toolDefs: unknown[], signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    // Esc must work during the PRE-STREAM phase too (#393): intent
    // classification and plan generation are model calls that can take many
    // seconds, and neither took a signal — Esc did nothing until the first token
    // of the real answer. Race each phase against the abort so the turn ends
    // promptly; the underlying request is abandoned rather than awaited.
    const untilAbort = <T>(p: Promise<T>, fallback: T): Promise<T> => {
      if (!signal) return p;
      if (signal.aborted) return Promise.resolve(fallback);
      return new Promise<T>((resolve) => {
        const onAbort = () => resolve(fallback);
        signal.addEventListener("abort", onAbort, { once: true });
        void p.then(
          (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
          () => { signal.removeEventListener("abort", onAbort); resolve(fallback); },
        );
      });
    };

    const historyTokens = this.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const { decision: coordDecision, localResult } = await untilAbort(
      this.coordinator!.processRequest(userInput, {
        inputTokenEstimate: historyTokens,
        input: { userMessage: userInput },
      }),
      { decision: null as never, localResult: undefined as never },
    );
    if (signal?.aborted) {
      yield { type: "done" };
      return;
    }

    this.onCoordinatorRouting?.(coordDecision);

    // Use the classification to pick a tier, but never return the raw
    // classification JSON as the user's answer — that's just routing metadata.
    let targetTierKey: "tier1-local" | "tier2-medium" | "tier3-cloud" = "tier3-cloud";
    if (localResult?.success) {
      const out = localResult.output as { suggestedTier?: string } | undefined;
      if (out?.suggestedTier === "local-worker") targetTierKey = "tier1-local";
      else if (out?.suggestedTier === "direct-tool") targetTierKey = "tier2-medium";
      // cloud-main → tier3-cloud (default)
    }
    // Remote-brain mode: the cloud model is always the brain/responder; bounded
    // subtasks are offloaded to the local model via the delegateToLocal tool (#186).
    if (this.remoteBrain) targetTierKey = "tier3-cloud";
    // If classification failed, log it silently and fall back to cloud.

    if (!this.router) {
      yield* this.agenticLoop([this.getProvider(this.config.provider, this.config.model)], toolDefs, { signal });
      return;
    }

    // Decompose clearly multi-step requests into a plan for the Plan UI (#166).
    // Reset any prior plan first; plan on a cheap local tier to avoid cloud cost.
    this.coordinator!.clearPlan();
    this.onCoordinatorPlan?.([]);
    if (this.shouldPlan(userInput)) {
      try {
        const pd = this.router.decisionForTier("tier2-medium", "planning");
        const plan = await untilAbort(
          this.coordinator!.buildPlan(userInput, this.getProvider(pd.provider, pd.modelId)),
          null,
        );
        if (signal?.aborted) {
          yield { type: "done" };
          return;
        }
        if (plan) {
          if (this.remoteBrain) {
            // Cloud is the brain: auto-run the local-worker steps on the small local
            // model first (real per-step status), then let the cloud reason over them (#205/#208).
            await this.executeLocalPlanSteps(signal);
          } else {
            this.coordinator!.markAllSteps("running"); // advisory plan (default path unchanged)
          }
        }
      } catch {
        // planning is best-effort — never block the turn on it
      }
    }

    // Quality gate + escalation on the coordinator path (#158): collect the
    // chosen tier's first response, evaluate it, and escalate UP to the next
    // tier if it's weak/empty/errored — instead of returning a poor tier-1
    // answer as-is. recordFailure feeds escalation thresholds + telemetry.
    // Capability floor (#422): the coordinator path picks a tier from the intent
    // classification and calls decisionForTier directly, bypassing the router's
    // capability filter. MetalMind always sends tool definitions, and a provider
    // that can't call tools (MLX) silently ignores them — the model then
    // "answers" without ever touching the codebase. Bump to a tier that can.
    if (toolDefs.length > 0 && !tierCanCallTools(this.router, targetTierKey)) {
      const upgraded: Array<"tier2-medium" | "tier3-cloud"> = ["tier2-medium", "tier3-cloud"];
      const better = upgraded.find((t) => t !== targetTierKey && tierCanCallTools(this.router!, t));
      if (better) targetTierKey = better;
    }
    let decision = this.router.decisionForTier(targetTierKey, `coordinator classified: ${targetTierKey}`);
    this.recordRoute(decision);
    let provider = this.getProvider(decision.provider, decision.modelId);

    // The top tier can't escalate up, so there's nothing to quality-gate against —
    // stream it directly (token-by-token) over the fallback chain instead of
    // buffering via collectAttempt (#211). This covers the cloud-brain and
    // remote-brain paths, which always resolve to tier3.
    if (decision.tier === "tier3-cloud") {
      const chain = this.buildFallbackChain(decision, "tier3-cloud");
      yield* this.agenticLoop(chain, toolDefs, { signal });
      return;
    }

    let attempt = await this.collectAttempt(provider, toolDefs, signal);
    // Esc during a gated attempt is a USER decision, not a model failure (#392).
    // Treating it as one recorded a bogus tier failure, escalated to a more
    // expensive model, and — once the budget cap pinned every tier to local —
    // spun this loop without ever passing the gate.
    if (signal?.aborted) {
      if (attempt.text) this.history.push({ role: "assistant", content: this.redactor.redact(attempt.text) });
      yield { type: "done" };
      return;
    }
    let verdict = evaluateQuality({ text: attempt.text, toolCalls: attempt.toolCalls, errored: attempt.errored });

    let escalations = 0;
    while (!verdict.passed && decision.tier !== "tier3-cloud") {
      const nextTier = this.router.escalateTier(decision.tier);
      // Guard against a non-advancing escalation (e.g. the budget cap maps every
      // tier back to local): without this the loop never terminates (#392).
      if (nextTier === decision.tier || ++escalations > 3) break;
      this.router.recordFailure(decision.tier);
      decision = this.router.decisionForTier(nextTier, `escalated (${verdict.reason})`);
      this.recordRoute(decision);
      yield { type: "notice", text: `\n[escalating to ${decision.provider}/${decision.modelId} — ${verdict.reason}]\n` };
      provider = this.getProvider(decision.provider, decision.modelId);
      attempt = await this.collectAttempt(provider, toolDefs, signal);
      if (signal?.aborted) {
        if (attempt.text) this.history.push({ role: "assistant", content: this.redactor.redact(attempt.text) });
        yield { type: "done" };
        return;
      }
      verdict = evaluateQuality({ text: attempt.text, toolCalls: attempt.toolCalls, errored: attempt.errored });
    }

    if (attempt.errored) {
      // Errored even at the top tier — descend the fallback chain (cloud→local)
      // so a rate-limit/quota error still completes the turn somewhere.
      this.router.recordFailure(decision.tier);
      const chain = this.buildFallbackChain(decision, decision.tier as "tier1-local" | "tier2-medium" | "tier3-cloud");
      yield* this.agenticLoop(chain, toolDefs, { signal });
      return;
    }

    yield* this.agenticLoop([provider], toolDefs, { primed: attempt, signal });
  }

  /** Ordered provider chain: chosen tier first, then descend to cheaper local tiers. */
  private buildFallbackChain(
    primary: RouteDecision | null,
    tierKey: "tier1-local" | "tier2-medium" | "tier3-cloud",
  ): ModelProvider[] {
    const chain: ModelProvider[] = [];
    const seen = new Set<string>();
    const add = (provider: string, model: string) => {
      const key = `${provider}/${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      chain.push(this.getProvider(provider, model));
    };

    if (primary) add(primary.provider, primary.modelId);
    else add(this.config.provider, this.config.model);

    if (this.router) {
      const descent: Array<"tier2-medium" | "tier1-local"> =
        tierKey === "tier3-cloud" ? ["tier2-medium", "tier1-local"]
        : tierKey === "tier2-medium" ? ["tier1-local"]
        : [];
      for (const t of descent) {
        try {
          const d = this.router.decisionForTier(t, "fallback");
          add(d.provider, d.modelId);
        } catch {
          // tier not configured — skip
        }
      }
    }
    return chain;
  }

  /**
   * Drive the agentic tool loop with a provider chain (primary + fallbacks).
   * An optional `primed` first response (already collected + gated) is emitted
   * before streaming resumes. A `signal` cancels the turn at each boundary.
   */
  private async *agenticLoop(
    providers: ModelProvider[],
    toolDefs: unknown[],
    opts: { primed?: BufferedAttempt; signal?: AbortSignal; maxIterations?: number } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const signal = opts.signal;
    let iterations = 0;
    const maxIterations = opts.maxIterations ?? 10;
    let pending = opts.primed;
    // No-progress detection (#419): a model that repeats the SAME failing call
    // (same tool, same arguments, same error) otherwise burns the entire
    // iteration budget — ten identical round-trips, real spend, no answer.
    let lastFailure: { signature: string; output: string; count: number } | null = null;
    let stuckOnRepeat = false;

    while (iterations < maxIterations) {
      if (signal?.aborted) { yield { type: "done" }; return; }
      iterations++;
      // Keep the payload within the active model's context window (#141).
      if (providers[0]) this.enforceContextBudget(providers[0]);
      let assistantText = "";
      const pendingToolCalls: Array<{ toolCallId: string; toolName: string; argumentsJson: string }> = [];

      if (pending) {
        assistantText = pending.text;
        pendingToolCalls.push(...pending.toolCalls);
        // Scrub secrets the model may have echoed before they reach the UI (#223).
        if (assistantText) yield { type: "text", text: this.redactor.redact(assistantText) };
        for (const tc of pendingToolCalls) {
          yield { type: "tool-call", toolCall: { toolCallId: tc.toolCallId, toolName: tc.toolName, argumentsJson: tc.argumentsJson } };
        }
        pending = undefined;
      } else {
        // Disclose the tool-use iteration cap as the model approaches it, so it
        // can wrap up instead of being cut off mid-plan with no warning (#248).
        const remaining = maxIterations - iterations;
        this.iterationCapNotice =
          remaining <= 0
            ? `This is your final tool-use iteration (cap ${maxIterations}). Give your best final answer now from what you have — no further tool calls will run.`
            : remaining === 1
              ? `You have 1 tool-use iteration left before the cap (${maxIterations}). Finish any remaining tool calls and prepare your final answer.`
              : null;
        // Time each model request from here so latency is per-request, not cumulative (#209).
        this.attemptStartMs = Date.now();
        let sawError = false;
        let truncated = false;
        // Redact across chunk boundaries: a secret split over multiple stream
        // chunks would slip past a per-chunk redact() (#168 stream fix).
        const streamRedactor = new StreamRedactor(this.redactor);
        for await (const event of this.streamResilient(providers, toolDefs, signal)) {
          if (event.type === "notice") {
            // Agent status — surface it, never accumulate it into the answer (#404).
            yield { type: "notice", text: event.text };
            continue;
          }
          if (event.type === "text") {
            assistantText += event.text;
            const safe = streamRedactor.push(event.text);
            if (safe) yield { type: "text", text: safe };
          } else if (event.type === "reasoning") {
            // Reasoning models (gpt-oss, …) stream a thinking trace before the
            // answer. Surface it live (redacted) so the turn isn't a blank pause,
            // but never accumulate it into the answer/history.
            yield { type: "reasoning", text: this.redactor.redact(event.text) };
          } else if (event.type === "tool-call") {
            pendingToolCalls.push(event.toolCall);
            yield {
              type: "tool-call",
              toolCall: { toolCallId: event.toolCall.toolCallId, toolName: event.toolCall.toolName, argumentsJson: event.toolCall.argumentsJson },
            };
          } else if (event.type === "usage") {
            this.recordUsage(event.usage);
          } else if (event.type === "finish") {
            // A "length" finish means the model was CUT OFF at its output cap —
            // previously indistinguishable from a complete answer (#366).
            truncated = event.reason === "length";
          } else if (event.type === "error") {
            yield { type: "error", message: event.message };
            sawError = true;
          } else if (event.type === "done") {
            break;
          }
        }
        // Flush any tail held back as a possible secret prefix (#168).
        const flushed = streamRedactor.flush();
        if (flushed) yield { type: "text", text: flushed };
        if (truncated) {
          yield {
            type: "notice", // agent status, not model output (#404)
            text: "\n\n[⚠ output truncated at the model's max output tokens — ask it to continue for the rest]\n",
          };
        }
        if (sawError) {
          // Commit what the model DID stream before the error (#441): the user
          // saw it, but history kept nothing — so /export, the resumed session
          // and the model's own next-turn view all lost it, and any tool calls
          // it had already emitted were left without their assistant message.
          if (assistantText.trim() || pendingToolCalls.length > 0) {
            this.history.push({
              role: "assistant",
              content: this.redactor.redact(assistantText),
              ...(pendingToolCalls.length > 0
                ? { toolCalls: pendingToolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, argumentsJson: c.argumentsJson })), metadata: { hasToolCalls: true } }
                : {}),
            });
            // A tool_call with no tool_result is invalid on the next request —
            // close each one out with an explicit failure note.
            for (const c of pendingToolCalls) {
              this.history.push({
                role: "tool",
                content: "Not executed — the provider stream failed before this tool ran.",
                metadata: { toolCallId: c.toolCallId },
              });
            }
          }
          yield { type: "done" };
          return;
        }
        // User cancelled mid-stream: persist partial output and end cleanly.
        if (signal?.aborted) {
          if (assistantText) this.history.push({ role: "assistant", content: this.redactor.redact(assistantText) });
          yield { type: "done" };
          return;
        }
      }

      if (pendingToolCalls.length === 0) {
        if (assistantText) this.history.push({ role: "assistant", content: this.redactor.redact(assistantText) });
        // End-of-turn verification (#282): if this turn edited files, run the
        // project check before finishing; on failure, feed the errors back and
        // let the model fix them (bounded retries so it can't loop).
        // Top-level turns only: a sub-agent shares these flags with its parent,
        // so running the check inside runSubagent consumed the parent's retries
        // and injected failure notes into the sub-agent's throwaway history.
        if (this.subagentDepth === 0 && this.editedThisTurn && this.verifyRetriesLeft > 0 && this.mode !== "plan") {
          yield { type: "notice", text: "\n[running project check…]\n" };
          const failure = await this.runProjectCheck(signal);
          if (failure) {
            this.verifyRetriesLeft--;
            this.history.push({
              role: "system",
              content: `The project check failed after your edits. Fix these errors, then summarize:\n${failure}`,
            });
            yield { type: "notice", text: `\n[project check failed — asking the model to fix]\n` };
            continue;
          }
        }
        yield { type: "done" };
        return;
      }

      // Redact the full accumulated text before persisting/replaying it (#223).
      this.history.push({ role: "assistant", content: this.redactor.redact(assistantText), toolCalls: pendingToolCalls });

      // Parallel fast-path: when every pending call is a side-effect-free read-only
      // tool (and not an MCP tool), run them concurrently instead of one-by-one (#206).
      // Mutating/approval-gated/MCP batches fall through to the ordered path below.
      if (
        pendingToolCalls.length > 1 &&
        pendingToolCalls.every((c) => READ_ONLY_PARALLEL_TOOLS.has(c.toolName) && !this.mcpTools.has(c.toolName))
      ) {
        // preTool hooks apply to batched calls too (#432): without this a user's
        // blocking hook was defeated simply by the model batching its reads.
        const batchBlocked = new Map<string, string>();
        if (this.lifecycleHooks.preTool?.length) {
          for (const c of pendingToolCalls) {
            const pre = await runHooks(this.lifecycleHooks, "preTool", this.projectRoot, {
              MM_TOOL_NAME: c.toolName,
              MM_TOOL_INPUT: c.argumentsJson.slice(0, 4000),
            }).catch(() => ({ blocked: undefined, notes: [] as string[] }));
            if (pre.blocked) batchBlocked.set(c.toolCallId, `Blocked by preTool hook: ${this.redactor.redact(pre.blocked)}`);
          }
        }
        const runnable = pendingToolCalls.filter((c) => !batchBlocked.has(c.toolCallId));
        const runnableOutputs = await this.runReadOnlyBatch(runnable);
        const outputByg = new Map<string, string>();
        runnable.forEach((c, i) => outputByg.set(c.toolCallId, runnableOutputs[i]));

        for (const call of pendingToolCalls) {
          const output = batchBlocked.get(call.toolCallId) ?? outputByg.get(call.toolCallId) ?? "Error: no result";
          yield { type: "tool-result", toolCallId: call.toolCallId, output };
          // Carry the read metadata the ordered path records (#426): without
          // filePath/readWindow the stale-read supersession never fired for
          // batched reads, so every re-read of a file kept a full extra copy of
          // it in history.
          const inputObj = this.safeParseArgs(call.argumentsJson);
          const readPath = call.toolName === "readFile" && typeof inputObj.path === "string" ? inputObj.path : undefined;
          const readWindow = readPath ? readWindowKey(inputObj) : undefined;
          if (readPath) {
            for (const m of this.history) {
              if (m.role !== "tool" || m.metadata?.filePath !== readPath) continue;
              if (String(m.content).startsWith("[stale read")) continue;
              const prevWindow = typeof m.metadata?.readWindow === "string" ? m.metadata.readWindow : "full";
              if (readWindow !== "full" && prevWindow !== readWindow) continue;
              m.content = `[stale read of ${readPath} superseded by a later read]`;
            }
          }
          this.history.push({
            role: "tool",
            content: output,
            metadata: { toolCallId: call.toolCallId, ...(readPath ? { filePath: readPath, readWindow } : {}) },
          });
          // No-progress detection must cover batched calls too (#444): the batch
          // path returns before the ordered path's tracker, so a model looping
          // on the same failing read burned the whole iteration budget.
          const bFailed = output.startsWith("Error") || output.startsWith("Blocked");
          const bSig = `${call.toolName}:${call.argumentsJson}`;
          if (bFailed) {
            if (lastFailure && lastFailure.signature === bSig && lastFailure.output === output) {
              lastFailure.count++;
              if (lastFailure.count >= 3) stuckOnRepeat = true;
            } else {
              lastFailure = { signature: bSig, output, count: 1 };
            }
          } else {
            lastFailure = null;
          }
          if (this.lifecycleHooks.postTool?.length && !batchBlocked.has(call.toolCallId)) {
            void runHooks(this.lifecycleHooks, "postTool", this.projectRoot, {
              MM_TOOL_NAME: call.toolName,
              MM_TOOL_INPUT: call.argumentsJson.slice(0, 4000),
              MM_TOOL_OUTPUT: output.slice(0, 4000),
            }).catch(() => {});
          }
        }
        if (!stuckOnRepeat) continue;
        // fall through to the shared stuck-handling below
      }

      for (const call of stuckOnRepeat ? [] : pendingToolCalls) {
        // Esc must stop the WHOLE batch: without this, aborting a long tool let
        // the remaining queued calls execute (and even pop approval prompts
        // after the user cancelled). Stub results keep call/result pairing valid.
        if (signal?.aborted) {
          const output = "Cancelled by user — tool not executed.";
          this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
          yield { type: "tool-result", toolCallId: call.toolCallId, output };
          continue;
        }

        const inputObj = this.safeParseArgs(call.argumentsJson);

        // Plan-mode guard (#11): refuse any mutating built-in tool even if the
        // model tries one. Mutating tools aren't advertised in plan mode, so this
        // is defense-in-depth — it keeps "plan" read-only no matter what.
        if (this.mode === "plan") {
          const tool = this.registry.list().find((t) => t.toolName === call.toolName);
          const mutating =
            tool?.requiresConfirmation ||
            MUTATING_FILE_TOOLS.has(call.toolName) ||
            DOCUMENT_WRITE_TOOLS.has(call.toolName) ||
            // Any MCP tool: the server decides what it does, so plan mode can't
            // assume it's read-only (#391).
            this.mcpTools.has(call.toolName) ||
            // `remember` writes MEMORY.md; `task` spawns an agent that can write.
            call.toolName === "remember" ||
            call.toolName === "task";
          if (mutating) {
            const output = `Plan mode: "${call.toolName}" was not executed (no changes made). Switch to /build to apply changes.`;
            this.auditLogRedacted({
              timestamp: new Date().toISOString(),
              toolName: call.toolName,
              input: inputObj,
              output,
              success: false,
              error: "plan mode",
            });
            this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
            yield { type: "tool-result", toolCallId: call.toolCallId, output };
            continue;
          }
        }

        // Safety gate: block dangerous shell commands and secret-path access
        // before any execution (#139).
        const violation = this.preflightSafety(call.toolName, inputObj);
        if (violation) {
          const output = `Blocked: ${violation.message}`;
          this.auditLogRedacted({
            timestamp: new Date().toISOString(),
            toolName: call.toolName,
            input: inputObj,
            output,
            success: false,
            error: violation.message,
          });
          this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
          yield { type: "tool-result", toolCallId: call.toolCallId, output };
          continue;
        }

        // Human-in-the-loop approval gate: pause before any side-effecting tool (#138).
        if (this.needsApproval(call.toolName, inputObj)) {
          const decision = await this.requestApproval(call.toolName, inputObj);
          if (decision === "reject") {
            const output = `Rejected by user — "${call.toolName}" was not executed.`;
            this.auditLogRedacted({
              timestamp: new Date().toISOString(),
              toolName: call.toolName,
              input: inputObj,
              output,
              success: false,
              error: "rejected by user",
            });
            this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
            yield { type: "tool-result", toolCallId: call.toolCallId, output };
            continue;
          }
        }

        // A mutation-capable tool is about to run — take the turn's git
        // checkpoint so /rollback can restore even shell/git-driven changes
        // (#297). Deliberately OUTSIDE the approval branch: allowlisted (/allow)
        // and skill-auto-approved calls skip the prompt but must still
        // checkpoint, otherwise the users who trusted the tool most lose the
        // safety net entirely.
        if (this.safetyValidator.requiresApproval(call.toolName) || this.mcpTools.has(call.toolName)) {
          this.gitCheckpoint();
        }

        // Snapshot affected files before any mutation so /undo can revert (#144).
        this.snapshotEdit(this.turnCount, call.toolName, inputObj);

        // Pre-compute the edit's unified diff (before the file changes) so the
        // transcript can render what the tool did, not just a summary line (#288).
        let resultDiff: string | undefined;
        let resultFile: string | undefined;
        if (MUTATING_FILE_TOOLS.has(call.toolName) || call.toolName === "multiEdit" || call.toolName === "replaceInProject") {
          try {
            const req = this.buildApprovalRequest(call.toolName, inputObj);
            // Diffs are raw file content — scrub secrets before they reach the UI.
            resultDiff = req.diff ? this.redactor.redact(req.diff) : undefined;
            resultFile = req.filePath;
          } catch {
            /* best-effort */
          }
        }

        // User preTool hooks (#346): a hook exiting with code 2 blocks the call.
        if (this.lifecycleHooks.preTool?.length) {
          const pre = await runHooks(this.lifecycleHooks, "preTool", this.projectRoot, {
            MM_TOOL_NAME: call.toolName,
            MM_TOOL_INPUT: call.argumentsJson.slice(0, 4000),
          }).catch(() => ({ blocked: undefined, notes: [] as string[] }));
          if (pre.blocked) {
            const output = `Blocked by preTool hook: ${this.redactor.redact(pre.blocked)}`;
            this.auditLogRedacted({
              timestamp: new Date().toISOString(),
              toolName: call.toolName,
              input: inputObj,
              output,
              success: false,
              error: "blocked by preTool hook",
            });
            this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
            yield { type: "tool-result", toolCallId: call.toolCallId, output };
            continue;
          }
        }

        let output: string;
        try {
          const mcpEntry = this.mcpTools.get(call.toolName);
          // MCP/shell tools can change files without going through changedPaths —
          // snapshot git status so we can detect and post-process their edits (#296).
          const preStatus = SHELL_COMMAND_TOOLS.has(call.toolName) || mcpEntry ? this.gitStatusSnapshot() : null;
          if (call.toolName === "delegateToLocal") {
            // Cloud brain offloads bounded subtasks to the local model (#187).
            output = await this.handleDelegateToLocal(inputObj, signal);
          } else if (call.toolName === "task") {
            // Spawn a focused sub-agent with its own bounded loop (#210).
            output = await this.handleTaskDelegation(inputObj, signal);
          } else if (call.toolName === "remember") {
            // Persist a durable fact to long-term memory (#218).
            output = this.rememberFact(typeof inputObj.fact === "string" ? inputObj.fact : "");
          } else if (call.toolName === "setTodos") {
            // Model-managed task list, mirrored to the UI (#276).
            output = this.handleSetTodos(inputObj);
          } else if (mcpEntry) {
            // Validate args against the server-advertised schema before calling,
            // the same protection built-in tools get from their zod schema (#240).
            const argErr = validateAgainstJsonSchema(inputObj, mcpEntry.def.inputSchema);
            if (argErr) {
              output = `Error: invalid arguments for "${call.toolName}": ${argErr}`;
            } else {
              // Call the server with the ORIGINAL (un-namespaced) tool name.
              output = await this.callMcpAudited(mcpEntry.client, mcpEntry.def.name, inputObj);
            }
          } else {
            // Stream long-running tool output live (redacted across chunk
            // boundaries) so e.g. a test run shows progress, not a silent spinner.
            const progressRedactor = new StreamRedactor(this.redactor);
            const result = await this.registry.execute(call.toolName, inputObj, {
              projectRoot: this.projectRoot,
              workspaceRoots: this.workspaceRoots,
              auditLog: this.auditLogRedacted, // record every built-in tool call (#147)
              signal, // Esc cancels long-running tools mid-flight (#284)
              onOutput: (chunk) => {
                const safe = progressRedactor.push(chunk);
                if (safe) this.onToolProgress?.(call.toolName, safe);
              },
            });
            output = typeof result === "string" ? result : JSON.stringify(result);
            // Post-edit feedback loop: re-index, optional format, append diagnostics.
            output = await this.postEditHook(call.toolName, inputObj, output);
          }
          // Post-process MCP/shell mutations through the same pipeline (#296).
          if (preStatus !== null && !output.startsWith("Error")) {
            output = await this.postMutationScan(preStatus, output);
          }
        } catch (err) {
          output = `Error: ${errText(err)}`;
        }

        // Scrub any secret values before the output reaches the model or UI (#168).
        output = this.redactor.redact(output);

        // Repeated identical FAILURE → tell the model plainly, then stop (#419).
        const failed = output.startsWith("Error") || output.startsWith("Blocked") || output.startsWith("Plan mode:");
        const signature = `${call.toolName}:${call.argumentsJson}`;
        if (failed) {
          if (lastFailure && lastFailure.signature === signature && lastFailure.output === output) {
            lastFailure.count++;
            output +=
              `\n\n[This is attempt ${lastFailure.count} of the SAME call with the SAME arguments and the SAME failure. ` +
              `Repeating it will not change the result — change the arguments, use a different tool, or answer from what you already have.]`;
            if (lastFailure.count >= 3) stuckOnRepeat = true;
          } else {
            lastFailure = { signature, output, count: 1 };
          }
        } else {
          lastFailure = null; // any success resets the streak
        }

        // User postTool hooks (#346) — observational, fire-and-forget.
        if (this.lifecycleHooks.postTool?.length) {
          void runHooks(this.lifecycleHooks, "postTool", this.projectRoot, {
            MM_TOOL_NAME: call.toolName,
            MM_TOOL_INPUT: call.argumentsJson.slice(0, 4000),
            MM_TOOL_OUTPUT: output.slice(0, 4000),
          }).catch(() => {});
        }

        yield {
          type: "tool-result",
          toolCallId: call.toolCallId,
          output,
          ...(resultDiff && !output.startsWith("Error") ? { diff: resultDiff, filePath: resultFile } : {}),
        };

        // Re-reads supersede stale copies: a second readFile of the same path
        // shrinks the earlier result to a stub (the message object stays in place
        // so tool_call/tool_result pairing remains valid) instead of keeping two
        // whole-file copies in history (#290).
        // Keyed on path AND window (#362): reading page 2 of a large file used to
        // blank page 1, because only the path was compared — paging through a
        // file destroyed everything already read. Only a read of the SAME window
        // (or a whole-file read, which subsumes every window) supersedes.
        const readPath = call.toolName === "readFile" && typeof inputObj.path === "string" ? inputObj.path : undefined;
        const readWindow = readPath ? readWindowKey(inputObj) : undefined;
        if (readPath) {
          for (const m of this.history) {
            if (m.role !== "tool" || m.metadata?.filePath !== readPath) continue;
            if (String(m.content).startsWith("[stale read")) continue;
            const prevWindow = typeof m.metadata?.readWindow === "string" ? m.metadata.readWindow : "full";
            // "full" supersedes anything; a windowed read supersedes only itself.
            if (readWindow !== "full" && prevWindow !== readWindow) continue;
            m.content = `[stale read of ${readPath} superseded by a later read]`;
          }
        }

        this.history.push({
          role: "tool",
          content: output,
          metadata: {
            toolCallId: call.toolCallId,
            ...(readPath ? { filePath: readPath, readWindow } : {}),
          },
        });
      }

      // Three identical consecutive failures: stop looping and let the model
      // answer from what it has, instead of spending the rest of the budget
      // on a call that cannot succeed (#419).
      if (stuckOnRepeat) {
        yield {
          type: "notice",
          text: "\n[stopping the tool loop — the same call failed identically 3 times]\n",
        };
        this.iterationCapNotice =
          "You repeated the same failing tool call three times. No further tool calls will run this turn. " +
          "Explain what you were unable to do and give your best answer from the information you already have.";
        // Accumulate the wrap-up answer and COMMIT it to history (#431): the
        // first version of this stop path streamed it to the UI only, so the
        // model's own final answer never entered this.history — the transcript
        // and the model's view diverged and the answer was missing from the
        // saved session, /export and the next turn's context.
        let finalText = "";
        for await (const ev of this.streamResilient(providers, [], signal)) {
          if (ev.type === "notice") { yield { type: "notice", text: ev.text }; continue; }
          if (ev.type === "text") {
            finalText += ev.text;
            const safe = this.redactor.redact(ev.text);
            if (safe) yield { type: "text", text: safe };
          } else if (ev.type === "error") {
            yield { type: "error", message: ev.message };
          } else if (ev.type === "done") break;
        }
        this.iterationCapNotice = null;
        if (finalText.trim()) {
          this.history.push({ role: "assistant", content: this.redactor.redact(finalText) });
        }
        yield { type: "done" };
        return;
      }
    }

    yield { type: "error", message: "Agent reached maximum iterations." };
    yield { type: "done" };
  }

  private safeParseArgs(json: string): Record<string, unknown> {
    try {
      const v = JSON.parse(json) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Execute a batch of read-only tool calls concurrently (bounded), preserving order (#206).
   *  Read-only tools need no approval, snapshot, or post-edit hook, so this is a safe parallelization. */
  private async runReadOnlyBatch(
    calls: Array<{ toolCallId: string; toolName: string; argumentsJson: string }>,
  ): Promise<string[]> {
    const run = async (call: { toolCallId: string; toolName: string; argumentsJson: string }): Promise<string> => {
      const inputObj = this.safeParseArgs(call.argumentsJson);
      const violation = this.preflightSafety(call.toolName, inputObj);
      if (violation) {
        const output = `Blocked: ${violation.message}`;
        this.auditLogRedacted({
          timestamp: new Date().toISOString(),
          toolName: call.toolName,
          input: inputObj,
          output,
          success: false,
          error: violation.message,
        });
        return this.redactor.redact(output);
      }
      let output: string;
      try {
        const result = await this.registry.execute(call.toolName, inputObj, {
          projectRoot: this.projectRoot,
          workspaceRoots: this.workspaceRoots,
          auditLog: this.auditLogRedacted,
        });
        output = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        output = `Error: ${errText(err)}`;
      }
      return this.redactor.redact(output);
    };
    return mapBounded(calls, 6, run);
  }

  /** Pre-execution safety check: dangerous shell commands, secret/traversal paths. */
  private preflightSafety(toolName: string, input: Record<string, unknown>): SafetyViolation | null {
    // All command-running tools route their (model-overridable) command through the
    // dangerous-command validator, not just runCommand/runBackground (#252).
    // EVERY string that ends up on the shell line is validated, not just
    // `command` (#358): runFormat interpolates `path` into the command, so a
    // path of `$(rm -rf ~)` used to reach sh without ever passing this gate —
    // the one check that approval cannot override.
    if (SHELL_COMMAND_TOOLS.has(toolName)) {
      for (const key of ["command", "path", "cwd"]) {
        const value = input[key];
        if (typeof value !== "string" || !value) continue;
        const violation =
          this.safetyValidator.validateShellCommand(value) ??
          this.safetyValidator.validateFilePath(value) ??
          // path/cwd are plain paths — no substitution or chaining allowed.
          (key === "command" ? null : this.safetyValidator.validateShellArgument(value));
        if (violation) return violation;
      }
      return null;
    }
    // multiEdit carries a batch of {path} edits rather than a single path.
    if (toolName === "multiEdit" && Array.isArray(input.edits)) {
      for (const e of input.edits as Array<{ path?: unknown }>) {
        if (typeof e?.path === "string") {
          const v = this.safetyValidator.validateFilePath(e.path);
          if (v) return v;
        }
      }
      return null;
    }
    if (this.safetyValidator.requiresApproval(toolName)) {
      const p =
        typeof input.path === "string" ? input.path
        : typeof input.source === "string" ? input.source
        : typeof input.destination === "string" ? input.destination
        : "";
      if (p) return this.safetyValidator.validateFilePath(p);
    }
    return null;
  }

  private resolveProjectPath(p: string): string {
    return isAbsolute(p) ? resolve(p) : resolve(join(this.projectRoot, p));
  }

  /** Tools that must be approved before running: mutating built-ins, git, shell, and any MCP tool (#138). */
  private needsApproval(toolName: string, input: Record<string, unknown> = {}): boolean {
    if (!(this.safetyValidator.requiresApproval(toolName) || this.mcpTools.has(toolName))) return false;
    // A persisted allowlist can pre-approve specific tools/paths/commands (#220).
    if (isAllowlisted(loadXdgConfig().approvalAllowlist, toolName, input)) return false;
    // metalmind.yaml permissions: category explicitly `true` → pre-approved (#347).
    if (yamlPreapproved(this.yamlPermissions, toolName)) return false;
    // An active skill that binds this tool with allowAutoExecute pre-approves it (#228).
    if (this.skillManager.getAutoExecuteTools().has(toolName)) return false;
    return true;
  }

  /** Resolve the approval decision: always-allowed / auto-approve short-circuit, else ask the UI. */
  private async requestApproval(toolName: string, input: Record<string, unknown>): Promise<ApprovalDecision> {
    // "Always allow" is scoped to the approved target (tool + path/command), not
    // the whole tool — approving one writeFile doesn't auto-approve any path (#241).
    const scope = this.approvalScopeKey(toolName, input);
    if (this.alwaysAllow.has(scope) || this.autoApprove) return "approve";
    if (!this.onApprovalRequest) return "approve"; // headless / no UI wired → no gate
    try {
      // Redact the prompt payload — diffs/summaries quote raw file content,
      // which can contain secrets the terminal must never display.
      const req = this.buildApprovalRequest(toolName, input);
      const decision = await this.onApprovalRequest({
        ...req,
        summary: this.redactor.redact(req.summary),
        // Tell the user EXACTLY what "always allow" will cover — the prompt used
        // to claim "for this target" even when the key was tool-wide (#377).
        scopeLabel: this.redactor.redact(scopeLabel(scope)),
        ...(req.diff ? { diff: this.redactor.redact(req.diff) } : {}),
        ...(req.command ? { command: this.redactor.redact(req.command) } : {}),
      });
      if (decision === "always") this.alwaysAllow.add(scope);
      return decision;
    } catch {
      return "reject"; // a failed/aborted prompt must not silently execute
    }
  }

  /** Key that scopes an "always allow" decision to the specific target (#241).
   *  Batch tools scope on their real targets too — previously multiEdit and
   *  replaceInProject fell through to a bare tool-wide key, so one [a] on a
   *  2-line edit silently pre-approved ARBITRARY multi-file rewrites. */
  private approvalScopeKey(toolName: string, input: Record<string, unknown>): string {
    if (typeof input.path === "string") return `${toolName}:${input.path}`;
    if (typeof input.destination === "string") return `${toolName}:${input.destination}`;
    if (typeof input.command === "string") return `${toolName}:${input.command}`;
    if (toolName === "multiEdit" && Array.isArray(input.edits)) {
      const paths = [...new Set((input.edits as Array<{ path?: unknown }>).map((e) => String(e?.path ?? "")))].sort();
      return `multiEdit:${paths.join(",")}`;
    }
    if (toolName === "replaceInProject" && typeof input.find === "string") {
      return `replaceInProject:${input.find}`;
    }
    // Plural-path tools (gitAdd's `paths`) must key on the actual set, not the
    // tool name — "always allow" on `gitAdd ["src/a.ts"]` used to silently cover
    // a later `gitAdd ["."]` (#377).
    if (Array.isArray(input.paths)) {
      return `${toolName}:${[...new Set((input.paths as unknown[]).map(String))].sort().join(",")}`;
    }
    // MCP tools carry server-specific arguments and no `path`/`command`, so they
    // all collapsed onto a bare tool name. Key on the argument payload so an
    // approval covers the call the user actually saw (#377).
    if (this.mcpTools.has(toolName)) {
      let args = "";
      try {
        args = JSON.stringify(input);
      } catch {
        args = String(Object.keys(input).sort().join(","));
      }
      return `${toolName}:${args.slice(0, 500)}`;
    }
    return toolName;
  }

  /** Build the approval payload (diff for writes, command for shell) for the UI. */
  private buildApprovalRequest(toolName: string, input: Record<string, unknown>): ApprovalRequest {
    const path = typeof input.path === "string" ? input.path : undefined;
    try {
      if ((toolName === "writeFile" || toolName === "createFile") && path) {
        const diff = DiffGenerator.previewWrite(path, this.projectRoot, String(input.content ?? "")).patch;
        return { toolName, kind: "write", summary: `Write ${path}`, diff, filePath: path };
      }
      if (toolName === "editFile" && path) {
        const diff = DiffGenerator.previewEdit(
          path,
          this.projectRoot,
          String(input.oldString ?? ""),
          String(input.newString ?? ""),
          Boolean(input.replaceAll),
        ).patch;
        return { toolName, kind: "write", summary: `Edit ${path}`, diff, filePath: path };
      }
      // Document/spreadsheet writers overwrite `path` wholesale (#376). Show a
      // real diff for text-ish formats; for binary ones say plainly that the
      // file will be replaced, and warn when the target already exists.
      if (DOCUMENT_WRITE_TOOLS.has(toolName) && path) {
        const abs = this.resolveProjectPath(path);
        const exists = existsSync(abs);
        const textual = /\.(md|markdown|html?|tex|csv|txt)$/i.test(path);
        const content = typeof input.content === "string" ? input.content : "";
        const diff = textual && content ? DiffGenerator.previewWrite(path, this.projectRoot, content).patch : undefined;
        return {
          toolName,
          kind: "write",
          summary: `${exists ? "OVERWRITE existing" : "Create"} ${path} via ${toolName}`,
          diff,
          filePath: path,
        };
      }
    } catch {
      // diff generation is best-effort; fall through to a summary
    }
    if (toolName === "deleteFile") return { toolName, kind: "write", summary: `Delete ${path ?? "(file)"}`, filePath: path };
    if (toolName === "moveFile") return { toolName, kind: "write", summary: `Move ${String(input.source)} → ${String(input.destination)}` };
    if (toolName === "multiEdit") {
      // Show the actual per-file diffs, not a blind count (#279).
      const edits = Array.isArray(input.edits) ? (input.edits as Array<{ path: string; oldString: string; newString: string; replaceAll?: boolean }>) : [];
      const files = [...new Set(edits.map((e) => e.path))];
      let diff: string | undefined;
      try {
        diff = DiffGenerator.previewMultiEdit(edits, this.projectRoot);
      } catch {
        /* best-effort */
      }
      return { toolName, kind: "write", summary: `Apply ${edits.length} edit(s) across ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? "…" : ""}`, diff };
    }
    if (toolName === "replaceInProject") {
      // Show which files match and preview the replacement diffs (#279).
      const matches = this.replaceMatchFiles(input);
      const find = String(input.find ?? "");
      const replace = String(input.replace ?? "");
      let diff: string | undefined;
      try {
        const parts: string[] = [];
        for (const p of matches.slice(0, 10)) {
          const abs = this.resolveProjectPath(p);
          const original = readFileSync(abs, "utf-8");
          const updated = input.isRegex === true ? original.replace(new RegExp(find, "g"), replace) : original.split(find).join(replace);
          if (updated !== original) {
            const patch = DiffGenerator.generatePatch(p, original, updated).split("\n");
            parts.push(patch.length > 40 ? patch.slice(0, 40).join("\n") + `\n…(+${patch.length - 40} more)` : patch.join("\n"));
          }
        }
        if (matches.length > 10) parts.push(`…(+${matches.length - 10} more files)`);
        diff = parts.join("\n") || undefined;
      } catch {
        /* best-effort */
      }
      return {
        toolName,
        kind: "write",
        summary: `Replace "${find}" → "${replace}" in ${matches.length} file(s)${matches.length ? `: ${matches.slice(0, 5).join(", ")}${matches.length > 5 ? "…" : ""}` : ""}`,
        diff,
      };
    }
    if (toolName === "runCommand" || toolName === "runBackground") {
      const command = String(input.command ?? "");
      return { toolName, kind: "shell", summary: `Run shell command`, command };
    }
    if (toolName.startsWith("git")) {
      return { toolName, kind: "git", summary: `${toolName} ${JSON.stringify(input)}`.slice(0, 200) };
    }
    if (this.mcpTools.has(toolName)) {
      return { toolName, kind: "mcp", summary: `MCP tool ${toolName}(${JSON.stringify(input).slice(0, 120)})` };
    }
    return { toolName, kind: "other", summary: `${toolName}(${JSON.stringify(input).slice(0, 120)})` };
  }

  /** Snapshot file contents before a mutating tool runs, grouped per turn (#144). */
  /** Files a replaceInProject would change — the same ripgrep match-set the tool uses (#226). */
  private replaceMatchFiles(input: Record<string, unknown>): string[] {
    const find = typeof input.find === "string" ? input.find : "";
    if (!find) return [];
    const args = ["--files-with-matches"];
    if (input.isRegex !== true) args.push("--fixed-strings");
    // Must mirror replaceInProject's match phase exactly (#420) — this drives
    // the approval preview and the /undo snapshot, so a narrower arg list would
    // under-report what the tool is about to change.
    args.push("--hidden", "--glob", "!**/node_modules/**", "--glob", "!**/.git/**");
    if (typeof input.include === "string") args.push("--glob", input.include);
    args.push("-e", find, ".");
    try {
      const rg = spawnSync("rg", args, { cwd: this.projectRoot, encoding: "utf-8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
      if (rg.status !== 0 && rg.status !== 1) return [];
      return (rg.stdout ?? "").split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
    } catch {
      return [];
    }
  }

  private snapshotEdit(turn: number, toolName: string, input: Record<string, unknown>): void {
    const targets: string[] = [];
    if ((MUTATING_FILE_TOOLS.has(toolName) || DOCUMENT_WRITE_TOOLS.has(toolName)) && typeof input.path === "string") {
      targets.push(input.path);
    } else if (toolName === "moveFile") {
      if (typeof input.source === "string") targets.push(input.source);
      if (typeof input.destination === "string") targets.push(input.destination);
    } else if (toolName === "multiEdit" && Array.isArray(input.edits)) {
      for (const e of input.edits as Array<{ path?: unknown }>) {
        if (typeof e?.path === "string") targets.push(e.path);
      }
    } else if (toolName === "replaceInProject") {
      // Compute the match-set before the edit (so `find` is still present) and
      // remember it for the post-edit hook, which runs after `find` is replaced (#226).
      const matches = this.replaceMatchFiles(input);
      targets.push(...matches);
      this.pendingReplaceTargets = matches;
    } else {
      return;
    }

    const files = targets.map((t) => {
      const abs = this.resolveProjectPath(t);
      let before: string | null = null;
      try {
        before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      } catch {
        before = null;
      }
      return { path: abs, before };
    });
    if (files.length === 0) return;

    // A fresh agent edit invalidates the redo history (#176).
    this.redoStack = [];
    const top = this.editStack[this.editStack.length - 1];
    if (top && top.turn === turn) top.files.push(...files);
    else this.editStack.push({ turn, files });
  }

  /**
   * Restore one edit set, capturing the current state as the inverse onto
   * `pushInverseTo` — so undo and redo are symmetric (#144, #176).
   */
  private restoreSet(set: EditSet, pushInverseTo: EditSet[]): string {
    // Earliest snapshot per path holds the target content for this direction.
    const earliest = new Map<string, string | null>();
    for (const f of set.files) if (!earliest.has(f.path)) earliest.set(f.path, f.before);
    // Post-edit hash per path, for the "did the user touch this since?" check (#382).
    // Take the LAST entry, not the first (#425): when the agent edited a file
    // twice in one turn, the first entry's hash describes the intermediate
    // state, so the check compared disk against a version that no longer
    // existed and undo refused to restore the file — reporting it as
    // "modified since the agent edited them" when the agent itself did it.
    const expected = new Map<string, string | null | undefined>();
    for (const f of set.files) if (f.afterHash !== undefined) expected.set(f.path, f.afterHash);

    const inverse: EditSet = { turn: set.turn, files: [] };
    const changed: string[] = [];
    const skipped: string[] = [];
    for (const [path, before] of earliest) {
      // Refuse to overwrite a file the user edited AFTER the agent did: undo is
      // a safety net for the AGENT's changes, not a way to lose your own (#382).
      const wanted = expected.get(path);
      if (wanted !== undefined && contentHash(path) !== wanted) {
        skipped.push(path);
        continue;
      }
      // Capture the current content as the inverse snapshot (for redo/undo back).
      let current: string | null = null;
      try {
        current = existsSync(path) ? readFileSync(path, "utf8") : null;
      } catch {
        current = null;
      }
      inverse.files.push({ path, before: current, afterHash: before === null ? null : undefined });

      try {
        if (before === null) {
          if (existsSync(path)) {
            rmSync(path);
            changed.push(`deleted ${path}`);
          }
        } else {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, before, "utf8");
          changed.push(`restored ${path}`);
        }
      } catch (err) {
        changed.push(`FAILED ${path}: ${errText(err)}`);
      }
    }
    // Only record an inverse for what we actually touched, so redo can't resurrect
    // a skipped path.
    if (inverse.files.length > 0) pushInverseTo.push(inverse);
    const lines = changed.map((r) => `  • ${r}`);
    if (skipped.length > 0) {
      lines.push(
        `  ⚠ skipped ${skipped.length} file(s) modified since the agent edited them (your changes were kept): ${skipped
          .map((p) => relative(this.projectRoot, p) || p)
          .join(", ")}`,
      );
    }
    return lines.join("\n");
  }

  /** Revert the most recent agent edit set; repeatable for multi-level undo (#144, #176). */
  undoLastEdit(): string {
    const set = this.editStack.pop();
    if (!set) return "Nothing to undo — no agent edits recorded this session.";
    const report = this.restoreSet(set, this.redoStack);
    return `Undid an edit set (${this.editStack.length} more undo level(s) available):\n${report}`;
  }

  /** Re-apply the most recently undone edit set (#176). */
  redoLastEdit(): string {
    const set = this.redoStack.pop();
    if (!set) return "Nothing to redo.";
    const report = this.restoreSet(set, this.editStack);
    return `Redid an edit set:\n${report}`;
  }

  /** Invoke an MCP tool, recording the call in the audit log (#147). */
  private async callMcpAudited(
    client: McpToolClient,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const timestamp = new Date().toISOString();
    let output = "";
    let success = true;
    let error: string | undefined;
    // A stdio server that died mid-session kept its tools advertised, and every
    // call sat out the 30s request timeout before failing. Check liveness first
    // and retire the dead server's tools so the model stops calling them (#378).
    if (client.isHealthy && !client.isHealthy()) {
      const dropped = this.retireMcpClient(client);
      error = `MCP server for "${toolName}" is not running (it exited earlier). Removed ${dropped} tool(s) from this session; run "/mcp reconnect" to bring it back.`;
      output = `Error: ${error}`;
      this.auditLogRedacted({ timestamp, toolName, input, output, success: false, error });
      this.reportPersistenceIssue(error);
      return output;
    }
    try {
      output = await client.callTool(toolName, input);
      return output;
    } catch (err) {
      success = false;
      error = errText(err);
      output = `Error: ${error}`;
      return output;
    } finally {
      this.auditLogRedacted({ timestamp, toolName, input, output, success, error });
    }
  }

  /** Remove every tool advertised by a dead MCP client; returns how many (#378). */
  private retireMcpClient(client: McpToolClient): number {
    let n = 0;
    for (const [name, entry] of [...this.mcpTools]) {
      if (entry.client === client) {
        this.mcpTools.delete(name);
        n++;
      }
    }
    if (n > 0) this.systemPromptDirty = true; // the advertised tool list changed
    return n;
  }

  /** Recent tool-call audit entries for the in-session /audit view (#147). */
  getAuditEntries(limit = 30): ToolAuditEntry[] {
    return this.auditLog.getRecent(limit);
  }

  /** (Re)build the secret redactor from current config api keys + MCP headers (#168). */
  private rebuildRedactor(): void {
    const xdg = loadXdgConfig();
    // Include env-resolved keys for EVERY known provider, not just the active one —
    // a routed/escalated cloud provider's env-only key must still be scrubbed if it
    // surfaces in an error, tool output, or the audit log (#261).
    const providerKeys = ["anthropic", "openai", "ollama", "ollama-cloud", "mlx"].map(
      (p) => providerCredentials(p).apiKey,
    );
    this.redactor = new Redactor(
      collectSecrets(xdg.apiKeys, [this.config.apiKey, ...providerKeys], xdg.mcpServers, xdg.mcpTokens),
    );
  }

  /** Recursively scrub secret values from a tool input/output structure (#238). */
  private redactValue(v: unknown): unknown {
    if (typeof v === "string") return this.redactor.redact(v);
    if (Array.isArray(v)) return v.map((x) => this.redactValue(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = this.redactValue(val);
      return out;
    }
    return v;
  }

  /** Accumulate real provider token usage; feed the router's budget tracker (#157, #182)
   *  and the per-tier latency tracker (#209). */
  private recordUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    if (usage.inputTokens) this.sessionUsage.inputTokens += usage.inputTokens;
    if (usage.outputTokens) this.sessionUsage.outputTokens += usage.outputTokens;
    this.onUsage?.({ ...this.sessionUsage });
    // Per-attempt latency: measured from the current attempt's start and attributed
    // to that attempt's tier, so escalation/fallback/plan-step work isn't mis-counted (#209).
    const latencyMs = this.attemptStartMs > 0 ? Date.now() - this.attemptStartMs : 0;
    this.recordLatency(this.attemptTier, latencyMs);
    // Attribute spend to the active provider/model so budget routing can react (#182).
    this.router?.recordUsage({
      provider: this.lastRoute.provider || this.config.provider,
      model: this.lastRoute.model || this.config.model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: 0, // router computes from its rate table
      latencyMs,
      timestamp: new Date().toISOString(),
      success: true,
    });
  }

  /** Start timing a new model attempt for tier `tier` (#209). */
  private beginAttempt(tier: string): void {
    this.attemptTier = tier;
    this.attemptStartMs = Date.now();
  }

  /** Feed a per-tier latency sample (#209). */
  private recordLatency(tier: string, ms: number): void {
    if (!tier || ms < 0) return;
    let tracker = this.latencyByTier.get(tier);
    if (!tracker) {
      tracker = new LatencyTracker();
      this.latencyByTier.set(tier, tracker);
    }
    tracker.record(ms);
  }

  /** Per-tier latency stats (avg/p95 in ms) for /routes (#209). */
  getLatencyStats(): Array<{ tier: string; avgMs: number; p95Ms: number; samples: number }> {
    return [...this.latencyByTier.entries()].map(([tier, t]) => ({
      tier,
      avgMs: Math.round(t.getAverage()),
      p95Ms: Math.round(t.getP95()),
      samples: t.getCount(),
    }));
  }

  /** Session spend vs the configured budget, for /budget (#182). */
  getBudgetStatus(): { spentUsd: number; budgetUsd?: number; overBudget: boolean } | null {
    return this.router?.budgetStatus() ?? null;
  }

  /** Set the session spend cap at runtime and persist it (#182). */
  setBudget(budgetUsd: number | undefined): void {
    this.router?.setBudget(budgetUsd);
    const xdg = loadXdgConfig();
    saveXdgConfig({ ...xdg, budgetUsd });
  }

  /** Session token usage totals, for the /cost summary (#157). */
  getSessionUsage(): { inputTokens: number; outputTokens: number } {
    return { ...this.sessionUsage };
  }

  /**
   * Run a cached local-worker task (e.g. summarizeFile / extractSymbols) via the
   * coordinator's content-hash result cache (#181). Returns null if no
   * coordinator/worker is configured.
   */
  async runWorkerTask(
    taskType: string,
    input: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: unknown; error?: string; modelUsed?: string } | null> {
    if (!this.coordinator) return null;
    return this.coordinator.runCachedTask(taskType as Parameters<Coordinator["runCachedTask"]>[0], input);
  }

  /**
   * Cloud brain → local model: run a batch of bounded subtasks on the small local
   * model in parallel, hitting the content-hash cache on repeats (#187). Invoked
   * when the cloud model calls the delegateToLocal tool in remote-brain mode.
   */
  private async handleDelegateToLocal(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.coordinator) return "Delegation unavailable: no local worker is configured.";
    const taskType = typeof input.taskType === "string" ? input.taskType : "";
    const inputs = Array.isArray(input.inputs) ? input.inputs : [];
    if (!taskType || inputs.length === 0) {
      return 'delegateToLocal requires { taskType: string, inputs: object[] }.';
    }
    // The worker schemas require `fileContent`, but asking the MODEL for it is
    // absurd — it would have to paste whole files through the tool call. Read it
    // here from the given filePath (#428). Without this every delegated
    // summarizeFile/extractSymbols/extractImports failed schema validation.
    const NEEDS_CONTENT = new Set(["summarizeFile", "extractSymbols", "extractImports"]);
    const tasks = inputs.slice(0, 16).map((inp, i) => {
      const input = (inp && typeof inp === "object" ? { ...(inp as Record<string, unknown>) } : { value: inp }) as Record<string, unknown>;
      if (NEEDS_CONTENT.has(taskType) && typeof input.filePath === "string" && typeof input.fileContent !== "string") {
        try {
          // Route through the SAME validator every other read uses (#433).
          // resolveProjectPath is pure path math: reading through it gave the
          // model an unrestricted read primitive reaching exactly the files the
          // product promises are blocked (.ssh/.aws/.env), and the worker's
          // summary then lands in history and ships to the cloud provider.
          const abs = new PathValidator(this.projectRoot, this.workspaceRoots).resolveSafePath(input.filePath);
          // Don't pull a multi-GB file into memory just to slice 30k off it.
          const st = statSync(abs);
          if (!st.isFile()) throw new Error("not a regular file");
          if (st.size > 2 * 1024 * 1024) throw new Error(`file too large (${Math.round(st.size / 1024)}KB) for delegation`);
          // Schemas cap content at 30k chars; stay under it.
          input.fileContent = readFileSync(abs, "utf8").slice(0, 30_000);
        } catch (err) {
          input.fileContent = "";
          input.__readError = errText(err);
        }
      }
      return { taskId: `delegate-${i}`, taskType, input };
    });
    // A file we could not read can never satisfy the schema — report it instead
    // of letting it fail as an opaque validation error.
    const unreadable = tasks.filter((t) => typeof t.input.__readError === "string");
    for (const t of tasks) delete t.input.__readError;
    // Esc must cancel a long local batch (#365).
    const results = await this.coordinator.runParallelTasks(tasks as never, 4, signal);
    const lines = results.map(
      (r, i) => `[${i}] ${r?.success ? JSON.stringify(r.output) : `FAILED: ${r?.error ?? "unknown error"}`}`,
    );
    const cancelledCount = results.filter((r) => r?.error === "cancelled").length;
    const readNote = unreadable.length
      ? `\n⚠ ${unreadable.length} input(s) named a file that could not be read: ${unreadable.map((t) => String(t.input.filePath)).slice(0, 5).join(", ")}.`
      : "";
    const header = cancelledCount
      ? `Delegation CANCELLED — ${tasks.length - cancelledCount} of ${tasks.length} "${taskType}" task(s) completed:`
      : `Delegated ${tasks.length} "${taskType}" task(s) to the local model:`;
    return `${header}\n${lines.join("\n")}${readNote}`.slice(0, 8000);
  }

  /**
   * Run a focused sub-agent for a self-contained objective (#210). The sub-agent
   * gets a fresh, isolated history and its own short tool loop; its tool calls go
   * through the same safety/approval gates. It cannot spawn further sub-agents.
   * Returns the sub-agent's final text as the tool result for the parent turn.
   */
  private async handleTaskDelegation(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (!objective) return "task requires an { objective } string.";
    if (this.subagentDepth >= 1) return "Sub-agents cannot spawn further sub-agents.";
    try {
      // Route the sub-agent like any other model call (#361). It used to hard-code
      // this.config.provider/model, so /tier, per-tier model overrides and the
      // budget downgrade silently didn't apply to delegated work, and its spend
      // was attributed to whatever tier the parent happened to be on.
      const decision = this.subagentRoute(objective);
      const provider = decision
        ? this.getProvider(decision.provider, decision.modelId)
        : this.getProvider(this.config.provider, this.config.model);
      if (decision) this.beginAttempt(decision.tier);
      const { text, errors } = await this.runSubagent(objective, provider, signal);
      // A failed sub-agent must NOT look like a successful one (#364): surface
      // the error to the parent model instead of returning empty/partial text.
      if (errors.length > 0) {
        const detail = errors.join("; ").slice(0, 1000);
        return text
          ? `Sub-agent FAILED (${detail}). Partial output before the failure:\n${text}`.slice(0, 8000)
          : `Sub-agent FAILED: ${detail}`;
      }
      return text ? `Sub-agent result:\n${text}`.slice(0, 8000) : "(sub-agent produced no output)";
    } catch (err) {
      return `Sub-agent failed: ${errText(err)}`;
    }
  }

  /** Tier decision for delegated sub-agent work: honors a forced tier and its
   *  model override, otherwise asks the router (which applies the budget) (#361). */
  private subagentRoute(objective: string): RouteDecision | null {
    if (!this.router) return null;
    if (this._forcedTier !== null) {
      const tierKey =
        this._forcedTier === 1 ? "tier1-local"
        : this._forcedTier === 2 ? "tier2-medium"
        : "tier3-cloud";
      const override = this.tierOverrides.get(this._forcedTier);
      if (override) {
        return {
          tier: tierKey as import("@metalmind/core").TaskTier,
          modelId: override.model,
          provider: override.provider,
          reason: `forced tier ${this._forcedTier} (sub-agent, model override)`,
        };
      }
      return this.router.decisionForTier(tierKey, `forced tier ${this._forcedTier} (sub-agent)`, false);
    }
    try {
      return this.router.route(objective, 0, { conversationDepth: 0, historyTokens: 0 });
    } catch {
      return null; // never block delegation on a routing hiccup
    }
  }

  /**
   * Run a focused sub-agent on `provider` for `objective` with an isolated history
   * and a short tool loop, returning its final text. Used by the `task` tool (#210)
   * and by auto-executed local-worker plan steps (#208).
   */
  private async runSubagent(
    objective: string,
    provider: ModelProvider,
    signal?: AbortSignal,
  ): Promise<{ text: string; errors: string[] }> {
    if (this.subagentDepth >= 1) return { text: "", errors: ["nested sub-agents are not allowed"] };
    const savedHistory = this.history;
    const savedTurn = this.turnCount;
    // Don't leak the parent turn's @-mention/RAG context into the sub-agent — it
    // grounds itself on its own objective (#260).
    const savedTurnContext = this.turnContext;
    this.turnContext = [];
    this.subagentDepth++;
    this.history = [
      {
        role: "system",
        content:
          "You are a focused sub-agent. Accomplish the objective below using the available tools, then reply " +
          "with a concise result for the calling agent. Do not ask questions — make reasonable assumptions.\n\n" +
          `Objective:\n${objective}`,
      },
      { role: "user", content: objective },
    ];
    // Ground the sub-agent in retrieved documents too, keyed on its objective (#229).
    const ragContext = await retrieveContext(this.projectRoot, objective).catch(() => null);
    if (ragContext) this.history.splice(1, 0, { role: "system", content: ragContext });
    try {
      let finalText = "";
      // The loop reports failures as `error` events rather than throwing; dropping
      // them made a dead sub-agent indistinguishable from a silent one (#364).
      const errors: string[] = [];
      for await (const ev of this.agenticLoop([provider], this.toolDefs(), { signal, maxIterations: 6 })) {
        // Notices are agent status; folding them in made the parent model read
        // "[mlx unavailable; falling back…]" as the sub-agent's findings (#404).
        if (ev.type === "text") finalText += ev.text;
        else if (ev.type === "error") errors.push(ev.message);
      }
      return { text: finalText.trim(), errors };
    } finally {
      this.history = savedHistory;
      this.turnCount = savedTurn;
      this.turnContext = savedTurnContext;
      this.subagentDepth--;
    }
  }

  /**
   * Auto-execute the plan's local-worker steps on the small local model before the
   * cloud brain responds (#205/#208). Drives real per-step status via runPlan and
   * injects the findings into context. Only used in remote-brain mode.
   */
  private async executeLocalPlanSteps(signal?: AbortSignal): Promise<void> {
    if (!this.coordinator || !this.router) return;
    const localDecision = this.router.decisionForTier("tier2-medium", "plan local-worker step", false);
    const localProvider = this.getProvider(localDecision.provider, localDecision.modelId);
    const notes: string[] = [];
    await this.coordinator.runPlan(
      (step) => step.type === "local-worker",
      async (step) => {
        this.beginAttempt("tier2-medium"); // local-worker steps run on the local tier (#209)
        const res = await this.runSubagent(step.description, localProvider, signal).catch((err) => ({
          text: "",
          errors: [errText(err)],
        }));
        const out = res.errors.length === 0 ? res.text : "";
        if (out) notes.push(`- ${step.description}: ${out}`);
        return { success: out.length > 0 };
      },
    );
    if (notes.length > 0) {
      this.history.push({
        role: "system",
        content: `Pre-computed by local sub-agents (use these results):\n${notes.join("\n")}`,
      });
    }
  }

  /** Pre-flight health check for the active provider/model (#174). */
  async checkHealth(): Promise<{ ok: boolean; message: string }> {
    const problems: string[] = [];
    try {
      const provider = this.getProvider(this.config.provider, this.config.model);
      if (provider.health) {
        const h = await provider.health();
        if (!h.ok) problems.push(h.message);
      }
    } catch (err) {
      problems.push(errText(err));
    }
    // Report EVERY unusable configured tier, not just the active provider.
    // A configured-but-missing local model made requests fall silently through
    // to the cloud with the warning naming only MLX — the user had no way to
    // know why "local" work was being billed to a cloud tier.
    problems.push(...(await this.unusableTiers()));
    return problems.length === 0
      ? { ok: true, message: "" }
      : { ok: false, message: problems.join("  |  ") };
  }

  /** Configured tiers that cannot actually serve a request right now. */
  private async unusableTiers(): Promise<string[]> {
    if (!this.router) return [];
    const out: string[] = [];
    const tiers: Array<["tier1-local" | "tier2-medium" | "tier3-cloud", string]> = [
      ["tier1-local", "tier 1"],
      ["tier2-medium", "tier 2"],
    ];
    for (const [tier, label] of tiers) {
      let d: RouteDecision;
      try {
        d = this.router.decisionForTier(tier, "health probe", false);
      } catch {
        continue;
      }
      // Only local tiers are cheap to probe; the cloud tier is covered by the
      // provider health check above.
      if (d.provider === "ollama") {
        try {
          const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) });
          if (!res.ok) continue;
          const installed = ((await res.json()) as { models?: Array<{ name: string }> }).models ?? [];
          const bare = d.modelId.split(":")[0];
          if (!installed.some((m) => m.name === d.modelId || m.name.split(":")[0] === bare)) {
            out.push(
              `${label}: "${d.modelId}" is not installed (ollama pull ${d.modelId}) — requests skip this tier`,
            );
          }
        } catch {
          out.push(`${label}: local ollama not reachable — requests skip this tier`);
        }
      } else if (d.provider === "mlx") {
        try {
          const res = await fetch("http://127.0.0.1:8742/health", { signal: AbortSignal.timeout(1500) });
          if (!res.ok) throw new Error("unhealthy");
        } catch {
          out.push(`${label}: MLX sidecar not running — requests skip this tier`);
        }
      }
    }
    return out;
  }

  /** Record a routing decision (accumulated, not overwritten) and notify the UI (#165). */
  private recordRoute(decision: RouteDecision): void {
    // Honor a per-tier model override (setTierModel) even on auto-routed turns,
    // not just when the tier is forced (#235). Mutates the decision so the caller
    // builds the provider from the override.
    const tierNum = decision.tier === "tier1-local" ? 1 : decision.tier === "tier2-medium" ? 2 : 3;
    const override = this.tierOverrides.get(tierNum as 1 | 2 | 3);
    if (override) {
      decision.provider = override.provider;
      decision.modelId = override.model;
    }
    this.lastRoute = { provider: decision.provider, model: decision.modelId };
    // Reset the latency clock for this attempt and attribute to its tier (#209).
    this.beginAttempt(decision.tier);
    this.routingLog.push({
      tier: decision.tier,
      provider: decision.provider,
      model: decision.modelId,
      reason: decision.reason,
      at: new Date().toISOString(),
    });
    this.onRoute?.(decision);
  }

  /** Routing history + per-tier hit counts, for /routes (#165). */
  getRoutingSummary(limit = 20): string {
    if (this.routingLog.length === 0) return "No routing decisions yet this session.";
    const counts = new Map<string, number>();
    for (const r of this.routingLog) counts.set(r.tier, (counts.get(r.tier) ?? 0) + 1);
    const tally = [...counts.entries()].map(([tier, n]) => `  ${tier}: ${n}`).join("\n");
    const recent = this.routingLog
      .slice(-limit)
      .map((r) => `  ${r.at.slice(11, 19)}  ${r.tier} → ${r.provider}/${r.model}  (${r.reason})`)
      .join("\n");
    const latency = this.getLatencyStats();
    const latencyBlock = latency.length
      ? `\n\nLatency per tier (avg / p95):\n${latency
          .map((l) => `  ${l.tier}: ${l.avgMs}ms / ${l.p95Ms}ms  (${l.samples} sample${l.samples === 1 ? "" : "s"})`)
          .join("\n")}`
      : "";
    return `Routing hit counts (this session):\n${tally}\n\nRecent decisions:\n${recent}${latencyBlock}`;
  }

  /** Window history to fit the active model's context limit, reporting usage (#141). */
  /** Trim a per-request COPY of the messages to fit `provider`'s window (#405).
   *
   *  enforceContextBudget only ever ran against providers[0], so when the chain
   *  descended (e.g. openai 256k -> MLX 32k) the fallback was handed a payload
   *  sized for the first provider and rejected it — failing exactly when the
   *  fallback mattered. This trims per attempt and does NOT mutate this.history,
   *  so borrowing a small local tier for one attempt can't permanently shrink
   *  the conversation. */
  private fitMessagesTo(provider: ModelProvider, messages: AgentMessage[]): AgentMessage[] {
    const limit = provider.supportedCapabilities?.maximumContextTokens ?? 32_768;
    const budget = limit - Math.max(2048, Math.floor(limit * 0.2));
    const IMAGE_TOKEN_ESTIMATE = 1_100;
    const tokensOf = (m: AgentMessage): number =>
      estimateTokens(m.content) +
      (m.toolCalls?.length ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) +
      (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;

    let total = messages.reduce((sum, m) => sum + tokensOf(m), 0);
    if (total <= budget) return messages;

    const sys = messages[0]?.role === "system" ? [messages[0]] : [];
    let rest = messages.slice(sys.length);
    total = sys.reduce((sum, m) => sum + tokensOf(m), 0) + rest.reduce((sum, m) => sum + tokensOf(m), 0);
    while (total > budget && rest.length > 1) {
      total -= tokensOf(rest[0]);
      rest = rest.slice(1);
    }
    // Never lead with an orphaned tool result — providers reject a tool message
    // without its preceding assistant tool_calls. Keep at least one message so
    // the request never degenerates to a bare system prompt (#421).
    while (rest.length > 1 && rest[0].role === "tool") {
      total -= tokensOf(rest[0]);
      rest = rest.slice(1);
    }
    if (rest.length === 1 && tokensOf(rest[0]) > budget) {
      rest = [truncateMessageToFit(rest[0], budget)];
    }
    if (rest.length === 1 && rest[0].role === "tool") {
      rest = [{ role: "user", content: `[previous tool result, trimmed to fit the context window]\n${rest[0].content}` }];
    }
    return [...sys, ...rest];
  }

  private enforceContextBudget(provider: ModelProvider): void {
    const limit = provider.supportedCapabilities?.maximumContextTokens ?? 32_768;
    const reserve = Math.max(2048, Math.floor(limit * 0.2));
    const budget = limit - reserve;
    // Vision images cost real context tokens (a model tiles each image into
    // ~hundreds–~1k+ tokens); count them so image-heavy turns are trimmed/flagged
    // instead of silently blowing past the window (#268).
    const IMAGE_TOKEN_ESTIMATE = 1_100;
    const tokensOf = (m: AgentMessage): number =>
      estimateTokens(m.content) +
      (m.toolCalls?.length ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) +
      (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;

    // Per-turn @-mention/RAG blocks are appended to EVERY request by
    // requestMessages(), so they consume the window exactly like history does.
    // They used to be invisible here: uncounted, never trimmed, and missing from
    // the context meter — a few @-mentioned files could push a turn past the
    // limit while the gauge still read "fine" (#363).
    let turnContextTokens = this.turnContext.reduce((s, b) => s + estimateTokens(b), 0);
    const TURN_CONTEXT_CAP = Math.max(1024, Math.floor(budget * 0.35));
    if (turnContextTokens > TURN_CONTEXT_CAP) {
      // Trim the largest blocks first so one huge @-mention can't crowd out the
      // conversation; each keeps a head slice plus an explicit truncation note.
      const order = this.turnContext
        .map((b, i) => ({ i, t: estimateTokens(b) }))
        .sort((a, b) => b.t - a.t);
      for (const { i } of order) {
        if (turnContextTokens <= TURN_CONTEXT_CAP) break;
        const block = this.turnContext[i];
        const excessTokens = turnContextTokens - TURN_CONTEXT_CAP;
        const keepChars = Math.max(400, block.length - excessTokens * 4);
        if (keepChars >= block.length) continue;
        this.turnContext[i] = `${block.slice(0, keepChars)}\n…(turn context truncated to fit the context window)`;
        turnContextTokens -= estimateTokens(block) - estimateTokens(this.turnContext[i]);
      }
    }

    let total = this.history.reduce((s, m) => s + tokensOf(m), 0) + turnContextTokens;
    if (total > budget) {
      const sys = this.history[0]?.role === "system" ? [this.history[0]] : [];
      let rest = this.history.slice(sys.length);
      // Drop oldest non-system messages until under budget (keep the latest turn).
      while (total > budget && rest.length > 1) {
        total -= tokensOf(rest[0]);
        rest = rest.slice(1);
      }
      // Never leave an orphaned tool result at the front — providers reject a
      // tool message without its preceding assistant tool_calls. Stop before
      // emptying the list: deleting the LAST remaining message wiped the whole
      // conversation, user request included (#421).
      while (rest.length > 1 && rest[0].role === "tool") {
        total -= tokensOf(rest[0]);
        rest = rest.slice(1);
      }
      // A single message still over budget is TRUNCATED, never dropped, so the
      // turn keeps its user request and the model can still answer.
      if (rest.length === 1 && tokensOf(rest[0]) > budget) {
        rest = [truncateMessageToFit(rest[0], budget)];
        total = sys.reduce((s2, m) => s2 + tokensOf(m), 0) + tokensOf(rest[0]);
      }
      // A lone leading tool message has no matching assistant tool_calls after
      // trimming; relabel it so the provider accepts the request.
      if (rest.length === 1 && rest[0].role === "tool") {
        rest = [{ role: "user", content: `[previous tool result, trimmed to fit the context window]\n${rest[0].content}` }];
      }
      this.history = [...sys, ...rest];
    }
    this.onContextUsage?.(total, limit);
  }

  /** Build a token-bounded repository map (tree + exports/symbols) for the prompt (#143). */
  private loadRepoMap(): string | null {
    // Memoized: repo walks with symbol extraction are expensive; the cache is
    // invalidated when systemPromptDirty triggers a prompt rebuild (#302).
    if (this.repoMapCache !== undefined) return this.repoMapCache;
    this.repoMapCache = this.buildRepoMap();
    return this.repoMapCache;
  }

  /** Rebuild the repo map OFF the turn's critical path (#340). Edits mark the
   *  prompt dirty; rebuilding (repo walk + symbol extraction) at the start of
   *  the next turn added visible first-token latency. Rebuild shortly after the
   *  mutation instead, then re-mark the prompt dirty so the freshly cached map
   *  is picked up by the next prompt rebuild at memo-hit cost. */
  private scheduleRepoMapRebuild(): void {
    if (this.repoMapRebuildQueued) return;
    this.repoMapRebuildQueued = true;
    const t = setTimeout(() => {
      this.repoMapRebuildQueued = false;
      this.repoMapCache = this.buildRepoMap();
      this.systemPromptDirty = true;
    }, 50);
    t.unref?.();
  }

  private buildRepoMap(): string | null {
    try {
      const map = new RepoMapV2(this.projectRoot, {
        maxFiles: 120,
        maxDepth: 4,
        includeSymbols: true,
        includeImports: false,
        // Share the symbol tools' index so generating the map also populates it (#149).
        referenceIndex: getReferenceIndex(),
      });
      const tree = map.toTreeString();
      if (!tree.trim()) return null;
      const MAX_CHARS = 6000; // ~1.5k tokens — bounded so it never dominates the window
      return tree.length > MAX_CHARS ? `${tree.slice(0, MAX_CHARS)}\n…(map truncated)` : tree;
    } catch {
      return null; // never block a turn on map generation
    }
  }

  /** Bounded startup crawl that populates the shared symbol/reference index (#149).
   *  Chunked (#341): parsing hundreds of files in one microtask blocked the event
   *  loop — frozen first paint and dropped keystrokes for seconds on big repos.
   *  Parse a small batch per macrotask so the TUI stays responsive while the
   *  index warms up; timers are unref'd so indexing never holds the process open. */
  private indexProjectInBackground(): void {
    const files: string[] = [];
    try {
      this.collectSourceFiles(this.projectRoot, files);
    } catch {
      return; // never let indexing crash the agent
    }
    const BATCH = 20;
    let i = 0;
    const step = () => {
      const end = Math.min(i + BATCH, files.length);
      for (; i < end; i++) {
        try {
          indexFile(files[i]);
        } catch {
          // skip unparseable file
        }
      }
      if (i < files.length) setTimeout(step, 10).unref?.();
    };
    setTimeout(step, 0).unref?.();
  }

  private collectSourceFiles(dir: string, acc: string[]): void {
    if (acc.length >= INDEX_MAX_FILES) return;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (acc.length >= INDEX_MAX_FILES) return;
      if (entry.isDirectory()) {
        if (INDEX_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        this.collectSourceFiles(join(dir, entry.name), acc);
      } else if (INDEXABLE_EXTS.has(extname(entry.name))) {
        acc.push(join(dir, entry.name));
      }
    }
  }

  /** Files a tool mutated, for re-indexing / format-on-write / diagnostics. */
  private changedPaths(toolName: string, input: Record<string, unknown>): string[] {
    if ((MUTATING_FILE_TOOLS.has(toolName) || DOCUMENT_WRITE_TOOLS.has(toolName)) && typeof input.path === "string") return [input.path];
    if (toolName === "moveFile" && typeof input.destination === "string") return [input.destination];
    if (toolName === "multiEdit" && Array.isArray(input.edits)) {
      return [...new Set((input.edits as Array<{ path?: unknown }>).filter((e) => typeof e?.path === "string").map((e) => e.path as string))];
    }
    if (toolName === "replaceInProject") {
      // Reuse the match-set captured by snapshotEdit (the `find` string is gone post-edit) (#226).
      const t = this.pendingReplaceTargets;
      this.pendingReplaceTargets = [];
      return t;
    }
    return [];
  }

  /**
   * After a successful file mutation: keep the symbol index fresh (#149),
   * optionally format the file (#162), and append type/lint diagnostics to the
   * tool result so the model gets a feedback loop without an explicit build (#152).
   */
  private async postEditHook(toolName: string, input: Record<string, unknown>, output: string): Promise<string> {
    if (output.startsWith("Error") || output.startsWith("Blocked")) return output;
    const paths = this.changedPaths(toolName, input);
    if (paths.length === 0) return output;
    // The tree/symbols changed — rebuild the system prompt (repo map) next turn (#302),
    // and verify the project before this turn ends (#282).
    this.systemPromptDirty = true;
    this.scheduleRepoMapRebuild();
    this.editedThisTurn = true;

    const editorCfg = loadXdgConfig().editor;
    for (const p of paths) {
      const abs = this.resolveProjectPath(p);
      // Format-on-write (#162), opt-in via config.
      if (editorCfg?.formatOnWrite) {
        // Async: execSync froze the whole TUI for up to 20s per file (#333).
        const cmd = `${editorCfg.formatCommand || "npx prettier --write"} ${JSON.stringify(abs)}`;
        await runShellAsync(cmd, this.projectRoot, 20_000).catch(() => {
          /* formatter missing/failed — leave the file as written */
        });
      }
      // Re-index the (possibly formatted) file so lookups reflect the change (#149).
      try {
        indexFile(abs);
      } catch {
        // ignore
      }
    }

    // Remember what the agent LEFT each file looking like — AFTER formatting, so
    // the recorded state matches what's on disk. /undo compares against this to
    // detect a later hand-edit instead of silently overwriting it (#382).
    const currentSet = this.editStack[this.editStack.length - 1];
    if (currentSet) {
      for (const p of paths) {
        const abs = this.resolveProjectPath(p);
        for (const entry of currentSet.files) {
          if (entry.path === abs && entry.afterHash === undefined) entry.afterHash = contentHash(abs);
        }
      }
    }

    // Surface diagnostics for the first changed file (#152), bounded + best-effort.
    const diag = await this.diagnosticsFor(paths[0]);
    return diag ? `${output}\n\n[diagnostics: ${paths[0]}]\n${diag}` : output;
  }

  /** Run the diagnostics tool for one file, time-bounded so it never hangs the loop (#152). */
  private async diagnosticsFor(relPath: string): Promise<string | null> {
    try {
      const result = await Promise.race([
        this.registry.execute("getDiagnostics", { filePath: relPath }, {
          projectRoot: this.projectRoot,
          workspaceRoots: this.workspaceRoots,
        }),
        new Promise<null>((res) => setTimeout(() => res(null), 6000)),
      ]);
      if (result == null) return null;
      const text = typeof result === "string" ? result : JSON.stringify(result);
      if (/no diagnostics/i.test(text)) return null; // suppress boilerplate
      return text.length > 2000 ? `${text.slice(0, 2000)}\n…(truncated)` : text;
    } catch {
      return null;
    }
  }

  /** Global user instructions at ~/.config/metalmind/instructions.md (#348):
   *  per-user standing guidance that follows the user across projects. */
  private loadGlobalInstructions(): string | null {
    const abs = join(XDG_CONFIG_DIR, "instructions.md");
    try {
      if (existsSync(abs)) {
        let c = readFileSync(abs, "utf8");
        if (c.length > 8000) c = c.slice(0, 8000) + "\n…(truncated)";
        return c.trim() || null;
      }
    } catch {
      // unreadable — skip silently
    }
    return null;
  }

  /** Load the project memory/rules file (AGENTS.md/CLAUDE.md/…) if present (#146). */
  private loadProjectMemory(): { name: string; content: string } | null {
    for (const rel of PROJECT_MEMORY_FILES) {
      const abs = join(this.projectRoot, rel);
      try {
        if (existsSync(abs)) {
          let content = readFileSync(abs, "utf8");
          const MAX = 16_000;
          if (content.length > MAX) content = content.slice(0, MAX) + "\n…(truncated)";
          if (content.trim()) return { name: rel, content: content.trim() };
        }
      } catch {
        // unreadable — skip silently
      }
    }
    return null;
  }

  /** Always-loaded long-term learned memory at .metalmind/MEMORY.md (#218). */
  private loadLearnedMemory(): string | null {
    const abs = join(this.projectRoot, ".metalmind", "MEMORY.md");
    try {
      if (existsSync(abs)) {
        let c = readFileSync(abs, "utf8");
        if (c.length > 8000) c = c.slice(0, 8000) + "\n…(truncated)";
        return c.trim() || null;
      }
    } catch {
      // unreadable — skip
    }
    return null;
  }

  /** Append a durable fact to .metalmind/MEMORY.md so it persists into later sessions (#218). */
  rememberFact(text: string): string {
    const fact = text.trim();
    if (!fact) return "Nothing to remember (empty note).";
    const dir = join(this.projectRoot, ".metalmind");
    const file = join(dir, "MEMORY.md");
    try {
      mkdirSync(dir, { recursive: true });
      let content = existsSync(file) ? readFileSync(file, "utf8") : "# Project memory\n";
      if (!content.includes("## Learned facts")) {
        content = content.replace(/\s*$/, "") + "\n\n## Learned facts\n";
      }
      const stamp = new Date().toISOString().slice(0, 10);
      // Insert by index, never via a replacement string (#381): String.replace
      // treats $&, $', $` and $1 in the REPLACEMENT specially, so a fact
      // containing them injected the matched text (or the whole preceding file)
      // into MEMORY.md and corrupted it.
      const heading = "## Learned facts\n";
      const at = content.indexOf(heading);
      const entry = `- [${stamp}] ${fact.replace(/\r?\n/g, " ")}\n`;
      content =
        at === -1
          ? `${content.replace(/\s*$/, "")}\n\n${heading}${entry}`
          : content.slice(0, at + heading.length) + entry + content.slice(at + heading.length);
      writeFileSync(file, content, "utf8");
      return `Remembered: "${fact}" → .metalmind/MEMORY.md (loads in future sessions).`;
    } catch (err) {
      return `Couldn't save memory: ${errText(err)}`;
    }
  }

  /** Generate a starter project-memory doc from a lightweight repo scan (#146 /init). */
  initProjectDoc(): string {
    const target = join(this.projectRoot, ".metalmind", "MEMORY.md");
    if (existsSync(target)) return `Project memory already exists at ${target} — edit it directly.`;

    let pkgName = "";
    let scripts: string[] = [];
    try {
      const pkgPath = join(this.projectRoot, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        pkgName = pkg.name ?? "";
        scripts = Object.keys(pkg.scripts ?? {});
      }
    } catch {
      // no/invalid package.json — skip
    }

    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.projectRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => d.name)
        .sort();
    } catch {
      // unreadable root — skip
    }

    const doc = [
      `# Project memory${pkgName ? `: ${pkgName}` : ""}`,
      "",
      "> Auto-generated by /init. Edit to capture architecture, conventions, and rules the agent should always follow. Loaded into the system prompt at session start.",
      "",
      "## Structure",
      ...(dirs.length ? dirs.map((d) => `- \`${d}/\``) : ["- (none)"]),
      ...(scripts.length ? ["", "## Scripts", ...scripts.map((s) => `- \`npm run ${s}\``)] : []),
      "",
      "## Conventions",
      "- (add project-specific rules here)",
      "",
    ].join("\n");

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, doc, "utf8");
    return `Created starter project memory at ${target}.\nRun /clear (or restart) to load it into context.`;
  }

  private buildSystemPrompt(): string {
    const userConfig = loadXdgConfig();
    const mcpEntries = Object.entries(userConfig.mcpServers || {});
    const mcpList = mcpEntries.length
      ? mcpEntries.map(([id, s]) => {
          const transport = s.url ? `URL: ${s.url}` : `command: ${s.command ?? ""} ${(s.args || []).join(" ")}`.trimEnd();
          const tools = [...this.mcpTools.entries()].filter(([, v]) => v.client).length;
          return `  - ${id} (${transport})`;
        }).join("\n")
      : "  (none configured)";
    const builtInNames = this.registry.list().map((t) => t.toolName).join(", ");
    const mcpToolNames = [...this.mcpTools.keys()].join(", ");
    const toolNames = [builtInNames, mcpToolNames].filter(Boolean).join(", ");

    const workspaceList = this.workspaceRoots.length
      ? this.workspaceRoots.map((p) => `  - ${p}`).join("\n")
      : "  (none configured — project directory is always accessible)";

    const lines = [
      "You are MetalMind, an agentic AI assistant running in a terminal UI (TUI).",
      `Project directory: ${this.projectRoot}`,
      `Active provider: ${this.config.provider}  Active model: ${this.config.model}`,
      "",
      `Additional workspace paths:\n${workspaceList}`,
      "",
      this.mode === "plan"
        ? `Configured MCP servers (tools withheld in plan mode):\n${mcpList}`
        : `Configured MCP servers:\n${mcpList}`,
      "",
      `Available tools: ${toolNames}`,
      "",
      this.mode === "plan"
        ? "PLAN MODE: investigate the request using read-only tools (read/list/find/search/symbols/web) and produce a concrete, ordered, step-by-step plan for the user to review. You CANNOT modify files, run shell commands, commit, call MCP server tools, delegate to a sub-agent, or write to memory — those tools are unavailable and will be refused. Do not claim you made changes; end with the plan and tell the user to run /build to execute it."
        : "You are a fully agentic assistant. You can read files, write and edit files, run shell commands (gh, git, npm, etc.), and use git. Use your tools proactively to complete tasks — do not just suggest code, implement it.",
      "You have access to the entire filesystem. Sensitive paths (.ssh, .aws, .env, credentials) are blocked automatically.",
      "When the user mentions a directory path, you can read files from it directly without any setup.",
      "When asked about MetalMind configuration, read ~/.config/metalmind/config.json with your file tools.",
    ];

    // Global per-user standing instructions (#348) — apply in every project;
    // injected before the project block so project instructions win on conflict.
    const globalInstr = this.loadGlobalInstructions();
    if (globalInstr) {
      lines.push(
        "",
        "--- User instructions (from ~/.config/metalmind/instructions.md) — apply across all projects; project instructions take precedence on conflict ---",
        globalInstr,
        "--- end user instructions ---",
      );
    }

    // Inject project-specific standing instructions (AGENTS.md/CLAUDE.md/…) if present (#146).
    const memory = this.loadProjectMemory();
    if (memory) {
      lines.push(
        "",
        `--- Project instructions (from ${memory.name}) — follow these unless the user overrides them ---`,
        memory.content,
        "--- end project instructions ---",
      );
    }

    // Inject long-term learned memory unless it was already loaded as the project doc (#218).
    if (memory?.name !== ".metalmind/MEMORY.md") {
      const learned = this.loadLearnedMemory();
      if (learned) {
        lines.push(
          "",
          "--- Long-term memory (facts you previously chose to remember) ---",
          learned,
          "--- end long-term memory ---",
        );
      }
    }

    // Inject a token-bounded repository map so the model has structural context
    // without blind grep/glob round-trips (#143).
    const repoMap = this.loadRepoMap();
    if (repoMap) {
      lines.push(
        "",
        "--- Repository map (auto-generated: tree with exports/symbols, truncated) ---",
        repoMap,
        "--- end repository map ---",
      );
    }

    // Inject the prompts of any active skills (#156).
    const skillPrompt = this.skillManager.buildSystemPrompt();
    if (skillPrompt) {
      lines.push("", "--- Active skills ---", skillPrompt, "--- end active skills ---");
    }

    return lines.join("\n");
  }

  clearHistory(): void {
    this.history = [];
    this.turnCount = 0;
    // Per-conversation state must not leak into the fresh session: stale todos
    // kept the Tasks panel showing the OLD session's list after /clear, and a
    // leftover turnContext/cap-notice would ride into the first new request.
    this.todos = [];
    this.onTodos?.([]);
    this.turnContext = [];
    this.iterationCapNotice = null;
    this.editedThisTurn = false;
    this.pendingImages = []; // a staged image must not ride into the new session (#375)
    // The restore stacks are keyed by TURN NUMBER, which just restarted at 0.
    // Keeping them meant `/rollback 1` resolved to the PREVIOUS conversation's
    // snapshot (first match wins) and `/undo` merged new edits into the old
    // conversation's edit set — both silently destroying work (#374).
    this.resetRestoreState();
  }

  /** Drop turn-keyed checkpoint/undo state. Must run whenever turnCount is
   *  reset or recomputed, or the turn labels collide across conversations (#374). */
  private resetRestoreState(): void {
    this.turnCheckpoints = [];
    this.editStack = [];
    this.redoStack = [];
    this.checkpointedThisTurn = false;
  }

  /**
   * Open the SQLite session store and create or resume a session (#140).
   * Graceful: if the native store can't load, persistence is disabled silently.
   * Returns the restored non-system messages (for the UI to display).
   */
  async initPersistence(opts: { continue?: boolean; resumeId?: string } = {}): Promise<AgentMessage[]> {
    try {
      // Lazy import: if the native better-sqlite3 addon is unavailable, this
      // throws here and persistence is disabled — the TUI still runs, but the
      // user is TOLD (silent loss of a day's history is the worst failure) (#332).
      const { SqliteSessionStore } = await import("@metalmind/memory");
      const store = new SqliteSessionStore(join(this.projectRoot, ".metalmind", "sessions.db"));
      this.sessionStore = store;
      if (store.recoveredFromCorruption) {
        this.reportPersistenceIssue(`sessions.db was corrupt — quarantined to ${store.recoveredFromCorruption}; starting a fresh store.`);
      }
    } catch (err) {
      this.sessionStore = null;
      this.reportPersistenceIssue(`Session persistence DISABLED: ${errText(err)} (try: npm rebuild better-sqlite3). Conversations will NOT survive restart.`);
      return [];
    }
    try {
      if (opts.resumeId) {
        // Validate before adopting: a phantom id would silently break every
        // subsequent save (FK constraint) while looking like a fresh session (#332).
        const known = this.sessionStore.getSession?.(opts.resumeId) ?? this.sessionStore.listSessions().find((s) => s.id === opts.resumeId);
        if (!known) {
          this.reportPersistenceIssue(`--resume ${opts.resumeId}: no such session — started a new one instead.`);
          this.sessionId = this.sessionStore.createSession();
        } else if (this.sessionStore.activeOwner?.(opts.resumeId)) {
          // A live instance owns it — adopting would make both processes
          // overwrite each other's turns (#388). Fork instead of colliding.
          const owner = this.sessionStore.activeOwner(opts.resumeId);
          const forked = this.sessionStore.createSession(`fork of ${opts.resumeId}`);
          this.history = this.sessionStore.loadMessages(opts.resumeId);
          this.sessionId = forked;
          this.reportPersistenceIssue(
            `Session ${opts.resumeId} is open in another MetalMind instance (pid ${owner}) — continuing here as a copy (${forked}) so neither history is overwritten.`,
          );
        } else {
          this.sessionId = opts.resumeId;
          // Don't clobber an already-adopted in-memory history (#368): after a
          // model switch the handed-over history is at least as fresh as the
          // store's copy, and reloading here would drop an unsaved tail.
          if (this.history.length === 0) {
            this.history = this.sessionStore.loadMessages(opts.resumeId);
          }
        }
      } else if (opts.continue) {
        // --continue picks the most recently updated session, which is exactly
        // the one a concurrently running instance keeps bumping. Skip sessions
        // owned by a live process rather than colliding with them (#388).
        const recent = this.sessionStore.listSessions().find((s) => !this.sessionStore?.activeOwner?.(s.id));
        if (recent) {
          this.sessionId = recent.id;
          this.history = this.sessionStore.loadMessages(recent.id);
        } else {
          this.sessionId = this.sessionStore.createSession();
        }
      } else {
        this.sessionId = this.sessionStore.createSession();
      }
      // Claim whatever we settled on so our saves are revision-checked (#388).
      if (this.sessionId) this.sessionStore.claimSession?.(this.sessionId);
    } catch {
      try {
        this.sessionId = this.sessionStore.createSession();
      } catch {
        this.sessionStore = null;
      }
    }
    if (this.history.length > 0) {
      this.turnCount = this.history.filter((m) => m.role === "user").length;
      // A resumed session's system prompt (and repo map) may predate on-disk
      // changes — rebuild it on the first turn (#302).
      this.systemPromptDirty = true;
      this.scheduleRepoMapRebuild();
    }
    return this.displayMessages();
  }

  /** User/assistant turns with content, for restoring the chat view on resume. */
  private displayMessages(): AgentMessage[] {
    return this.history.filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0,
    );
  }

  /** Public view of the conversation for the UI after edit/retry/branch (#204). */
  conversation(): AgentMessage[] {
    return this.displayMessages();
  }

  /**
   * Carry session state across an agent REPLACEMENT (#368). A model/provider
   * switch builds a brand-new AgentLoop; without this the conversation, plan
   * mode, forced tier, staged images and task list were silently discarded while
   * the UI kept rendering them — the next message started from nothing.
   *
   * Returns the session id to resume, so the caller can pass it to
   * initPersistence and keep writing to the SAME persisted session.
   */
  adoptStateFrom(previous: AgentLoop): string | undefined {
    this.history = previous.history.map((m) => ({ ...m }));
    this.turnCount = previous.turnCount;
    this.mode = previous.mode;
    this._forcedTier = previous._forcedTier;
    this.tierOverrides = new Map(previous.tierOverrides);
    this.remoteBrain = previous.remoteBrain;
    this.pendingImages = [...previous.pendingImages];
    this.todos = previous.todos.map((t) => ({ ...t }));
    this.sessionUsage = { ...previous.sessionUsage };
    this.editStack = [...previous.editStack];
    this.redoStack = [...previous.redoStack];
    this.turnCheckpoints = [...previous.turnCheckpoints];
    // The prompt was built by the previous instance (possibly for a different
    // model/tier); rebuild it, and re-publish the task list to the new UI hook.
    if (this.history[0]?.role === "system") {
      this.history[0] = { role: "system", content: this.buildSystemPrompt() };
    }
    this.systemPromptDirty = true;
    if (this.todos.length) this.onTodos?.(this.todos);
    return previous.sessionId ?? undefined;
  }

  /**
   * Drop the last user turn and everything after it (assistant reply + tool
   * messages), returning the user input so the caller can re-run it (#204).
   * Used by /retry (re-run as-is) and /edit (re-run with new text).
   */
  popLastExchange(): string | null {
    let userIdx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx === -1) return null;
    const text = this.history[userIdx].content;
    // Re-stage the popped turn's attachments so /retry and /edit send the SAME
    // images again. They used to be dropped silently: a vision turn re-run
    // without its image made the model answer about nothing (#375).
    const images = this.history[userIdx].images;
    if (images?.length) this.pendingImages = [...images];
    this.history = this.history.slice(0, userIdx);
    this.turnCount = Math.max(0, this.turnCount - 1);
    return text;
  }

  /** Fork the current conversation into a new persisted session (#204). Returns the new id or null. */
  branchSession(): string | null {
    if (!this.sessionStore) return null;
    try {
      const id = this.sessionStore.createSession("branch");
      this.sessionStore.claimSession?.(id); // own it before writing (#388)
      this.sessionStore.saveMessages(id, this.history);
      this.sessionId = id;
      return id;
    } catch {
      return null;
    }
  }

  /** Persist the current history to the active session (#140). */
  private saveSession(): void {
    if (!this.sessionStore || !this.sessionId) return;
    try {
      this.sessionStore.saveMessages(this.sessionId, this.history);
      // Auto-title from the first user message if the session has no title yet (#227).
      const existing = this.sessionStore.getSession?.(this.sessionId);
      if (existing && !existing.title.trim()) {
        const firstUser = this.history.find((m) => m.role === "user")?.content?.trim();
        if (firstUser) this.sessionStore.renameSession(this.sessionId, firstUser.replace(/\s+/g, " ").slice(0, 60));
      }
    } catch (err) {
      // Another instance owns this session and wrote to it first (#388). Do NOT
      // overwrite their turns: move this conversation to a fresh session so
      // BOTH histories survive, and say so.
      if ((err as { name?: string })?.name === "SessionConflictError") {
        try {
          const fresh = this.sessionStore.createSession("recovered (concurrent instance)");
          this.sessionStore.claimSession?.(fresh);
          this.sessionId = fresh;
          this.sessionStore.saveMessages(fresh, this.history);
          this.reportPersistenceIssue(
            `Another MetalMind instance is writing the previous session; this conversation moved to a new session (${fresh}) so neither history is lost.`,
          );
          return;
        } catch {
          /* fall through to the generic report below */
        }
      }
      // Persistence failure must never break a turn — but surface it ONCE per
      // distinct error so silent history loss can't go unnoticed (#332).
      const msg = errText(err);
      if (msg !== this.lastPersistError) {
        this.lastPersistError = msg;
        this.reportPersistenceIssue(`Session save failing: ${msg}`);
      }
    }
  }

  /** List persisted sessions (most-recent first) for /resume (#140). */
  listSessions(): Array<{ id: string; title: string; updated_at: string; tags?: string }> {
    if (!this.sessionStore) return [];
    try {
      return this.sessionStore.listSessions();
    } catch {
      return [];
    }
  }

  /** Full-text search across persisted sessions (title, tags, message content) (#202). */
  searchSessions(query: string): Array<{ id: string; title: string; updated_at: string; tags?: string }> {
    if (!this.sessionStore) return [];
    try {
      return this.sessionStore.searchSessions(query);
    } catch {
      return [];
    }
  }

  /** Rename a persisted session (#202). */
  renameSession(id: string, title: string): boolean {
    if (!this.sessionStore) return false;
    try {
      this.sessionStore.renameSession(id, title);
      return true;
    } catch {
      return false;
    }
  }

  /** Set a persisted session's tags (comma-separated) (#202). */
  tagSession(id: string, tags: string): boolean {
    if (!this.sessionStore) return false;
    try {
      this.sessionStore.tagSession(id, tags);
      return true;
    } catch {
      return false;
    }
  }

  /** Resume a specific session by id; returns its non-system messages (#140). */
  resumeSession(id: string): AgentMessage[] {
    if (!this.sessionStore) return [];
    try {
      // Don't take over a session another live instance is writing (#388).
      const owner = this.sessionStore.activeOwner?.(id);
      if (owner) {
        this.history = this.sessionStore.loadMessages(id);
        const forked = this.sessionStore.createSession(`fork of ${id}`);
        this.sessionStore.claimSession?.(forked);
        this.sessionId = forked;
        this.reportPersistenceIssue(
          `Session ${id} is open in another MetalMind instance (pid ${owner}) — resumed here as a copy (${forked}).`,
        );
      } else {
        this.history = this.sessionStore.loadMessages(id);
        this.sessionId = id;
        this.sessionStore.claimSession?.(id);
      }
      this.turnCount = this.history.filter((m) => m.role === "user").length;
      // Mirror initPersistence: the resumed prompt's repo map/instructions may
      // predate on-disk changes — rebuild on the next turn (#302). And the
      // previous conversation's task list must not bleed into this one.
      this.systemPromptDirty = true;
      this.scheduleRepoMapRebuild();
      this.todos = [];
      this.onTodos?.([]);
      this.turnContext = [];
      this.pendingImages = []; // don't carry a staged image into the resumed session (#375)
      // turnCount was just recomputed from the resumed history, so the previous
      // conversation's turn-keyed checkpoints/edit sets would collide (#374).
      this.resetRestoreState();
      return this.displayMessages();
    } catch {
      return [];
    }
  }

  /** Start a fresh session without destroying persisted data (for /clear) (#140). */
  newSession(): void {
    this.clearHistory();
    if (this.sessionStore) {
      try {
        this.sessionId = this.sessionStore.createSession();
        this.sessionStore.claimSession?.(this.sessionId); // own it before writing (#388)
      } catch {
        // keep going in-memory
      }
    }
  }

  /** Summarize older turns into one message to reclaim context window (#145). */
  /** Estimated tokens of the persisted history (content + tool calls + images). */
  private historyTokens(): number {
    const IMAGE_TOKEN_ESTIMATE = 1_100;
    return this.history.reduce(
      (s, m) =>
        s +
        estimateTokens(m.content) +
        (m.toolCalls?.length ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) +
        (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE,
      0,
    );
  }

  /** Auto-compact when history nears the context window (#273). Returns a user
   *  notice when compaction ran, null otherwise. Best-effort: any failure means
   *  the turn proceeds and enforceContextBudget still guards the hard limit. */
  private async maybeAutoCompact(): Promise<string | null> {
    let limit = 32_768;
    try {
      limit = this.getProvider(this.config.provider, this.config.model).supportedCapabilities?.maximumContextTokens ?? limit;
    } catch {
      /* keyless/unbuildable provider — use the conservative default */
    }
    // Mirror enforceContextBudget's budget (limit − reserve) and fire at 90% of
    // it, so summarization always happens BEFORE the hard message-dropping guard.
    const reserve = Math.max(2048, Math.floor(limit * 0.2));
    const budget = limit - reserve;
    if (budget <= 0 || this.historyTokens() < budget * 0.9) return null;
    try {
      const report = await this.compactHistory();
      return report.startsWith("Compacted") ? `[auto-compact] ${report}` : null;
    } catch {
      return null;
    }
  }

  async compactHistory(): Promise<string> {
    const systemPart = this.history[0]?.role === "system" ? [this.history[0]] : [];
    const rest = this.history.slice(systemPart.length);
    const KEEP_RECENT = 4;
    if (rest.length <= KEEP_RECENT + 2) return "History is short — nothing to compact yet.";

    // Snap the boundary back to a clean user turn so we never split a
    // tool_call/tool_result pair (an orphaned tool message 400s the provider) (#237).
    let split = rest.length - KEEP_RECENT;
    while (split > 0 && rest[split].role !== "user") split--;
    const toSummarize = rest.slice(0, split);
    // Drop any orphaned tool messages that would still dangle without their call.
    const recent = rest.slice(split).filter((m, i, arr) => {
      if (m.role !== "tool") return true;
      // keep a tool message only if some preceding kept message issued tool calls
      return arr.slice(0, i).some((p) => p.role === "assistant" && p.toolCalls?.length);
    });
    if (toSummarize.length === 0) return "History is short — nothing to compact yet.";
    const convo = toSummarize
      .map((m) => `${m.role}: ${m.content}${m.toolCalls?.length ? ` [tools: ${m.toolCalls.map((t) => t.toolName).join(", ")}]` : ""}`)
      .join("\n")
      .slice(0, 12_000);

    try {
      const provider = this.getProvider(this.config.provider, this.config.model);
      const res = await this.completeChatWithRetry(provider, {
        messages: [
          {
            role: "system",
            content:
              "Summarize the following conversation concisely. Preserve key decisions, file paths touched, important facts, and any unresolved tasks. Output only the summary.",
          },
          { role: "user", content: convo },
        ],
      });
      const summary = res.message.content.trim() || "(summary unavailable)";
      this.history = [
        ...systemPart,
        { role: "assistant", content: `[Summary of ${toSummarize.length} earlier messages]\n${summary}` },
        ...recent,
      ];
      this.saveSession();
      return `Compacted ${toSummarize.length} earlier messages into a summary; kept the last ${KEEP_RECENT}.`;
    } catch (err) {
      return `Compaction failed: ${errText(err)}`;
    }
  }

  /** Export the conversation transcript to Markdown or JSON; returns the file path (#154). */
  exportTranscript(format: "md" | "json" = "md"): string {
    const dir = join(this.projectRoot, ".metalmind", "transcripts");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `transcript-${stamp}.${format === "json" ? "json" : "md"}`);

    // Redact BOTH formats (#355): tool results in history can contain secrets
    // (env dumps, config echoes) that the UI scrubs but a raw export would
    // persist to disk verbatim.
    if (format === "json") {
      writeFileSync(file, this.redactor.redact(JSON.stringify(this.history, null, 2)), "utf-8");
      return file;
    }

    const md = this.history
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "user") return `## You\n\n${m.content}`;
        if (m.role === "assistant") {
          // Include the arguments, not just tool names (#355) — an export that
          // says "ran editFile" without what it edited isn't a usable record.
          const tools = m.toolCalls?.length
            ? "\n\n" + m.toolCalls.map((t) => {
                const args = (t.argumentsJson ?? "").replace(/\s+/g, " ");
                return `- \`${t.toolName}(${args.length > 200 ? args.slice(0, 197) + "…" : args})\``;
              }).join("\n")
            : "";
          return `## Assistant\n\n${m.content}${tools}`;
        }
        if (m.role === "tool") return `> tool result:\n>\n> \`\`\`\n> ${m.content.slice(0, 2000).replace(/\n/g, "\n> ")}\n> \`\`\``;
        return m.content;
      })
      .join("\n\n");
    writeFileSync(file, this.redactor.redact(`# MetalMind transcript\n\n${md}\n`), "utf-8");
    return file;
  }

  /** Release resources: background processes (#153) and stdio MCP clients (#155). */
  /** Release this agent's resources.
   *
   *  `killAll` defaults to FALSE (#409): the background-process registry is
   *  process-global, so a superseded or cancelled model-switch reload used to
   *  kill the *live* agent's dev server. Only a real shutdown (process exit)
   *  should take those down — index.tsx's exit/signal handlers do that. */
  dispose(opts: { killBackgroundProcesses?: boolean } = {}): void {
    if (opts.killBackgroundProcesses) killAllBackgroundProcesses();
    // Stop the shared language server (#424): nothing ever called shutdown(),
    // so every model/provider switch orphaned another typescript-language-server
    // for the rest of the terminal session.
    void shutdownLspClient().catch(() => {});
    for (const client of this.mcpStdioClients) {
      void client.disconnect().catch(() => {});
    }
    // Release the sqlite connection (and its WAL handles) so reloading the agent
    // on a model/provider switch doesn't leak a handle each time (#242).
    try {
      this.sessionStore?.close?.();
    } catch {
      /* already closed */
    }
    this.sessionStore = null;
  }
}
