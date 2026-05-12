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

const mlxCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: false,
  supportsVision: false,
  supportsReasoning: false,
  supportsJsonMode: false,
  maximumContextTokens: 32_768,
};

export interface MlxSidecarConfig {
  baseUrl: string;
  model: string;
}

export class MlxProvider implements ModelProvider {
  readonly providerName = "mlx";
  readonly supportedCapabilities = mlxCapabilities;
  private config: MlxSidecarConfig;

  constructor(config: MlxSidecarConfig) {
    this.config = config;
  }

  async healthCheck(): Promise<{ status: string; modelLoaded: boolean; model: string | null }> {
    const res = await fetch(`${this.config.baseUrl}/health`);
    return res.json() as Promise<{ status: string; modelLoaded: boolean; model: string | null }>;
  }

  async loadModel(model?: string): Promise<void> {
    const modelPath = model ?? this.config.model;
    const res = await fetch(`${this.config.baseUrl}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelPath }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`MLX load failed: ${res.status} ${err}`);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.config.baseUrl}/models`);
      const data = (await res.json()) as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  async completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = {
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      max_tokens: 2048,
      temperature: 0.7,
    };

    const res = await fetch(`${this.config.baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`MLX chat failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      message: { role: string; content: string };
      usage?: { prompt_tokens: number; completion_tokens: number; duration_ms: number };
    };

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
    const body = {
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 2048,
      temperature: 0.7,
    };

    const res = await fetch(`${this.config.baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`MLX stream failed: ${res.status} ${await res.text()}`);
    }
    if (!res.body) throw new Error("MLX response has no body");

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
            const chunk = JSON.parse(line) as {
              message?: { content: string };
              done?: boolean;
            };

            if (chunk.done) {
              yield { type: "done" };
              return;
            }

            if (chunk.message?.content) {
              yield { type: "text", text: chunk.message.content };
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

  async countTokens(_request: TokenCountRequest): Promise<TokenCountResponse> {
    return { tokenCount: 0 };
  }
}
