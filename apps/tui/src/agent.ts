import { createProvider } from "@metalmind/providers";
import { ToolRegistry, allReadOnlyTools, allGitTools } from "@metalmind/tools";
import { loadConfigFromFile } from "@metalmind/config";
import type { AgentMessage, MetalmindConfig } from "@metalmind/schemas";
import type { ModelProvider, RouteDecision, TriageLabel, ModelCapabilities } from "@metalmind/core";
import { ModelRouter, estimateTokens, evaluateQuality } from "@metalmind/core";
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
  for (const tool of allGitTools) registry.register(tool);
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
  const provider = createProvider("mlx", target.model, { baseUrl: target.baseUrl });
  const readiness = (provider as { readiness?: () => Promise<{ ready: boolean }> }).readiness;
  if (!readiness) return true;

  try {
    const status = await readiness.call(provider);
    return status.ready;
  } catch {
    return false;
  }
}

async function resolveLocalTier(fileConfig: MetalmindConfig): Promise<TierTarget> {
  const models = fileConfig.models ?? {};
  const routing = fileConfig.routing;
  const namedLocal =
    resolveNamedTier(routing?.defaultLocalModel, models) ?? defaultLocalTier(isAppleSilicon());

  if (namedLocal.provider !== "mlx") return namedLocal;
  if (await mlxSidecarReady(namedLocal)) return namedLocal;

  return defaultLocalTier(false);
}

/**
 * Build a router from metalmind.yaml routing (named models) when present, defaulting
 * the local tier to MLX on Apple Silicon and the reasoning tier to Anthropic. If the
 * MLX sidecar is down at runtime, the quality gate escalates to the cloud tier.
 */
export function createDefaultRouter(
  config: TuiConfig,
  fileConfig: MetalmindConfig = loadConfigFromFile(),
): Promise<ModelRouter> {
  return (async () => {
    const models = fileConfig.models ?? {};
    const routing = fileConfig.routing;

    const rawLocal = await resolveLocalTier(fileConfig);

    // When the resolved local-tier provider is the same as the user's configured
    // provider AND the user has cloud credentials (API key), the local-default model
    // (e.g. deepseek-coder:1.3b) would be sent to the cloud endpoint where it likely
    // doesn't exist → 404.  Use the user's configured model for all tiers instead.
    const local =
      rawLocal.provider === config.provider && !!config.apiKey
        ? { provider: config.provider, model: config.model }
        : rawLocal;

    const defaultReasoning = { provider: config.provider, model: config.model };
    const reasoning =
      resolveNamedTier(routing?.defaultReasoningModel, models) ?? defaultReasoning;

    return new ModelRouter({
      tier1Provider: local.provider,
      tier1Model: local.model,
      tier2Provider: local.provider,
      tier2Model: local.model,
      tier3Provider: reasoning.provider,
      tier3Model: reasoning.model,
      localFirst: true,
      capabilities: tierCapabilities([local, reasoning]),
    });
  })();
}

export interface AgentLoopOptions {
  /** When provided, the loop routes each turn via the router instead of a fixed provider. */
  router?: ModelRouter;
  /** Called whenever a turn is routed, so the UI can show the active tier/model. */
  onRoute?: (decision: RouteDecision) => void;
}

export class AgentLoop {
  private config: TuiConfig;
  private router?: ModelRouter;
  private onRoute?: (decision: RouteDecision) => void;
  private registry: ToolRegistry;
  private history: AgentMessage[] = [];
  private projectRoot: string;
  private turnCount = 0;
  private providerCache = new Map<string, ModelProvider>();

  constructor(config: TuiConfig, options: AgentLoopOptions = {}) {
    this.config = config;
    this.router = options.router;
    this.onRoute = options.onRoute;
    this.registry = buildRegistry();
    this.projectRoot = process.cwd();
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
    return this.registry.list().map((t) => ({
      name: t.toolName,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
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
    this.history.push({ role: "user", content: userInput });
    this.turnCount++;
    const toolDefs = this.toolDefs();

    if (!this.router) {
      // Manual override: stream directly from the pinned provider, no gate.
      yield* this.agenticLoop(this.getProvider(this.config.provider, this.config.model), toolDefs);
      return;
    }

    // Routed: pick a tier, then quality-gate the first response and escalate on failure.
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
        let output: string;
        try {
          const input = JSON.parse(call.argumentsJson) as unknown;
          const result = await this.registry.execute(call.toolName, input, {
            projectRoot: this.projectRoot,
          });
          output = typeof result === "string" ? result : JSON.stringify(result);
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

  clearHistory(): void {
    this.history = [];
    this.turnCount = 0;
  }
}
