import { createProvider } from "@metalmind/providers";
import { ToolRegistry, allReadOnlyTools, allGitTools } from "@metalmind/tools";
import type { AgentMessage } from "@metalmind/schemas";
import type { ModelProvider } from "@metalmind/core";
import type { ChatStreamEvent } from "./hooks/useChat.js";
import type { TuiConfig } from "./config.js";

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allReadOnlyTools) registry.register(tool);
  for (const tool of allGitTools) registry.register(tool);
  return registry;
}

export class AgentLoop {
  private provider: ModelProvider;
  private registry: ToolRegistry;
  private history: AgentMessage[] = [];
  private projectRoot: string;

  constructor(config: TuiConfig) {
    this.provider = createProvider(config.provider, config.model, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    this.registry = buildRegistry();
    this.projectRoot = process.cwd();
  }

  get providerLabel(): string {
    return `${this.provider.providerName}/${this.provider.providerName}`;
  }

  async *run(userInput: string): AsyncGenerator<ChatStreamEvent> {
    this.history.push({ role: "user", content: userInput });

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
        for await (const event of this.provider.streamChatCompletion({
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
  }
}
