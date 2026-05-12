import type {
  ModelProvider,
  ModelCapabilities,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelStreamEvent,
  TokenCountRequest,
  TokenCountResponse,
} from "@metalmind/core";
import type { AgentMessage } from "@metalmind/schemas";

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
}

interface OllamaChatResponse {
  message: OllamaMessage;
  created_at?: string;
  done?: boolean;
  done_reason?: string;
}

const ollamaCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: false,
  supportsReasoning: false,
  supportsJsonMode: true,
  maximumContextTokens: 128_000,
};

export class OllamaProvider implements ModelProvider {
  readonly providerName = "ollama";
  readonly supportedCapabilities = ollamaCapabilities;
  private baseUrl: string;
  private modelName: string;

  constructor(model: string, baseUrl = "http://127.0.0.1:11434") {
    this.modelName = model;
    this.baseUrl = baseUrl;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.map((m) => m.name);
  }

  async completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const ollamaMessages = this.convertMessages(request.messages);
    const body: OllamaChatRequest = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: false,
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    return {
      message: {
        role: "assistant",
        content: data.message.content,
      },
    };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const ollamaMessages = this.convertMessages(request.messages);
    const body: OllamaChatRequest = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama stream failed: ${res.status} ${await res.text()}`);
    }

    if (!res.body) {
      throw new Error("Ollama response has no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line) as OllamaChatResponse & { done?: boolean };

            if (data.done) {
              yield { type: "done" };
              return;
            }

            if (data.message?.content) {
              yield { type: "text", text: data.message.content };
            }
          } catch {
            continue;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer) as OllamaChatResponse & { done?: boolean };
          if (data.message?.content) {
            yield { type: "text", text: data.message.content };
          }
        } catch {
          // ignore partial buffer
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done" };
  }

  async countTokens(_request: TokenCountRequest): Promise<TokenCountResponse> {
    return { tokenCount: 0 };
  }

  private convertMessages(messages: AgentMessage[]): OllamaMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }
}
