import type { AgentMessage } from "@metalmind/schemas";

export interface ModelCapabilities {
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsJsonMode: boolean;
  readonly maximumContextTokens: number;
}

export interface ChatCompletionRequest {
  readonly messages: AgentMessage[];
  readonly tools?: unknown[];
  readonly stream?: boolean;
  /** Cancels the in-flight HTTP request when aborted (Esc-to-interrupt, timeouts). */
  readonly signal?: AbortSignal;
}

export type ModelStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCall: { toolCallId: string; toolName: string; argumentsJson: string } }
  | { type: "error"; message: string }
  | { type: "done" };

export interface TokenCountRequest {
  readonly messages: AgentMessage[];
}

export interface TokenCountResponse {
  readonly tokenCount: number;
}

export interface ChatCompletionResponse {
  readonly message: AgentMessage;
}

export interface ModelProvider {
  readonly providerName: string;
  readonly supportedCapabilities: ModelCapabilities;

  streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncIterable<ModelStreamEvent>;
  completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  countTokens?(request: TokenCountRequest): Promise<TokenCountResponse>;
}
