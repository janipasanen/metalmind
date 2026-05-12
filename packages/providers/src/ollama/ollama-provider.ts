import type { ModelProvider, ModelCapabilities, ChatCompletionRequest, ChatCompletionResponse, ModelStreamEvent } from "@metalmind/core";

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

  async completeChat(_request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return { message: { role: "assistant", content: "" } };
  }

  async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ModelStreamEvent, void, undefined> {
    yield { type: "text", text: "Ollama streaming placeholder" };
    yield { type: "done" };
  }
}
