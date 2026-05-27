import { createProvider } from "@metalmind/providers";
import { ToolRegistry, allReadOnlyTools, allGitTools } from "@metalmind/tools";
import type { AgentMessage } from "@metalmind/schemas";
import type { ModelProvider, RouteDecision } from "@metalmind/core";
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

/**
 * Build a router whose local tier is the resolved config provider/model and whose
 * cloud tier defaults to Anthropic. Used when the user hasn't pinned a provider.
 */
export function createDefaultRouter(config: TuiConfig): ModelRouter {
  return new ModelRouter({
    tier1Model: config.model,
    tier1Provider: config.provider,
    tier2Model: config.model,
    tier2Provider: config.provider,
    tier3Model: "claude-sonnet-4-6",
    tier3Provider: "anthropic",
    localFirst: true,
  });
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
    let decision = this.router.route(userInput, 0, {
      conversationDepth: this.turnCount,
      historyTokens,
    });
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
