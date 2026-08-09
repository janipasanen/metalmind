import { loadXdgConfig } from "@metalmind/config";
import { OpenAIProvider, AnthropicProvider, OllamaProvider } from "@metalmind/providers";

/**
 * Startup/just-in-time model auto-discovery (#214). Queries the active provider's
 * API/daemon for available models and merges them with the configured static list,
 * so the pickers reflect what's actually available. Degrades to the static list on
 * any failure (no key, offline, etc.).
 */

/** Merge live + static model lists, de-duplicated, live entries first. */
export function mergeModels(live: string[], statics: string[]): string[] {
  return Array.from(new Set([...live, ...statics]));
}

export async function discoverModels(providerId: string): Promise<string[]> {
  const cfg = loadXdgConfig();
  const statics = cfg.models?.[providerId] ?? [];
  const apiKey = cfg.apiKeys?.[providerId] ?? "";
  let live: string[] = [];
  try {
    if (providerId === "ollama") {
      live = await new OllamaProvider("", "http://127.0.0.1:11434", apiKey || undefined).listModels();
    } else if (providerId === "ollama-cloud") {
      // The cloud tier was missing entirely, so /model and the picker only ever
      // showed the static config list — which is why model names had to be typed
      // by hand (and mistyped). api.ollama.com serves the same /api/tags shape.
      // The key may be stored under either id, matching providerCredentials.
      const key = apiKey || cfg.apiKeys?.ollama || process.env.OLLAMA_API_KEY || undefined;
      live = await new OllamaProvider(
        "",
        process.env.OLLAMA_CLOUD_BASE_URL || "https://api.ollama.com",
        key,
      ).listModels();
    } else if (providerId === "openai") {
      live = await new OpenAIProvider("gpt-4o", apiKey).listModels();
    } else if (providerId === "anthropic") {
      live = await new AnthropicProvider("claude-sonnet-4-6", apiKey).listModels();
    }
  } catch {
    live = [];
  }
  return mergeModels(live, statics);
}
