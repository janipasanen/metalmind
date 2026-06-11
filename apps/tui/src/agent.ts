import { createProvider, OllamaWorkerProvider, isAbortError, isRetryableError, ProviderError } from "@metalmind/providers";
import { ToolRegistry, allReadOnlyTools, allWriteTools, allGitTools, runShellTools, allSymbolTools, allWebTools, allDocumentTools, backgroundShellTools, killAllBackgroundProcesses, createDiagnosticsTool, AuditLog, DiffGenerator, RepoMapV2, indexFile, getReferenceIndex } from "@metalmind/tools";
import { loadConfigFromFile, loadXdgConfig, saveXdgConfig } from "@metalmind/config";
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
}

/** Unified MCP tool client — both the HTTP and stdio transports satisfy this. */
interface McpToolClient {
  callTool(name: string, input: unknown): Promise<string>;
}
import { zodToJsonSchema } from "./zod-to-json.js";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, resolve, join, dirname, extname } from "node:path";
import { execSync } from "node:child_process";
import type { AgentMessage, MetalmindConfig } from "@metalmind/schemas";
import type { ModelProvider, RouteDecision, TriageLabel, ModelCapabilities, ModelStreamEvent, SafetyViolation } from "@metalmind/core";
import type { ToolAuditEntry } from "@metalmind/tools";
import { ModelRouter, estimateTokens, evaluateQuality, Coordinator, SafetyValidator, LatencyTracker } from "@metalmind/core";
import type { CoordinatorPhase, PlanStep } from "@metalmind/core";
import type { ModelRoutingDecision } from "@metalmind/schemas";
import type { ChatStreamEvent } from "./hooks/useChat.js";
import { providerCredentials, type TuiConfig } from "./config.js";
import { Redactor, collectSecrets } from "./redact.js";

interface BufferedAttempt {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; argumentsJson: string }>;
  errored: boolean;
  errorMessage?: string;
}

function buildRegistry(projectRoot: string): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allReadOnlyTools) registry.register(tool);
  for (const tool of allWriteTools) registry.register(tool);
  for (const tool of allGitTools) registry.register(tool);
  for (const tool of runShellTools) registry.register(tool);
  // Code-intelligence tools: symbol/reference/call-graph navigation + LSP diagnostics.
  for (const tool of allSymbolTools) registry.register(tool);
  registry.register(createDiagnosticsTool(projectRoot));
  // Web tools: fetch a URL / search the web.
  for (const tool of allWebTools) registry.register(tool);
  // Document tools: write Office/ODF/HTML/LaTeX/Markdown via writeDocument + format-specific tools.
  for (const tool of allDocumentTools) registry.register(tool);
  // Background process tools: run/poll/stop long-running commands.
  for (const tool of backgroundShellTools) registry.register(tool);
  return registry;
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
    "taskType is one of: summarizeFile, extractSymbols, rankRelevantFiles, summarizeDiff, classifyIntent. " +
    "inputs is an array where each item is the input object for one task (e.g. { filePath } for summarizeFile).",
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

interface EditSet {
  turn: number;
  files: Array<{ path: string; before: string | null }>;
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
  private workspaceRoots: string[] = [];
  private coordinator: Coordinator | null = null;
  private safetyValidator: SafetyValidator;
  private _forcedTier: ForcedTier = null;
  private tierOverrides = new Map<1 | 2 | 3, { provider: string; model: string }>();
  private remoteBrain = false;
  private subagentDepth = 0;
  private auditLog = new AuditLog();
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
        this.tierOverrides.set(t as 1 | 2 | 3, { provider: tm.provider, model: tm.model });
      }
    }
    this.rebuildRedactor();
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.registry = buildRegistry(this.projectRoot);
    this.safetyValidator = new SafetyValidator(this.projectRoot);
    this.workspaceRoots = loadXdgConfig().workspacePaths ?? [];
    // Warm the symbol/reference index in the background so findSymbol/findReferences
    // return results without blocking startup (#149).
    this.indexProjectInBackground();
    // Discover skills; activating one updates the live system prompt (#156).
    this.skillManager.setToolRegistry(this.registry);
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
  setTierModel(tier: 1 | 2 | 3, provider: string, model: string): void {
    this.tierOverrides.set(tier, { provider, model });
    try {
      const xdg = loadXdgConfig();
      saveXdgConfig({ ...xdg, tierModels: { ...(xdg.tierModels ?? {}), [tier]: { provider, model } } });
    } catch {
      // persistence is best-effort
    }
  }

  getTierModel(tier: 1 | 2 | 3): { provider: string; model: string } | undefined {
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

  get safety(): SafetyValidator {
    return this.safetyValidator;
  }

  addWorkspaceRoot(path: string): void {
    if (!this.workspaceRoots.includes(path)) {
      this.workspaceRoots = [...this.workspaceRoots, path];
      const cfg = loadXdgConfig();
      const existing = cfg.workspacePaths ?? [];
      if (!existing.includes(path)) {
        saveXdgConfig({ ...cfg, workspacePaths: [...existing, path] });
      }
    }
  }

  /** Connect to all enabled HTTP MCP servers and discover their tools. */
  async initMcp(): Promise<void> {
    const userConfig = loadXdgConfig();
    for (const [id, srv] of Object.entries(userConfig.mcpServers || {})) {
      if (!srv.enabled) continue;
      try {
        if (srv.url) {
          // HTTP/SSE transport.
          const client = new McpHttpClient(srv.url, srv.headers ?? {});
          await client.initialize();
          for (const tool of await client.listTools()) {
            // Namespace by server id so two servers' same-named tools don't collide (#161).
            this.mcpTools.set(`${id}:${tool.name}`, { client, def: tool });
          }
        } else if (srv.command) {
          // Stdio transport — spawn a command-based MCP server (#155).
          const stdio = new McpClient({ name: id, command: srv.command, args: srv.args, env: srv.env, cwd: srv.cwd });
          await stdio.connect();
          this.mcpStdioClients.push(stdio);
          const adapter: McpToolClient = {
            callTool: async (name, input) =>
              normalizeMcpResult(await stdio.callTool(name, (input ?? {}) as Record<string, unknown>)),
          };
          for (const tool of stdio.tools) {
            this.mcpTools.set(`${id}:${tool.name}`, { client: adapter, def: tool });
          }
        }
        // else: neither url nor command configured — nothing to connect.
      } catch (err) {
        console.error(`MCP server "${id}" init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

  private getProvider(provider: string, model: string): ModelProvider {
    const key = `${provider}/${model}`;
    let cached = this.providerCache.get(key);
    if (!cached) {
      const creds =
        provider === this.config.provider
          ? { apiKey: this.config.apiKey, baseUrl: this.config.baseUrl }
          : providerCredentials(provider);
      cached = createProvider(provider, model, creds);
      this.providerCache.set(key, cached);
    }
    return cached;
  }

  private toolDefs() {
    const builtIn = this.registry.list().map((t) => ({
      name: t.toolName,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    }));
    // Expose the namespaced key (serverId:toolName) to the model so collisions
    // across servers stay distinct; dispatch maps it back to the original name.
    const mcp = [...this.mcpTools.entries()].map(([namespacedName, { def }]) => ({
      name: namespacedName,
      description: def.description,
      inputSchema: def.inputSchema,
    }));
    // In remote-brain mode the cloud model can offload bounded subtasks to the
    // small local model in parallel (cached) via this tool (#186/#187).
    const delegate = this.remoteBrain && this.coordinator ? [DELEGATE_TO_LOCAL_DEF] : [];
    // General sub-agent delegation, but only at the top level — a sub-agent can't
    // spawn more sub-agents (prevents unbounded recursion) (#210).
    const task = this.subagentDepth === 0 ? [TASK_TOOL_DEF] : [];
    return [...builtIn, ...mcp, ...delegate, ...task];
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
        const local = this.getProvider(this.config.provider, this.config.model);
        const res = await local.completeChat({
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
  private async collectAttempt(
    provider: ModelProvider,
    toolDefs: unknown[],
    signal?: AbortSignal,
  ): Promise<BufferedAttempt> {
    const attempt: BufferedAttempt = { text: "", toolCalls: [], errored: false };
    this.enforceContextBudget(provider);
    try {
      for await (const event of provider.streamChatCompletion({
        messages: [...this.history],
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
          for await (const ev of provider.streamChatCompletion({
            messages: [...this.history],
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
            yield { type: "error", message: errText(err) };
            return;
          }
          const retryable = isRetryableError(err);
          if (retryable && attempt < maxRetries) {
            const waitMs =
              err instanceof ProviderError && err.retryAfterMs
                ? err.retryAfterMs
                : backoffMs(attempt);
            await sleep(waitMs, signal);
            continue; // retry same provider
          }
          if (retryable && moreProviders) {
            yield {
              type: "text",
              text: `\n[${provider.providerName} unavailable (${errText(err)}); falling back to ${providers[p + 1].providerName}]\n`,
            };
            break; // advance to next provider in the chain
          }
          // Fatal, or all retries/providers exhausted.
          yield { type: "error", message: errText(err) };
          return;
        }
      }
    }

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
    }
    this.history.push({ role: "user", content: userInput });
    this.turnCount++;
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

    while (!verdict.passed && decision.tier !== "tier3-cloud") {
      const nextTier = this.router.escalateTier(decision.tier);
      decision = this.router.decisionForTier(nextTier, `escalated (${verdict.reason})`);
      this.recordRoute(decision);
      yield {
        type: "text",
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
    const historyTokens = this.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const { decision: coordDecision, localResult } = await this.coordinator!.processRequest(userInput, {
      inputTokenEstimate: historyTokens,
      input: { userMessage: userInput },
    });

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
        const plan = await this.coordinator!.buildPlan(userInput, this.getProvider(pd.provider, pd.modelId));
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
    let verdict = evaluateQuality({ text: attempt.text, toolCalls: attempt.toolCalls, errored: attempt.errored });

    while (!verdict.passed && decision.tier !== "tier3-cloud") {
      this.router.recordFailure(decision.tier);
      const nextTier = this.router.escalateTier(decision.tier);
      decision = this.router.decisionForTier(nextTier, `escalated (${verdict.reason})`);
      this.recordRoute(decision);
      yield { type: "text", text: `\n[escalating to ${decision.provider}/${decision.modelId} — ${verdict.reason}]\n` };
      provider = this.getProvider(decision.provider, decision.modelId);
      attempt = await this.collectAttempt(provider, toolDefs, signal);
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
        if (assistantText) yield { type: "text", text: assistantText };
        for (const tc of pendingToolCalls) {
          yield { type: "tool-call", toolCall: { toolName: tc.toolName, argumentsJson: tc.argumentsJson } };
        }
        pending = undefined;
      } else {
        // Time each model request from here so latency is per-request, not cumulative (#209).
        this.attemptStartMs = Date.now();
        let sawError = false;
        for await (const event of this.streamResilient(providers, toolDefs, signal)) {
          if (event.type === "text") {
            assistantText += event.text;
            yield { type: "text", text: event.text };
          } else if (event.type === "tool-call") {
            pendingToolCalls.push(event.toolCall);
            yield {
              type: "tool-call",
              toolCall: { toolName: event.toolCall.toolName, argumentsJson: event.toolCall.argumentsJson },
            };
          } else if (event.type === "usage") {
            this.recordUsage(event.usage);
          } else if (event.type === "error") {
            yield { type: "error", message: event.message };
            sawError = true;
          } else if (event.type === "done") {
            break;
          }
        }
        if (sawError) { yield { type: "done" }; return; }
        // User cancelled mid-stream: persist partial output and end cleanly.
        if (signal?.aborted) {
          if (assistantText) this.history.push({ role: "assistant", content: assistantText });
          yield { type: "done" };
          return;
        }
      }

      if (pendingToolCalls.length === 0) {
        if (assistantText) this.history.push({ role: "assistant", content: assistantText });
        yield { type: "done" };
        return;
      }

      this.history.push({ role: "assistant", content: assistantText, toolCalls: pendingToolCalls });

      // Parallel fast-path: when every pending call is a side-effect-free read-only
      // tool (and not an MCP tool), run them concurrently instead of one-by-one (#206).
      // Mutating/approval-gated/MCP batches fall through to the ordered path below.
      if (
        pendingToolCalls.length > 1 &&
        pendingToolCalls.every((c) => READ_ONLY_PARALLEL_TOOLS.has(c.toolName) && !this.mcpTools.has(c.toolName))
      ) {
        const outputs = await this.runReadOnlyBatch(pendingToolCalls);
        for (let i = 0; i < pendingToolCalls.length; i++) {
          yield { type: "tool-result", output: outputs[i] };
          this.history.push({
            role: "tool",
            content: outputs[i],
            metadata: { toolCallId: pendingToolCalls[i].toolCallId },
          });
        }
        continue;
      }

      for (const call of pendingToolCalls) {
        const inputObj = this.safeParseArgs(call.argumentsJson);

        // Safety gate: block dangerous shell commands and secret-path access
        // before any execution (#139).
        const violation = this.preflightSafety(call.toolName, inputObj);
        if (violation) {
          const output = `Blocked: ${violation.message}`;
          this.auditLog.log({
            timestamp: new Date().toISOString(),
            toolName: call.toolName,
            input: inputObj,
            output,
            success: false,
            error: violation.message,
          });
          this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
          yield { type: "tool-result", output };
          continue;
        }

        // Human-in-the-loop approval gate: pause before any side-effecting tool (#138).
        if (this.needsApproval(call.toolName)) {
          const decision = await this.requestApproval(call.toolName, inputObj);
          if (decision === "reject") {
            const output = `Rejected by user — "${call.toolName}" was not executed.`;
            this.auditLog.log({
              timestamp: new Date().toISOString(),
              toolName: call.toolName,
              input: inputObj,
              output,
              success: false,
              error: "rejected by user",
            });
            this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
            yield { type: "tool-result", output };
            continue;
          }
        }

        // Snapshot affected files before any mutation so /undo can revert (#144).
        this.snapshotEdit(this.turnCount, call.toolName, inputObj);

        let output: string;
        try {
          const mcpEntry = this.mcpTools.get(call.toolName);
          if (call.toolName === "delegateToLocal") {
            // Cloud brain offloads bounded subtasks to the local model (#187).
            output = await this.handleDelegateToLocal(inputObj);
          } else if (call.toolName === "task") {
            // Spawn a focused sub-agent with its own bounded loop (#210).
            output = await this.handleTaskDelegation(inputObj, signal);
          } else if (mcpEntry) {
            // Call the server with the ORIGINAL (un-namespaced) tool name.
            output = await this.callMcpAudited(mcpEntry.client, mcpEntry.def.name, inputObj);
          } else {
            const result = await this.registry.execute(call.toolName, inputObj, {
              projectRoot: this.projectRoot,
              workspaceRoots: this.workspaceRoots,
              auditLog: this.auditLog.log, // record every built-in tool call (#147)
            });
            output = typeof result === "string" ? result : JSON.stringify(result);
            // Post-edit feedback loop: re-index, optional format, append diagnostics.
            output = await this.postEditHook(call.toolName, inputObj, output);
          }
        } catch (err) {
          output = `Error: ${errText(err)}`;
        }

        // Scrub any secret values before the output reaches the model or UI (#168).
        output = this.redactor.redact(output);

        yield { type: "tool-result", output };

        this.history.push({
          role: "tool",
          content: output,
          metadata: { toolCallId: call.toolCallId },
        });
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
        this.auditLog.log({
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
          auditLog: this.auditLog.log,
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
    if ((toolName === "runCommand" || toolName === "runBackground") && typeof input.command === "string") {
      return (
        this.safetyValidator.validateShellCommand(input.command) ??
        this.safetyValidator.validateFilePath(input.command)
      );
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
  private needsApproval(toolName: string): boolean {
    return this.safetyValidator.requiresApproval(toolName) || this.mcpTools.has(toolName);
  }

  /** Resolve the approval decision: always-allowed / auto-approve short-circuit, else ask the UI. */
  private async requestApproval(toolName: string, input: Record<string, unknown>): Promise<ApprovalDecision> {
    if (this.alwaysAllow.has(toolName) || this.autoApprove) return "approve";
    if (!this.onApprovalRequest) return "approve"; // headless / no UI wired → no gate
    try {
      const decision = await this.onApprovalRequest(this.buildApprovalRequest(toolName, input));
      if (decision === "always") this.alwaysAllow.add(toolName);
      return decision;
    } catch {
      return "reject"; // a failed/aborted prompt must not silently execute
    }
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
    } catch {
      // diff generation is best-effort; fall through to a summary
    }
    if (toolName === "deleteFile") return { toolName, kind: "write", summary: `Delete ${path ?? "(file)"}`, filePath: path };
    if (toolName === "moveFile") return { toolName, kind: "write", summary: `Move ${String(input.source)} → ${String(input.destination)}` };
    if (toolName === "multiEdit") {
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      return { toolName, kind: "write", summary: `Apply ${n} edit(s) atomically across files` };
    }
    if (toolName === "replaceInProject") {
      return { toolName, kind: "write", summary: `Replace "${String(input.find)}" → "${String(input.replace)}" across the project` };
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
  private snapshotEdit(turn: number, toolName: string, input: Record<string, unknown>): void {
    const targets: string[] = [];
    if (MUTATING_FILE_TOOLS.has(toolName) && typeof input.path === "string") {
      targets.push(input.path);
    } else if (toolName === "moveFile") {
      if (typeof input.source === "string") targets.push(input.source);
      if (typeof input.destination === "string") targets.push(input.destination);
    } else if (toolName === "multiEdit" && Array.isArray(input.edits)) {
      for (const e of input.edits as Array<{ path?: unknown }>) {
        if (typeof e?.path === "string") targets.push(e.path);
      }
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

    const inverse: EditSet = { turn: set.turn, files: [] };
    const changed: string[] = [];
    for (const [path, before] of earliest) {
      // Capture the current content as the inverse snapshot (for redo/undo back).
      let current: string | null = null;
      try {
        current = existsSync(path) ? readFileSync(path, "utf8") : null;
      } catch {
        current = null;
      }
      inverse.files.push({ path, before: current });

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
    pushInverseTo.push(inverse);
    return changed.map((r) => `  • ${r}`).join("\n");
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
    try {
      output = await client.callTool(toolName, input);
      return output;
    } catch (err) {
      success = false;
      error = errText(err);
      output = `Error: ${error}`;
      return output;
    } finally {
      this.auditLog.log({ timestamp, toolName, input, output, success, error });
    }
  }

  /** Recent tool-call audit entries for the in-session /audit view (#147). */
  getAuditEntries(limit = 30): ToolAuditEntry[] {
    return this.auditLog.getRecent(limit);
  }

  /** (Re)build the secret redactor from current config api keys + MCP headers (#168). */
  private rebuildRedactor(): void {
    const xdg = loadXdgConfig();
    this.redactor = new Redactor(collectSecrets(xdg.apiKeys, [this.config.apiKey], xdg.mcpServers));
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
  private async handleDelegateToLocal(input: Record<string, unknown>): Promise<string> {
    if (!this.coordinator) return "Delegation unavailable: no local worker is configured.";
    const taskType = typeof input.taskType === "string" ? input.taskType : "";
    const inputs = Array.isArray(input.inputs) ? input.inputs : [];
    if (!taskType || inputs.length === 0) {
      return 'delegateToLocal requires { taskType: string, inputs: object[] }.';
    }
    const tasks = inputs.slice(0, 16).map((inp, i) => ({
      taskId: `delegate-${i}`,
      taskType,
      input: (inp && typeof inp === "object" ? inp : { value: inp }) as Record<string, unknown>,
    }));
    const results = await this.coordinator.runParallelTasks(tasks as never, 4);
    const lines = results.map(
      (r, i) => `[${i}] ${r?.success ? JSON.stringify(r.output) : `FAILED: ${r?.error ?? "unknown error"}`}`,
    );
    return `Delegated ${tasks.length} "${taskType}" task(s) to the local model:\n${lines.join("\n")}`.slice(0, 8000);
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
      const provider = this.getProvider(this.config.provider, this.config.model);
      const text = await this.runSubagent(objective, provider, signal);
      return text ? `Sub-agent result:\n${text}`.slice(0, 8000) : "(sub-agent produced no output)";
    } catch (err) {
      return `Sub-agent failed: ${errText(err)}`;
    }
  }

  /**
   * Run a focused sub-agent on `provider` for `objective` with an isolated history
   * and a short tool loop, returning its final text. Used by the `task` tool (#210)
   * and by auto-executed local-worker plan steps (#208).
   */
  private async runSubagent(objective: string, provider: ModelProvider, signal?: AbortSignal): Promise<string> {
    if (this.subagentDepth >= 1) return "";
    const savedHistory = this.history;
    const savedTurn = this.turnCount;
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
    try {
      let finalText = "";
      for await (const ev of this.agenticLoop([provider], this.toolDefs(), { signal, maxIterations: 6 })) {
        if (ev.type === "text") finalText += ev.text;
      }
      return finalText.trim();
    } finally {
      this.history = savedHistory;
      this.turnCount = savedTurn;
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
        const out = await this.runSubagent(step.description, localProvider, signal).catch(() => "");
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
    try {
      const provider = this.getProvider(this.config.provider, this.config.model);
      if (provider.health) return await provider.health();
      return { ok: true, message: "" };
    } catch (err) {
      return { ok: false, message: errText(err) };
    }
  }

  /** Record a routing decision (accumulated, not overwritten) and notify the UI (#165). */
  private recordRoute(decision: RouteDecision): void {
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
  private enforceContextBudget(provider: ModelProvider): void {
    const limit = provider.supportedCapabilities?.maximumContextTokens ?? 32_768;
    const reserve = Math.max(2048, Math.floor(limit * 0.2));
    const budget = limit - reserve;
    const tokensOf = (m: AgentMessage): number =>
      estimateTokens(m.content) + (m.toolCalls?.length ? estimateTokens(JSON.stringify(m.toolCalls)) : 0);

    let total = this.history.reduce((s, m) => s + tokensOf(m), 0);
    if (total > budget) {
      const sys = this.history[0]?.role === "system" ? [this.history[0]] : [];
      let rest = this.history.slice(sys.length);
      // Drop oldest non-system messages until under budget (keep the latest turn).
      while (total > budget && rest.length > 1) {
        total -= tokensOf(rest[0]);
        rest = rest.slice(1);
      }
      // Never leave an orphaned tool result at the front — providers reject a
      // tool message without its preceding assistant tool_calls.
      while (rest.length && rest[0].role === "tool") {
        total -= tokensOf(rest[0]);
        rest = rest.slice(1);
      }
      this.history = [...sys, ...rest];
    }
    this.onContextUsage?.(total, limit);
  }

  /** Build a token-bounded repository map (tree + exports/symbols) for the prompt (#143). */
  private loadRepoMap(): string | null {
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

  /** Bounded startup crawl that populates the shared symbol/reference index (#149). */
  private indexProjectInBackground(): void {
    void Promise.resolve().then(() => {
      try {
        const files: string[] = [];
        this.collectSourceFiles(this.projectRoot, files);
        for (const f of files) {
          try {
            indexFile(f);
          } catch {
            // skip unparseable file
          }
        }
      } catch {
        // never let indexing crash the agent
      }
    });
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
    if (MUTATING_FILE_TOOLS.has(toolName) && typeof input.path === "string") return [input.path];
    if (toolName === "moveFile" && typeof input.destination === "string") return [input.destination];
    if (toolName === "multiEdit" && Array.isArray(input.edits)) {
      return [...new Set((input.edits as Array<{ path?: unknown }>).filter((e) => typeof e?.path === "string").map((e) => e.path as string))];
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

    const editorCfg = loadXdgConfig().editor;
    for (const p of paths) {
      const abs = this.resolveProjectPath(p);
      // Format-on-write (#162), opt-in via config.
      if (editorCfg?.formatOnWrite) {
        try {
          const cmd = `${editorCfg.formatCommand || "npx prettier --write"} ${JSON.stringify(abs)}`;
          execSync(cmd, { cwd: this.projectRoot, timeout: 20_000, stdio: "ignore" });
        } catch {
          // formatter missing/failed — leave the file as written
        }
      }
      // Re-index the (possibly formatted) file so lookups reflect the change (#149).
      try {
        indexFile(abs);
      } catch {
        // ignore
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
      `Configured MCP servers:\n${mcpList}`,
      "",
      `Available tools: ${toolNames}`,
      "",
      "You are a fully agentic assistant. You can read files, write and edit files, run shell commands (gh, git, npm, etc.), and use git. Use your tools proactively to complete tasks — do not just suggest code, implement it.",
      "You have access to the entire filesystem. Sensitive paths (.ssh, .aws, .env, credentials) are blocked automatically.",
      "When the user mentions a directory path, you can read files from it directly without any setup.",
      "When asked about MetalMind configuration, read ~/.config/metalmind/config.json with your file tools.",
    ];

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
  }

  /**
   * Open the SQLite session store and create or resume a session (#140).
   * Graceful: if the native store can't load, persistence is disabled silently.
   * Returns the restored non-system messages (for the UI to display).
   */
  async initPersistence(opts: { continue?: boolean; resumeId?: string } = {}): Promise<AgentMessage[]> {
    try {
      // Lazy import: if the native better-sqlite3 addon is unavailable, this
      // throws here and persistence is silently disabled — the TUI still runs.
      const { SqliteSessionStore } = await import("@metalmind/memory");
      this.sessionStore = new SqliteSessionStore(join(this.projectRoot, ".metalmind", "sessions.db"));
    } catch {
      this.sessionStore = null;
      return [];
    }
    try {
      if (opts.resumeId) {
        this.sessionId = opts.resumeId;
        this.history = this.sessionStore.loadMessages(opts.resumeId);
      } else if (opts.continue) {
        const recent = this.sessionStore.listSessions()[0];
        if (recent) {
          this.sessionId = recent.id;
          this.history = this.sessionStore.loadMessages(recent.id);
        } else {
          this.sessionId = this.sessionStore.createSession();
        }
      } else {
        this.sessionId = this.sessionStore.createSession();
      }
    } catch {
      try {
        this.sessionId = this.sessionStore.createSession();
      } catch {
        this.sessionStore = null;
      }
    }
    if (this.history.length > 0) this.turnCount = this.history.filter((m) => m.role === "user").length;
    return this.displayMessages();
  }

  /** User/assistant turns with content, for restoring the chat view on resume. */
  private displayMessages(): AgentMessage[] {
    return this.history.filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0,
    );
  }

  /** Persist the current history to the active session (#140). */
  private saveSession(): void {
    if (!this.sessionStore || !this.sessionId) return;
    try {
      // Use the first user message as the session title if not already set.
      this.sessionStore.saveMessages(this.sessionId, this.history);
    } catch {
      // persistence failure must never break a turn
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
      this.history = this.sessionStore.loadMessages(id);
      this.sessionId = id;
      this.turnCount = this.history.filter((m) => m.role === "user").length;
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
      } catch {
        // keep going in-memory
      }
    }
  }

  /** Summarize older turns into one message to reclaim context window (#145). */
  async compactHistory(): Promise<string> {
    const systemPart = this.history[0]?.role === "system" ? [this.history[0]] : [];
    const rest = this.history.slice(systemPart.length);
    const KEEP_RECENT = 4;
    if (rest.length <= KEEP_RECENT + 2) return "History is short — nothing to compact yet.";

    const toSummarize = rest.slice(0, rest.length - KEEP_RECENT);
    const recent = rest.slice(rest.length - KEEP_RECENT);
    const convo = toSummarize
      .map((m) => `${m.role}: ${m.content}${m.toolCalls?.length ? ` [tools: ${m.toolCalls.map((t) => t.toolName).join(", ")}]` : ""}`)
      .join("\n")
      .slice(0, 12_000);

    try {
      const provider = this.getProvider(this.config.provider, this.config.model);
      const res = await provider.completeChat({
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

    if (format === "json") {
      writeFileSync(file, JSON.stringify(this.history, null, 2), "utf-8");
      return file;
    }

    const md = this.history
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "user") return `## You\n\n${m.content}`;
        if (m.role === "assistant") {
          const tools = m.toolCalls?.length ? `\n\n_Tool calls: ${m.toolCalls.map((t) => t.toolName).join(", ")}_` : "";
          return `## Assistant\n\n${m.content}${tools}`;
        }
        if (m.role === "tool") return `> tool result:\n>\n> \`\`\`\n> ${m.content.slice(0, 2000).replace(/\n/g, "\n> ")}\n> \`\`\``;
        return m.content;
      })
      .join("\n\n");
    writeFileSync(file, `# MetalMind transcript\n\n${md}\n`, "utf-8");
    return file;
  }

  /** Release resources: background processes (#153) and stdio MCP clients (#155). */
  dispose(): void {
    killAllBackgroundProcesses();
    for (const client of this.mcpStdioClients) {
      void client.disconnect().catch(() => {});
    }
  }
}
