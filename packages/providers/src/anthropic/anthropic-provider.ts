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
import { fetchWithTimeout } from "../normalization/fetch-with-timeout.js";
import { roughTokenCountMessages } from "../normalization/token-estimate.js";

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

type AnthropicMsg = { role: string; content: string | Array<Record<string, unknown>> };

function safeParseInput(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Build the Anthropic request payload from the neutral history: hoist system
 * messages into the top-level `system` field, serialize assistant tool calls as
 * `tool_use` blocks, and tool results as `tool_result` blocks in a user message
 * (keyed by metadata.toolCallId). Consecutive same-role messages are coalesced
 * so the user/assistant alternation Anthropic requires is preserved.
 */
function buildAnthropicPayload(messages: AgentMessage[]): {
  system: string | undefined;
  messages: AnthropicMsg[];
} {
  let system: string | undefined;
  const out: AnthropicMsg[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = system ? `${system}\n\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === "tool") {
      const toolUseId = typeof msg.metadata?.["toolCallId"] === "string" ? (msg.metadata["toolCallId"] as string) : "";
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: msg.content }],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const tc of msg.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.toolCallId, name: tc.toolName, input: safeParseInput(tc.argumentsJson) });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    out.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
  }

  // Coalesce consecutive same-role messages (e.g. multiple tool_result blocks).
  const toBlocks = (c: AnthropicMsg["content"]): Array<Record<string, unknown>> =>
    Array.isArray(c) ? c : [{ type: "text", text: String(c) }];
  const merged: AnthropicMsg[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }

  return { system, messages: merged };
}

/** Map neutral tool defs to Anthropic's tool schema. */
function toAnthropicTools(tools: unknown[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return (tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
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
    const { system, messages } = buildAnthropicPayload(request.messages);

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: 4096,
      messages,
      stream: false,
    };
    // Prompt caching (#173): mark the stable prefix (system + tools) with
    // cache_control breakpoints so it isn't re-billed at full rate every turn.
    if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    const tools = toAnthropicTools(request.tools);
    if (tools && tools.length) {
      tools[tools.length - 1].cache_control = { type: "ephemeral" };
      body.tools = tools;
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "anthropic", "Anthropic chat failed");
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    const textContent = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    const message: AgentMessage = { role: "assistant", content: textContent };
    const toolUses = data.content.filter((c) => c.type === "tool_use");
    if (toolUses.length) {
      message.toolCalls = toolUses.map((c) => ({
        toolCallId: c.id ?? "",
        toolName: c.name ?? "",
        argumentsJson: JSON.stringify(c.input ?? {}),
      }));
    }
    return { message };
  }

  /** Discover available models from the Anthropic API (#214). Returns [] on failure. */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/v1/models`, {
        method: "GET",
        headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  async health(): Promise<{ ok: boolean; message: string }> {
    // A free, real validation: count_tokens on a tiny message verifies the key.
    if (!this.apiKey) return { ok: false, message: "Anthropic API key not set" };
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "token-counting-2024-11-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.modelName, messages: [{ role: "user", content: "hi" }] }),
      });
      if (res.status === 401) return { ok: false, message: "Invalid Anthropic API key" };
      if (res.status === 404) return { ok: false, message: `Anthropic model "${this.modelName}" not found` };
      if (!res.ok) return { ok: false, message: `Anthropic not reachable (${res.status})` };
      return { ok: true, message: "anthropic: key + model valid" };
    } catch {
      return { ok: false, message: "Anthropic not reachable" };
    }
  }

  /** Real token count via Anthropic's free count_tokens endpoint (#170). */
  async countTokens(request: TokenCountRequest): Promise<TokenCountResponse> {
    try {
      const { system, messages } = buildAnthropicPayload(request.messages);
      const body: Record<string, unknown> = { model: this.modelName, messages };
      if (system) body.system = system;
      const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "token-counting-2024-11-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { tokenCount: roughTokenCountMessages(request.messages) };
      const data = (await res.json()) as { input_tokens?: number };
      return { tokenCount: data.input_tokens ?? roughTokenCountMessages(request.messages) };
    } catch {
      return { tokenCount: roughTokenCountMessages(request.messages) };
    }
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const { system, messages } = buildAnthropicPayload(request.messages);

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: 4096,
      messages,
      stream: true,
    };
    // Prompt caching (#173): mark the stable prefix (system + tools) with
    // cache_control breakpoints so it isn't re-billed at full rate every turn.
    if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    const tools = toAnthropicTools(request.tools);
    if (tools && tools.length) {
      tools[tools.length - 1].cache_control = { type: "ephemeral" };
      body.tools = tools;
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "anthropic", "Anthropic stream failed");
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
              error?: { type?: string; message?: string };
              message?: { usage?: { input_tokens?: number } };
              usage?: { output_tokens?: number };
            };

            // Token usage: input_tokens on message_start, output_tokens on message_delta.
            if (chunk.type === "message_start" && chunk.message?.usage) {
              yield { type: "usage", usage: { inputTokens: chunk.message.usage.input_tokens } };
            }
            if (chunk.type === "message_delta" && chunk.usage) {
              yield { type: "usage", usage: { outputTokens: chunk.usage.output_tokens } };
            }

            // Anthropic emits {"type":"error","error":{...}} mid-stream (e.g.
            // overloaded_error) after a 200 OK; surface it instead of a silent done.
            if (chunk.type === "error") {
              const e = chunk.error;
              yield {
                type: "error",
                message: `Anthropic stream error: ${e?.message ?? e?.type ?? "unknown"}`,
              };
              return;
            }

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
