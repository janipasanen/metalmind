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

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

  async completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const ollamaMessages = this.convertMessages(request.messages);
    const body: OllamaChatRequest = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: false,
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
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

    if (request.tools && request.tools.length > 0) {
      type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
      body.tools = (request.tools as ToolDef[]).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
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

            if (data.message?.content) {
              yield { type: "text", text: data.message.content };
            }

            for (const tc of data.message?.tool_calls ?? []) {
              yield {
                type: "tool-call",
                toolCall: {
                  toolCallId: `ollama-tc-${this.toolCallCounter++}`,
                  toolName: tc.function.name,
                  argumentsJson: JSON.stringify(tc.function.arguments ?? {}),
                },
              };
            }

            if (data.done) {
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
          const data = JSON.parse(buffer) as OllamaChatResponse & { done?: boolean };
          if (data.message?.content) {
            yield { type: "text", text: data.message.content };
          }
          for (const tc of data.message?.tool_calls ?? []) {
            yield {
              type: "tool-call",
              toolCall: {
                toolCallId: `ollama-tc-${this.toolCallCounter++}`,
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

  async countTokens(_request: TokenCountRequest): Promise<TokenCountResponse> {
    return { tokenCount: 0 };
  }

  private convertMessages(messages: AgentMessage[]): OllamaMessage[] {
    return messages.map((msg) => {
      const out: OllamaMessage = { role: msg.role, content: msg.content };
      if (msg.toolCalls?.length) {
        out.tool_calls = msg.toolCalls.map((tc) => ({
          function: {
            name: tc.toolName,
            arguments: safeParseArgs(tc.argumentsJson),
          },
        }));
      }
      return out;
    });
  }
}
