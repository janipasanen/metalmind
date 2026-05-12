import type { ModelProvider, ModelCapabilities, ChatCompletionRequest, ChatCompletionResponse, ModelStreamEvent } from "@metalmind/core";

const anthropicCapabilities: ModelCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: true,
  supportsReasoning: true,
  supportsJsonMode: false,
  maximumContextTokens: 200_000,
};

export class AnthropicProvider implements ModelProvider {
  readonly providerName = "anthropic";
  readonly supportedCapabilities = anthropicCapabilities;
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
    yield { type: "text", text: "Anthropic streaming placeholder" };
    yield { type: "done" };
  }
}
