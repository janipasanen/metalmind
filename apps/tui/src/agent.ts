import { createProvider, OllamaWorkerProvider } from "@metalmind/providers";
import { ToolRegistry, allReadOnlyTools, allWriteTools, allGitTools, runShellTools } from "@metalmind/tools";
import { loadConfigFromFile, loadXdgConfig, saveXdgConfig } from "@metalmind/config";
import { McpHttpClient, type McpToolDef } from "./mcp-http.js";
import { zodToJsonSchema } from "./zod-to-json.js";
import type { AgentMessage, MetalmindConfig } from "@metalmind/schemas";
import type { ModelProvider, RouteDecision, TriageLabel, ModelCapabilities } from "@metalmind/core";
import { ModelRouter, estimateTokens, evaluateQuality, Coordinator, SafetyValidator } from "@metalmind/core";
import type { CoordinatorPhase, PlanStep } from "@metalmind/core";
import type { ModelRoutingDecision } from "@metalmind/schemas";
import type { ChatStreamEvent } from "./hooks/useChat.js";
import { providerCredentials, type TuiConfig } from "./config.js";

interface BufferedAttempt {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; argumentsJson: string }>;
  errored: boolean;
  errorMessage?: string;
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allReadOnlyTools) registry.register(tool);
  for (const tool of allWriteTools) registry.register(tool);
  for (const tool of allGitTools) registry.register(tool);
  for (const tool of runShellTools) registry.register(tool);
  return registry;
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
  // Treat the sidecar as usable as long as it responds — even if the model is
  // still loading. A 503 on the first chat request will cause the quality gate
  // to escalate to the cloud tier for that turn while the model warms up.
  const baseUrl = target.baseUrl ?? "http://127.0.0.1:8742";
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
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
      ? (resolveNamedTier(routing.defaultFallbackModel, models) ?? { provider: "ollama", model: "gemma3:4b" })
      : { provider: "ollama", model: "gemma3:4b" };

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
    });
  })();
}

export type ForcedTier = 1 | 2 | 3 | null;

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
}

export class AgentLoop {
  private config: TuiConfig;
  private router?: ModelRouter;
  private onRoute?: (decision: RouteDecision) => void;
  private onCoordinatorPhase?: (phase: CoordinatorPhase) => void;
  private onCoordinatorRouting?: (decision: ModelRoutingDecision) => void;
  private onCoordinatorPlan?: (steps: PlanStep[]) => void;
  private registry: ToolRegistry;
  private history: AgentMessage[] = [];
  private projectRoot: string;
  private turnCount = 0;
  private providerCache = new Map<string, ModelProvider>();
  private mcpTools = new Map<string, { client: McpHttpClient; def: McpToolDef }>();
  private workspaceRoots: string[] = [];
  private coordinator: Coordinator | null = null;
  private safetyValidator: SafetyValidator;
  private _forcedTier: ForcedTier = null;
  private tierOverrides = new Map<1 | 2 | 3, { provider: string; model: string }>();

  constructor(config: TuiConfig, options: AgentLoopOptions = {}) {
    this.config = config;
    this.router = options.router;
    this.onRoute = options.onRoute;
    this.onCoordinatorPhase = options.onCoordinatorPhase;
    this.onCoordinatorRouting = options.onCoordinatorRouting;
    this.onCoordinatorPlan = options.onCoordinatorPlan;
    this.registry = buildRegistry();
    this.projectRoot = process.cwd();
    this.safetyValidator = new SafetyValidator(this.projectRoot);
    this.workspaceRoots = loadXdgConfig().workspacePaths ?? [];
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

  /** Override the provider/model used when a specific tier is active.
   *  Useful for switching the cloud model (tier 3) without editing metalmind.yaml. */
  setTierModel(tier: 1 | 2 | 3, provider: string, model: string): void {
    this.tierOverrides.set(tier, { provider, model });
  }

  getTierModel(tier: 1 | 2 | 3): { provider: string; model: string } | undefined {
    return this.tierOverrides.get(tier);
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
      if (!srv.enabled || !srv.url) continue;
      try {
        const client = new McpHttpClient(srv.url, srv.headers ?? {});
        await client.initialize();
        const tools = await client.listTools();
        for (const tool of tools) {
          this.mcpTools.set(tool.name, { client, def: tool });
        }
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
      : ["deepseek-coder:1.3b", "deepseek-coder:6.7b", "qwen2.5-coder:1.5b", "qwen2.5-coder:7b", "codellama:7b"];

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
    const mcp = [...this.mcpTools.values()].map(({ def }) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    }));
    return [...builtIn, ...mcp];
  }

  /** A triage function that asks the local model to bucket an ambiguous task. */
  private buildTriage() {
    return async (request: string): Promise<TriageLabel | null> => {
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
  private async collectAttempt(provider: ModelProvider, toolDefs: unknown[]): Promise<BufferedAttempt> {
    const attempt: BufferedAttempt = { text: "", toolCalls: [], errored: false };
    try {
      for await (const event of provider.streamChatCompletion({
        messages: [...this.history],
        tools: toolDefs,
      })) {
        if (event.type === "text") attempt.text += event.text;
        else if (event.type === "tool-call") attempt.toolCalls.push(event.toolCall);
        else if (event.type === "done") break;
      }
    } catch (err) {
      attempt.errored = true;
      attempt.errorMessage = err instanceof Error ? err.message : String(err);
    }
    return attempt;
  }

  async *run(userInput: string): AsyncGenerator<ChatStreamEvent> {
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: this.buildSystemPrompt() });
    }
    this.history.push({ role: "user", content: userInput });
    this.turnCount++;
    const toolDefs = this.toolDefs();

    if (!this.router) {
      yield* this.agenticLoop(this.getProvider(this.config.provider, this.config.model), toolDefs);
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
        : this.router.decisionForTier(tierKey, `forced tier ${this._forcedTier}`);

      this.onRoute?.(decision);
      const provider = this.getProvider(decision.provider, decision.modelId);
      yield* this.agenticLoop(provider, toolDefs);
      return;
    }

    if (this.coordinator) {
      yield* this.runWithCoordinator(userInput, toolDefs);
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
    this.onRoute?.(decision);

    let provider = this.getProvider(decision.provider, decision.modelId);
    let attempt = await this.collectAttempt(provider, toolDefs);
    let verdict = evaluateQuality({
      text: attempt.text,
      toolCalls: attempt.toolCalls,
      errored: attempt.errored,
    });

    while (!verdict.passed && decision.tier !== "tier3-cloud") {
      const nextTier = this.router.escalateTier(decision.tier);
      decision = this.router.decisionForTier(nextTier, `escalated (${verdict.reason})`);
      this.onRoute?.(decision);
      yield {
        type: "text",
        text: `\n[escalating to ${decision.provider}/${decision.modelId} — ${verdict.reason}]\n`,
      };
      provider = this.getProvider(decision.provider, decision.modelId);
      attempt = await this.collectAttempt(provider, toolDefs);
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

    yield* this.agenticLoop(provider, toolDefs, attempt);
  }

  /** Run a turn through the multi-agent Coordinator.
   *
   * The coordinator's local worker runs intent classification only —
   * the result is routing metadata, never a user-facing response.
   * After classification the real work always goes to the appropriate tier.
   */
  private async *runWithCoordinator(userInput: string, toolDefs: unknown[]): AsyncGenerator<ChatStreamEvent> {
    const historyTokens = this.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const { decision, localResult } = await this.coordinator!.processRequest(userInput, {
      inputTokenEstimate: historyTokens,
      input: { userMessage: userInput },
    });

    this.onCoordinatorRouting?.(decision);

    // Use the classification to pick a tier, but never return the raw
    // classification JSON as the user's answer — that's just routing metadata.
    let targetTierKey: "tier1-local" | "tier2-medium" | "tier3-cloud" = "tier3-cloud";
    if (localResult?.success) {
      const out = localResult.output as { suggestedTier?: string } | undefined;
      if (out?.suggestedTier === "local-worker") targetTierKey = "tier1-local";
      else if (out?.suggestedTier === "direct-tool") targetTierKey = "tier2-medium";
      // cloud-main → tier3-cloud (default)
    }
    // If classification failed, log it silently and fall back to cloud.

    const tieredDecision = this.router
      ? this.router.decisionForTier(targetTierKey, `coordinator classified: ${targetTierKey}`)
      : null;
    const provider = tieredDecision
      ? this.getProvider(tieredDecision.provider, tieredDecision.modelId)
      : this.getProvider(this.config.provider, this.config.model);
    if (tieredDecision) this.onRoute?.(tieredDecision);
    yield* this.agenticLoop(provider, toolDefs);
  }

  /**
   * Drive the agentic tool loop with a chosen provider. An optional `primed`
   * first response (already collected + gated) is emitted before streaming resumes.
   */
  private async *agenticLoop(
    provider: ModelProvider,
    toolDefs: unknown[],
    primed?: BufferedAttempt,
  ): AsyncGenerator<ChatStreamEvent> {
    let iterations = 0;
    const maxIterations = 10;
    let pending = primed;

    while (iterations < maxIterations) {
      iterations++;
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
        try {
          for await (const event of provider.streamChatCompletion({
            messages: [...this.history],
            tools: toolDefs,
          })) {
            if (event.type === "text") {
              assistantText += event.text;
              yield { type: "text", text: event.text };
            } else if (event.type === "tool-call") {
              pendingToolCalls.push(event.toolCall);
              yield {
                type: "tool-call",
                toolCall: { toolName: event.toolCall.toolName, argumentsJson: event.toolCall.argumentsJson },
              };
            } else if (event.type === "done") {
              break;
            }
          }
        } catch (err) {
          yield { type: "error", message: err instanceof Error ? err.message : String(err) };
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

      for (const call of pendingToolCalls) {
        // Safety validation: check if tool requires approval
        if (this.safetyValidator.requiresApproval(call.toolName)) {
          const input = JSON.parse(call.argumentsJson) as Record<string, unknown>;
          const filePath = typeof input.path === "string" ? input.path : "";
          if (filePath) {
            const pathViolation = this.safetyValidator.validateFilePath(filePath);
            if (pathViolation) {
              const output = `Blocked: ${pathViolation.message}`;
              this.history.push({ role: "tool", content: output, metadata: { toolCallId: call.toolCallId } });
              yield { type: "tool-result", output };
              continue;
            }
          }
        }

        let output: string;
        try {
          const input = JSON.parse(call.argumentsJson) as unknown;
          const mcpEntry = this.mcpTools.get(call.toolName);
          if (mcpEntry) {
            output = await mcpEntry.client.callTool(call.toolName, input);
          } else {
            const result = await this.registry.execute(call.toolName, input, {
              projectRoot: this.projectRoot,
              workspaceRoots: this.workspaceRoots,
            });
            output = typeof result === "string" ? result : JSON.stringify(result);
          }
        } catch (err) {
          output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

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

    return [
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
    ].join("\n");
  }

  clearHistory(): void {
    this.history = [];
    this.turnCount = 0;
  }
}
