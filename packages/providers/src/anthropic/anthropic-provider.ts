import type {
  ModelProvider,
  ModelCapabilities,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelStreamEvent,
} from "@metalmind/core";
import type { AgentMessage } from "@metalmind/schemas";

const anthropicCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: true,
  supportsReasoning: true,
  supportsJsonMode: false,
  maximumContextTokens: 200_000,
};

interface AnthropicContent {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  role: string;
  content: AnthropicContent[];
}

interface AnthropicStreamDelta {
  type: string;
  text?: string;
  delta?: {
    type: string;
    text?: string;
  };
}

function convertToAnthropicMessages(
  messages: AgentMessage[],
): Array<{ role: string; content: string | Array<Record<string, unknown>> }> {
  return messages.map((msg) => ({
    role: msg.role === "assistant" || msg.role === "user" ? msg.role : "user",
    content: msg.content,
  }));
}

export class AnthropicProvider implements ModelProvider {
  readonly providerName = "anthropic";
  readonly supportedCapabilities = anthropicCapabilities;
  private apiKey: string;
  private modelName: string;
  private baseUrl: string;

  constructor(
    model: string,
    apiKey: string,
    baseUrl = "https://api.anthropic.com",
  ) {
    this.modelName = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async completeChat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const messages = convertToAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: 4096,
      messages,
      stream: false,
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Anthropic chat failed: ${res.status} ${await res.text()}`,
      );
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    const textContent = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    return { message: { role: "assistant", content: textContent } };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const messages = convertToAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: 4096,
      messages,
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Anthropic stream failed: ${res.status} ${await res.text()}`,
      );
    }
    if (!res.body) throw new Error("Anthropic response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Track tool_use content blocks by their stream index while their
    // input JSON arrives incrementally as input_json_delta fragments.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);

          try {
            const chunk = JSON.parse(jsonStr) as {
              type: string;
              index?: number;
              content_block?: { type: string; id?: string; name?: string };
              delta?: AnthropicStreamDelta & { type?: string; partial_json?: string };
            };

            if (
              chunk.type === "content_block_start" &&
              chunk.content_block?.type === "tool_use"
            ) {
              toolBlocks.set(chunk.index ?? 0, {
                id: chunk.content_block.id ?? `anthropic-tc-${chunk.index ?? 0}`,
                name: chunk.content_block.name ?? "",
                json: "",
              });
              continue;
            }

            if (chunk.type === "content_block_delta") {
              if (chunk.delta?.type === "input_json_delta") {
                const block = toolBlocks.get(chunk.index ?? 0);
                if (block) block.json += chunk.delta.partial_json ?? "";
                continue;
              }
              const textChunk: string =
                chunk.delta?.text ?? chunk.delta?.delta?.text ?? "";
              if (textChunk) yield { type: "text", text: textChunk };
              continue;
            }

            if (chunk.type === "content_block_stop") {
              const block = toolBlocks.get(chunk.index ?? 0);
              if (block && block.name) {
                yield {
                  type: "tool-call",
                  toolCall: {
                    toolCallId: block.id,
                    toolName: block.name,
                    argumentsJson: block.json || "{}",
                  },
                };
                toolBlocks.delete(chunk.index ?? 0);
              }
            }
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done" };
  }
}
