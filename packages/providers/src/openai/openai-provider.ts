import type {
  ModelProvider,
  ModelCapabilities,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelStreamEvent,
} from "@metalmind/core";
import type { AgentMessage } from "@metalmind/schemas";

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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `OpenAI chat failed: ${res.status} ${await res.text()}`,
      );
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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `OpenAI stream failed: ${res.status} ${await res.text()}`,
      );
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
}
