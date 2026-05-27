import { createProvider } from "@metalmind/providers";
import { ToolRegistry, allReadOnlyTools, allGitTools } from "@metalmind/tools";
import type { AgentMessage } from "@metalmind/schemas";
import type { ModelProvider, RouteDecision } from "@metalmind/core";
import { ModelRouter, estimateTokens } from "@metalmind/core";
import type { ChatStreamEvent } from "./hooks/useChat.js";
import { providerCredentials, type TuiConfig } from "./config.js";

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

  /** Pick the provider/model for this turn, routing if a router is configured. */
  private selectProvider(userInput: string): { provider: ModelProvider; label: string } {
    if (this.router) {
      const historyTokens = this.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const decision = this.router.route(userInput, 0, {
        conversationDepth: this.turnCount,
        historyTokens,
      });
      this.onRoute?.(decision);
      return {
        provider: this.getProvider(decision.provider, decision.modelId),
        label: `${decision.provider}/${decision.modelId}`,
      };
    }
    return {
      provider: this.getProvider(this.config.provider, this.config.model),
      label: this.providerLabel,
    };
  }

  async *run(userInput: string): AsyncGenerator<ChatStreamEvent> {
    this.history.push({ role: "user", content: userInput });
    this.turnCount++;

    const { provider } = this.selectProvider(userInput);

    const toolDefs = this.registry.list().map((t) => ({
      name: t.toolName,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;
      let assistantText = "";
      const pendingToolCalls: Array<{ toolCallId: string; toolName: string; argumentsJson: string }> = [];

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
              toolCall: {
                toolName: event.toolCall.toolName,
                argumentsJson: event.toolCall.argumentsJson,
              },
            };
          } else if (event.type === "done") {
            break;
          }
        }
      } catch (err) {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        yield { type: "done" };
        return;
      }

      if (pendingToolCalls.length === 0) {
        if (assistantText) {
          this.history.push({ role: "assistant", content: assistantText });
        }
        yield { type: "done" };
        return;
      }

      // execute tool calls and continue the loop
      this.history.push({
        role: "assistant",
        content: assistantText,
        toolCalls: pendingToolCalls,
      });

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
