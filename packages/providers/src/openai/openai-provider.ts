import type { ModelProvider, ModelCapabilities, ChatCompletionRequest, ChatCompletionResponse, ModelStreamEvent } from "@metalmind/core";

const openaiCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: true,
  supportsReasoning: true,
  supportsJsonMode: true,
  maximumContextTokens: 256_000,
};

export class OpenAIProvider implements ModelProvider {
  readonly providerName = "openai";
  readonly supportedCapabilities = openaiCapabilities;
  private apiKey: string;
  private modelName: string;

  constructor(model: string, apiKey: string) {
    this.modelName = model;
    this.apiKey = apiKey;
  }

  async completeChat(_request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return { message: { role: "assistant", content: "" } };
  }

  async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ModelStreamEvent, void, undefined> {
    yield { type: "text", text: "OpenAI streaming placeholder" };
    yield { type: "done" };
  }
}
