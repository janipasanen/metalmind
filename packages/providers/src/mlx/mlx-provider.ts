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
import { providerErrorFromResponse, ProviderError } from "../normalization/provider-error.js";
import { fetchWithTimeout, connectTimeoutFor } from "../normalization/fetch-with-timeout.js";
import { ToolCallExtractor } from "../normalization/tool-call-extractor.js";
import { roughTokenCountMessages } from "../normalization/token-estimate.js";

const mlxCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: false,
  supportsReasoning: false,
  supportsJsonMode: false,
  maximumContextTokens: 32_768,
};

export interface MlxSidecarConfig {
  baseUrl: string;
  model: string;
}

/** Neutral tool defs → the OpenAI function shape that chat templates expect. */
function toMlxTools(tools: unknown[]): Array<Record<string, unknown>> {
  return (tools as Array<{ name: string; description?: string; inputSchema?: unknown }>).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/** Streaming gate for tool-call syntax.
 *
 *  Tool calls arrive as ordinary TEXT tokens, so the raw
 *  `<tool_call>{…}</tool_call>` markup would be shown to the user before it
 *  could be recognised. This holds back any tail that might be the beginning of
 *  an opening tag (the same trick the secret redactor uses for split secrets)
 *  and releases it once it is clearly not one. */
const TOOL_OPEN = "<tool_call>";
function splitStreamable(buffer: string): { emit: string; keep: string } {
  const open = buffer.indexOf(TOOL_OPEN);
  if (open !== -1) return { emit: buffer.slice(0, open), keep: buffer.slice(open) };
  // No complete tag: withhold the longest suffix that could still become one.
  for (let n = Math.min(TOOL_OPEN.length - 1, buffer.length); n > 0; n--) {
    if (TOOL_OPEN.startsWith(buffer.slice(buffer.length - n))) {
      return { emit: buffer.slice(0, buffer.length - n), keep: buffer.slice(buffer.length - n) };
    }
  }
  return { emit: buffer, keep: "" };
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
      // The sidecar feeds these to the tokenizer's chat template, which is what
      // teaches the model the tool-call syntax to emit.
      ...(request.tools?.length ? { tools: toMlxTools(request.tools) } : {}),
    };

    const res = await fetchWithTimeout(`${this.config.baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, request.signal, connectTimeoutFor(this.config.baseUrl));

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "mlx", "MLX chat failed");
    }

    const data = (await res.json()) as {
      message?: { role: string; content: string };
      error?: string;
      usage?: { prompt_tokens: number; completion_tokens: number; duration_ms: number };
    };

    // Guard a malformed/error 200 body so we raise a clean provider error rather
    // than a raw TypeError on data.message.content (#244).
    if (data.error) {
      throw new ProviderError(`MLX chat failed: ${data.error}`);
    }
    if (!data.message) {
      throw new ProviderError("MLX chat returned no message");
    }

    const extracted = new ToolCallExtractor().extract(data.message.content ?? "", "mlx");
    return {
      message: {
        role: "assistant",
        content: extracted.text,
        ...(extracted.toolCalls.length ? { toolCalls: extracted.toolCalls } : {}),
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
      ...(request.tools?.length ? { tools: toMlxTools(request.tools) } : {}),
    };

    const res = await fetchWithTimeout(`${this.config.baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, request.signal, connectTimeoutFor(this.config.baseUrl));

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "mlx", "MLX stream failed");
    }
    if (!res.body) throw new Error("MLX response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Everything the model produced, for tool-call extraction at the end, plus
    // the not-yet-emittable tail held by the gate above.
    let raw = "";
    let held = "";
    const flushToolCalls = function* (this: void): Generator<ModelStreamEvent> {
      const extracted = new ToolCallExtractor().extract(raw, "mlx");
      // Anything held back that turned out NOT to be a tool call is real text.
      const leftover = extracted.text.slice(Math.min(extracted.text.length, raw.length - held.length));
      if (extracted.toolCalls.length === 0 && held) {
        yield { type: "text", text: held };
      } else if (extracted.toolCalls.length > 0 && leftover.trim()) {
        yield { type: "text", text: leftover };
      }
      for (const tc of extracted.toolCalls) {
        yield { type: "tool-call", toolCall: { toolCallId: tc.toolCallId, toolName: tc.toolName, argumentsJson: tc.argumentsJson } };
      }
    };

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
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };

            if (chunk.done) {
              yield* flushToolCalls();
              if (chunk.usage) {
                yield { type: "usage", usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens } };
              }
              yield { type: "done" };
              return;
            }

            if (chunk.message?.content) {
              raw += chunk.message.content;
              held += chunk.message.content;
              const { emit, keep } = splitStreamable(held);
              held = keep;
              if (emit) yield { type: "text", text: emit };
            }
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended without an explicit done marker.
    yield* flushToolCalls();
    yield { type: "done" };
  }

  async countTokens(request: TokenCountRequest): Promise<TokenCountResponse> {
    // MLX sidecar has no count endpoint; estimate instead of 0 (#170).
    return { tokenCount: roughTokenCountMessages(request.messages) };
  }

  async health(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.config.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false, message: "MLX sidecar not running" };
      const body = (await res.json().catch(() => ({}))) as { model_loaded?: boolean };
      if (body.model_loaded === false) return { ok: false, message: "MLX sidecar up but no model loaded" };
      return { ok: true, message: "mlx: ready" };
    } catch {
      return { ok: false, message: "MLX sidecar not running" };
    }
  }
}
