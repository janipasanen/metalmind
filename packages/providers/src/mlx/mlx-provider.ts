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
import { providerErrorFromResponse } from "../normalization/provider-error.js";

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

  async healthCheck(): Promise<{
    status: string;
    modelLoaded: boolean;
    model: string | null;
    platform: string | null;
  }> {
    const res = await fetch(`${this.config.baseUrl}/health`);
    const data = (await res.json()) as {
      status?: string;
      model_loaded?: boolean;
      model?: string | null;
      platform?: string | null;
    };
    return {
      status: data.status ?? "unknown",
      modelLoaded: data.model_loaded ?? false,
      model: data.model ?? null,
      platform: data.platform ?? null,
    };
  }

  /**
   * Probe the sidecar and return a human-readable GPU readiness status.
   * Distinguishes: sidecar down, sidecar up but no model loaded, and ready.
   */
  async readiness(): Promise<{ ready: boolean; message: string }> {
    try {
      const health = await this.healthCheck();
      if (!health.modelLoaded) {
        return {
          ready: false,
          message: `MLX sidecar up (${health.platform ?? "unknown platform"}) but no model loaded — it will load "${this.config.model}" on first use`,
        };
      }
      return {
        ready: true,
        message: `MLX GPU ready: ${health.model} (${health.platform ?? "unknown platform"})`,
      };
    } catch {
      return {
        ready: false,
        message:
          "MLX sidecar not reachable — start it with: python scripts/mlx-sidecar.py",
      };
    }
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
      signal: request.signal,
    });

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "mlx", "MLX chat failed");
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
      signal: request.signal,
    });

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "mlx", "MLX stream failed");
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
