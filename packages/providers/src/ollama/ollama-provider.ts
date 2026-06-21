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
import { fetchWithTimeout } from "../normalization/fetch-with-timeout.js";
import { roughTokenCountMessages } from "../normalization/token-estimate.js";
import { JsonRepair } from "../normalization/json-repair.js";

interface OllamaMessage {
  role: string;
  content: string;
  /** Correlation id for a tool result, paired with the assistant tool_call's id.
   *  Gemini (via Ollama Cloud) keys each call's thought_signature to this id and
   *  returns a 400 if the call/response pair can't be matched on a follow-up turn. */
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

function safeParseArgs(json: string): Record<string, unknown> {
  if (!json || !json.trim()) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Don't silently coerce malformed args to {} — try repairing common model
    // JSON quirks (trailing commas, single quotes, unquoted keys) first (#175).
    try {
      const parsed = JSON.parse(JsonRepair.repair(json)) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  /** Keep the model resident between turns so repeat requests skip the reload (#213). */
  keep_alive?: string;
}

/** How long Ollama keeps the model loaded after a request (avoids cold reloads). */
const OLLAMA_KEEP_ALIVE = "10m";

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
  private apiKey?: string;
  private toolCallCounter = 0;

  constructor(model: string, baseUrl = "http://127.0.0.1:11434", apiKey?: string) {
    // Strip accidental "ollama/" namespace prefix — Ollama API expects bare model names.
    this.modelName = model.startsWith("ollama/") ? model.slice(7) : model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { headers: this.headers() });
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.map((m) => m.name);
  }

  /** List installed models with size + last-modified, for model management (#203). */
  async listModelsDetailed(): Promise<Array<{ name: string; size: number; modified: string }>> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { headers: this.headers() });
    if (!res.ok) throw await providerErrorFromResponse(res, "ollama", "Ollama list models failed");
    const data = (await res.json()) as {
      models: Array<{ name: string; size?: number; modified_at?: string }>;
    };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      size: m.size ?? 0,
      modified: m.modified_at ?? "",
    }));
  }

  /** Pull a model, streaming progress events from the Ollama daemon (#203). */
  async *pullModel(name: string): AsyncGenerator<{ status: string; completed?: number; total?: number }> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: name, stream: true }),
    });
    if (!res.ok || !res.body) throw await providerErrorFromResponse(res, "ollama", "Ollama pull failed");
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
            yield JSON.parse(line) as { status: string; completed?: number; total?: number };
          } catch {
            // ignore malformed progress lines
          }
        }
      }
    } finally {
      // Release the stream even if the consumer stops iterating early (#271).
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  /** Delete an installed model (#203). */
  async deleteModel(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/delete`, {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify({ model: name }),
    });
    if (!res.ok) throw await providerErrorFromResponse(res, "ollama", "Ollama delete failed");
  }

  async completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const ollamaMessages = this.convertMessages(request.messages);
    const body: OllamaChatRequest = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
    };

    // Forward tools so non-streaming calls can request tool use too (#222).
    if (request.tools && request.tools.length > 0) {
      type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
      body.tools = (request.tools as ToolDef[]).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "ollama", "Ollama chat failed");
    }

    const data = (await res.json()) as OllamaChatResponse & { error?: string };
    // A 200 can still carry an {error} body or omit `message`; surface a clean
    // provider error instead of throwing a raw TypeError on data.message (#244).
    if (data.error) {
      throw new ProviderError(`Ollama chat failed: ${data.error}`);
    }
    if (!data.message) {
      throw new ProviderError("Ollama chat returned no message");
    }
    const message: AgentMessage = { role: "assistant", content: data.message.content ?? "" };
    // Surface tool calls the model returned, matching the streaming path (#222).
    // Skip malformed entries (missing function/name) rather than emit a bad call.
    if (data.message.tool_calls?.length) {
      const calls = data.message.tool_calls
        .filter((tc) => typeof tc?.function?.name === "string" && tc.function.name)
        .map((tc) => ({
          toolCallId: tc.id ?? `ollama-tc-${this.toolCallCounter++}`,
          toolName: tc.function.name,
          argumentsJson: JSON.stringify(tc.function.arguments ?? {}),
        }));
      if (calls.length > 0) message.toolCalls = calls;
    }
    return { message };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const ollamaMessages = this.convertMessages(request.messages);
    const body: OllamaChatRequest = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
    };

    if (request.tools && request.tools.length > 0) {
      type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
      body.tools = (request.tools as ToolDef[]).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      throw await providerErrorFromResponse(res, "ollama", "Ollama stream failed");
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
            const data = JSON.parse(line) as OllamaChatResponse & {
              done?: boolean;
              error?: string;
              prompt_eval_count?: number;
              eval_count?: number;
            };

            // Ollama reports mid-stream failures as a {"error":"..."} line after
            // a 200 OK; surface it instead of ending the turn as success.
            if (data.error) {
              yield { type: "error", message: `Ollama stream error: ${data.error}` };
              return;
            }

            if (data.message?.content) {
              yield { type: "text", text: data.message.content };
            }

            for (const tc of data.message?.tool_calls ?? []) {
              if (typeof tc?.function?.name !== "string" || !tc.function.name) continue; // skip malformed (#244)
              yield {
                type: "tool-call",
                toolCall: {
                  toolCallId: tc.id ?? `ollama-tc-${this.toolCallCounter++}`,
                  toolName: tc.function.name,
                  argumentsJson: JSON.stringify(tc.function.arguments ?? {}),
                },
              };
            }

            if (data.done) {
              if (data.prompt_eval_count != null || data.eval_count != null) {
                yield { type: "usage", usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count } };
              }
              yield { type: "done" };
              return;
            }
          } catch {
            continue;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer) as OllamaChatResponse & {
            done?: boolean;
            error?: string;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          if (data.error) {
            yield { type: "error", message: `Ollama stream error: ${data.error}` };
            return;
          }
          if (data.prompt_eval_count != null || data.eval_count != null) {
            yield { type: "usage", usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count } };
          }
          if (data.message?.content) {
            yield { type: "text", text: data.message.content };
          }
          for (const tc of data.message?.tool_calls ?? []) {
            if (typeof tc?.function?.name !== "string" || !tc.function.name) continue; // skip malformed (#244)
            yield {
              type: "tool-call",
              toolCall: {
                toolCallId: tc.id ?? `ollama-tc-${this.toolCallCounter++}`,
                toolName: tc.function.name,
                argumentsJson: JSON.stringify(tc.function.arguments ?? {}),
              },
            };
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

  async countTokens(request: TokenCountRequest): Promise<TokenCountResponse> {
    // Ollama exposes no count endpoint; use an estimate instead of 0 (#170).
    return { tokenCount: roughTokenCountMessages(request.messages) };
  }

  async health(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, message: `Ollama not reachable (${res.status}) at ${this.baseUrl}` };
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (data.models ?? []).map((m) => m.name);
      const family = this.modelName.split(":")[0];
      if (names.includes(this.modelName) || names.some((n) => n.split(":")[0] === family)) {
        return { ok: true, message: `ollama: ${this.modelName} available` };
      }
      return { ok: false, message: `Model "${this.modelName}" not pulled. Run: ollama pull ${this.modelName}` };
    } catch {
      return { ok: false, message: `Ollama not reachable at ${this.baseUrl} (is it running?)` };
    }
  }

  private convertMessages(messages: AgentMessage[]): OllamaMessage[] {
    return messages.map((msg) => {
      const out: OllamaMessage = { role: msg.role, content: msg.content };
      if (msg.toolCalls?.length) {
        out.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          function: {
            name: tc.toolName,
            arguments: safeParseArgs(tc.argumentsJson),
          },
        }));
      }
      // Echo the tool-call correlation id back on tool results. Gemini (via
      // Ollama Cloud) keys each function call's thought_signature to this id and
      // rejects the follow-up turn with a 400 if the pair can't be matched.
      const toolCallId = msg.metadata?.["toolCallId"];
      if (msg.role === "tool" && typeof toolCallId === "string") {
        out.tool_call_id = toolCallId;
      }
      return out;
    });
  }
}
