import type { AgentMessage } from "@metalmind/schemas";
import { ToolCallExtractor } from "./tool-call-extractor.js";
import type { ModelStreamEvent, ModelCapabilities } from "@metalmind/core";

export interface NormalizationResult {
  messages: AgentMessage[];
  streamEvents?: ModelStreamEvent[];
}

export class MessageNormalizer {
  private extractor = new ToolCallExtractor();

  /**
   * Normalize a raw model stream into internal ModelStreamEvent objects.
   */
  async *normalizeStream(
    stream: AsyncIterable<unknown>,
    provider: string,
    capabilities: ModelCapabilities,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    let buffer = "";

    for await (const chunk of stream) {
      if (typeof chunk === "string") {
        buffer += chunk;
      } else if (typeof chunk === "object" && chunk !== null) {
        const obj = chunk as Record<string, unknown>;
        const text = this.extractTextFromChunk(obj, provider);
        if (text) yield { type: "text" as const, text };

        const tc = this.extractToolCallFromChunk(obj, provider);
        if (tc) yield { type: "tool-call" as const, toolCall: tc };
      }
    }

    if (buffer.length > 0) {
      const extracted = this.extractor.extract(buffer, provider);
      if (extracted.text) {
        yield { type: "text", text: extracted.text };
      }
    }

    yield { type: "done" };
  }

  /**
   * Normalize a complete model response into internal AgentMessage format.
   */
  normalizeComplete(raw: unknown, provider: string): AgentMessage {
    if (!raw || typeof raw !== "object") {
      return { role: "assistant", content: String(raw) };
    }

    const obj = raw as Record<string, unknown>;
    let content = "";
    const toolCalls = [];

    if (typeof obj.content === "string") {
      content = obj.content;
    } else if (typeof obj.text === "string") {
      content = obj.text;
    }

    if (!content && typeof obj.response === "string") {
      const result = this.extractor.extract(obj.response, provider);
      return {
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      };
    }

    if (typeof obj.message === "object" && obj.message !== null) {
      const msg = obj.message as Record<string, unknown>;
      if (typeof msg.content === "string") content = msg.content;
    }

    return { role: "assistant", content };
  }

  private extractTextFromChunk(
    chunk: Record<string, unknown>,
    provider: string,
  ): string | null {
    switch (provider) {
      case "openai": {
        const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
        return choices?.[0]?.delta?.content ?? null;
      }
      case "anthropic": {
        if (chunk.type === "content_block_delta") {
          const delta = chunk.delta as { text?: string } | undefined;
          return delta?.text ?? null;
        }
        return null;
      }
      default:
        return (chunk.text as string) ?? (chunk.content as string) ?? null;
    }
  }

  private extractToolCallFromChunk(
    chunk: Record<string, unknown>,
    provider: string,
  ): { toolCallId: string; toolName: string; argumentsJson: string } | null {
    switch (provider) {
      case "openai": {
        const choices = chunk.choices as Array<{
          delta?: {
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }> | undefined;
        const tc = choices?.[0]?.delta?.tool_calls?.[0];
        if (tc?.function?.name) {
          return {
            toolCallId: tc.id ?? `tc-${Date.now()}`,
            toolName: tc.function.name,
            argumentsJson: tc.function.arguments ?? "{}",
          };
        }
        return null;
      }
      case "anthropic":
        return null;
      default: {
        if (chunk.tool_call) {
          const tc = chunk.tool_call as Record<string, unknown>;
          return {
            toolCallId: `tc-${Date.now()}`,
            toolName: String(tc.name ?? tc.tool ?? ""),
            argumentsJson: JSON.stringify(tc.arguments ?? tc.args ?? {}),
          };
        }
        return null;
      }
    }
  }
}
