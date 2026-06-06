import type { ModelProvider } from "@metalmind/core";
import { OllamaProvider } from "./ollama/ollama-provider.js";
import { OpenAIProvider } from "./openai/openai-provider.js";
import { AnthropicProvider } from "./anthropic/anthropic-provider.js";
import { MlxProvider } from "./mlx/mlx-provider.js";

export const DEFAULT_MLX_BASE_URL = "http://127.0.0.1:8742";
export const DEFAULT_OLLAMA_CLOUD_URL = "https://api.ollama.com";

export function createProvider(
  provider: string,
  model: string,
  options?: { apiKey?: string; baseUrl?: string },
): ModelProvider {
  switch (provider) {
    case "ollama":
      return new OllamaProvider(model, options?.baseUrl, options?.apiKey);
    case "ollama-cloud": {
      const apiKey = options?.apiKey;
      const baseUrl = options?.baseUrl ?? DEFAULT_OLLAMA_CLOUD_URL;
      return new OllamaProvider(model, baseUrl, apiKey);
    }
    case "openai":
      if (!options?.apiKey) throw new Error("openai requires apiKey");
      return new OpenAIProvider(model, options.apiKey, options.baseUrl);
    case "anthropic":
      if (!options?.apiKey) throw new Error("anthropic requires apiKey");
      return new AnthropicProvider(model, options.apiKey, options.baseUrl);
    case "mlx":
      return new MlxProvider({
        baseUrl: options?.baseUrl ?? DEFAULT_MLX_BASE_URL,
        model,
      });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
