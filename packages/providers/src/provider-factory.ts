import type { ModelProvider } from "@metalmind/core";
import { OllamaProvider } from "./ollama/ollama-provider.js";
import { OpenAIProvider } from "./openai/openai-provider.js";
import { AnthropicProvider } from "./anthropic/anthropic-provider.js";

export function createProvider(
  provider: string,
  model: string,
  options?: { apiKey?: string; baseUrl?: string },
): ModelProvider {
  switch (provider) {
    case "ollama":
      return new OllamaProvider(model, options?.baseUrl);
    case "openai":
      if (!options?.apiKey) throw new Error("openai requires apiKey");
      return new OpenAIProvider(model, options.apiKey);
    case "anthropic":
      if (!options?.apiKey) throw new Error("anthropic requires apiKey");
      return new AnthropicProvider(model, options.apiKey);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
