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
import { exactTokenCountMessages } from "../normalization/token-estimate.js";

const openaiCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: true,
  supportsReasoning: true,
  supportsJsonMode: true,
  maximumContextTokens: 256_000,
};

function convertToOpenAIMessage(msg: AgentMessage) {
  const m: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  // Vision: serialize image attachments as multimodal content parts (#177).
  if (msg.images?.length && msg.role === "user") {
    m.content = [
      ...(msg.content ? [{ type: "text", text: msg.content }] : []),
      ...msg.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
  }
  if (msg.toolCalls?.length) {
    m.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.toolCallId,
      type: "function",
      function: {
        name: tc.toolName,
        arguments: tc.argumentsJson,
      },
    }));
  }
  // OpenAI requires `tool_call_id` on tool-role messages to pair a result with
  // its call; without it the second request 400s. The agent loop stores the id
  // in metadata.toolCallId (mirrors the Ollama fix).
  if (msg.role === "tool") {
    const id = msg.metadata?.["toolCallId"];
    if (typeof id === "string") m.tool_call_id = id;
  }
  return m;
}

export class OpenAIProvider implements ModelProvider {
  readonly providerName = "openai";
  readonly supportedCapabilities = openaiCapabilities;
  private apiKey: string;
  private modelName: string;
  private baseUrl: string;

  constructor(
    model: string,
    apiKey: string,
    baseUrl = "https://api.openai.com/v1",
  ) {
    this.modelName = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async completeChat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const messages = request.messages.map(convertToOpenAIMessage);

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
    };
    if (request.tools) body.tools = request.tools;

    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "openai", "OpenAI chat failed");
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices[0];
    const agentMessage: AgentMessage = {
      role: "assistant",
      content: choice.message.content ?? "",
    };

    if (choice.message.tool_calls?.length) {
      agentMessage.toolCalls = choice.message.tool_calls.map((tc) => ({
        toolCallId: tc.id,
        toolName: tc.function.name,
        argumentsJson: tc.function.arguments,
      }));
    }

    return { message: agentMessage };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const messages = request.messages.map(convertToOpenAIMessage);

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools) body.tools = request.tools;

    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "openai", "OpenAI stream failed");
    }
    if (!res.body) throw new Error("OpenAI response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulate streamed tool-call fragments, keyed by their index.
    const toolAccumulator = new Map<
      number,
      { id?: string; name?: string; args: string }
    >();

    const flushToolCalls = (): ModelStreamEvent[] => {
      const events: ModelStreamEvent[] = [];
      for (const [index, tc] of [...toolAccumulator.entries()].sort((a, b) => a[0] - b[0])) {
        if (!tc.name) continue;
        events.push({
          type: "tool-call",
          toolCall: {
            toolCallId: tc.id ?? `openai-tc-${index}`,
            toolName: tc.name,
            argumentsJson: tc.args || "{}",
          },
        });
      }
      toolAccumulator.clear();
      return events;
    };

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
          if (jsonStr === "[DONE]") {
            for (const event of flushToolCalls()) yield event;
            yield { type: "done" };
            return;
          }

          try {
            const chunk = JSON.parse(jsonStr) as {
              error?: { message?: string } | string;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };

            // A mid-stream error chunk arrives after a 200 OK; surface it
            // instead of ending the turn as if it succeeded.
            if (chunk.error) {
              const msg =
                typeof chunk.error === "string"
                  ? chunk.error
                  : chunk.error.message ?? JSON.stringify(chunk.error);
              yield { type: "error", message: `OpenAI stream error: ${msg}` };
              return;
            }

            if (chunk.usage) {
              yield {
                type: "usage",
                usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens },
              };
            }

            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              yield { type: "text", text: delta.content };
            }
            for (const tc of delta?.tool_calls ?? []) {
              const index = tc.index ?? 0;
              const existing = toolAccumulator.get(index) ?? { args: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolAccumulator.set(index, existing);
            }
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    for (const event of flushToolCalls()) yield event;
    yield { type: "done" };
  }

  /**
   * Token estimate (#170). OpenAI has no free count endpoint and an exact
   * tiktoken tokenizer would add ~1.5MB of BPE data to the bundle, so we use a
   * blended estimate rather than a hard-coded 0; real output counts still flow
   * from the streamed usage chunk.
   */
  async countTokens(request: TokenCountRequest): Promise<TokenCountResponse> {
    // Exact BPE count for OpenAI models; falls back to the heuristic if the
    // tokenizer isn't installed (#212).
    return { tokenCount: await exactTokenCountMessages(request.messages) };
  }

  /** Discover available chat models from the OpenAI API (#214). Returns [] on failure. */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => /^(gpt|o1|o3|chatgpt)/i.test(id))
        .sort();
    } catch {
      return [];
    }
  }

  async health(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) return { ok: false, message: "OpenAI API key not set" };
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) return { ok: false, message: "Invalid OpenAI API key" };
      if (!res.ok) return { ok: false, message: `OpenAI not reachable (${res.status})` };
      return { ok: true, message: "openai: key valid" };
    } catch {
      return { ok: false, message: "OpenAI not reachable" };
    }
  }
}
