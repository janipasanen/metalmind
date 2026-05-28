import { loadConfigFromFile, loadMergedConfig } from "@metalmind/config";
import type { MetalmindConfig } from "@metalmind/schemas";

export interface TuiConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** True when the user explicitly chose a provider/model (CLI flag or env) → bypass auto-routing. */
  explicit: boolean;
}

/** Resolve credentials/base URL for a provider from the environment. */
export function providerCredentials(provider: string): { apiKey?: string; baseUrl?: string } {
  const apiKey = envApiKey(provider);
  const mergedConfig = loadMergedConfig();
  const apiKeyFromConfig = mergedConfig.apiKeys[provider] || undefined;
  return { apiKey: apiKeyFromConfig ?? apiKey, baseUrl: process.env.METALMIND_BASE_URL ?? defaultBaseUrl(provider, apiKeyFromConfig ?? apiKey) };
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  ollama: "gemini-3-flash-preview:cloud",
  mlx: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
};

const DEFAULT_MLX_BASE_URL = "http://127.0.0.1:8742";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";

function envApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "ollama") return process.env.OLLAMA_API_KEY;
  if (provider === "mlx") return process.env.MLX_API_KEY;
  return undefined;
}

function defaultBaseUrl(provider: string, apiKey?: string): string | undefined {
  if (provider === "ollama" && apiKey) return OLLAMA_CLOUD_BASE_URL;
  if (provider === "mlx") return DEFAULT_MLX_BASE_URL;
  return undefined;
}

/**
 * Resolve the active provider/model with precedence:
 * CLI flags > env vars > project metalmind.yaml > merged global config > built-in defaults.
 *
 * `fileConfig` is injectable for testing; in production it loads metalmind.yaml from cwd upward.
 */
export function resolveConfig(
  argv: string[] = process.argv.slice(2),
  fileConfig: MetalmindConfig = loadConfigFromFile(),
): TuiConfig {
  let cliProvider = "";
  let cliModel = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && argv[i + 1]) cliProvider = argv[++i];
    else if (argv[i] === "--model" && argv[i + 1]) cliModel = argv[++i];
    else if (argv[i]?.startsWith("--provider=")) cliProvider = argv[i].slice(11);
    else if (argv[i]?.startsWith("--model=")) cliModel = argv[i].slice(8);
  }

  const explicitProvider = cliProvider || process.env.METALMIND_PROVIDER || "";
  const explicitModel = cliModel || process.env.METALMIND_MODEL || "";

  const mergedConfig = loadMergedConfig();
  const explicit = Boolean(explicitProvider || explicitModel);
  const models = fileConfig.models ?? {};

  // A named-model reference resolves to a metalmind.yaml `models` entry.
  // Use the explicitly-named model if it matches an entry, otherwise fall back
  // to routing.defaultLocalModel when nothing was specified at all.
  const defaultLocal = fileConfig.routing?.defaultLocalModel;
  const namedKey =
    explicitModel && models[explicitModel]
      ? explicitModel
      : !explicitModel && !explicitProvider && defaultLocal && models[defaultLocal]
        ? defaultLocal
        : undefined;

  if (namedKey) {
    const entry = models[namedKey];
    const provider = explicitProvider || entry.provider;
    const apiKey = envApiKey(provider) ?? entry.apiKey;
    const baseUrl =
      process.env.METALMIND_BASE_URL ?? entry.baseUrl ?? defaultBaseUrl(provider, apiKey);
    return { provider, model: entry.model, apiKey, baseUrl, explicit };
  }

  // Built-in resolution (no named model).
  // Priority: CLI/env > global config > auto-detect from env vars > built-in defaults
  let provider: string;
  let autoDetected = false;
  
  if (explicitProvider) {
    // CLI/env explicitly chose a provider
    provider = explicitProvider;
  } else if (mergedConfig.activeProvider) {
    // Global config has a saved preference
    provider = mergedConfig.activeProvider;
  } else {
    // Auto-detect from env vars first: Ollama > Anthropic > OpenAI
    if (process.env.OLLAMA_API_KEY) {
      provider = "ollama";
      autoDetected = true;
    } else if (process.env.ANTHROPIC_API_KEY) {
      provider = "anthropic";
      autoDetected = true;
    } else if (process.env.OPENAI_API_KEY) {
      provider = "openai";
      autoDetected = true;
    } else {
      provider = "ollama";
    }
  }

  const rawModel = explicitModel || (explicitProvider || autoDetected ? PROVIDER_DEFAULTS[provider] : (mergedConfig.activeModel || PROVIDER_DEFAULTS[provider]));
  // Strip any accidental "provider/" prefix from the model name.
  const prefix = provider + "/";
  const model = rawModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
  const apiKey = envApiKey(provider) ?? mergedConfig.apiKeys[provider];
  const baseUrl = process.env.METALMIND_BASE_URL ?? defaultBaseUrl(provider, apiKey ?? mergedConfig.apiKeys[provider]);

  return { provider, model, apiKey, baseUrl, explicit };
}
