import { loadConfigFromFile } from "@metalmind/config";
import type { MetalmindConfig } from "@metalmind/schemas";

export interface TuiConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  ollama: "deepseek-coder:1.3b",
  mlx: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
};

const DEFAULT_MLX_BASE_URL = "http://127.0.0.1:8742";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";

function envApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "ollama") return process.env.OLLAMA_API_KEY;
  return undefined;
}

function defaultBaseUrl(provider: string, apiKey?: string): string | undefined {
  if (provider === "ollama" && apiKey) return OLLAMA_CLOUD_BASE_URL;
  if (provider === "mlx") return DEFAULT_MLX_BASE_URL;
  return undefined;
}

/**
 * Resolve the active provider/model with precedence:
 * CLI flags > env vars > metalmind.yaml (named model / routing.defaultLocalModel) > built-in defaults.
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
    return { provider, model: entry.model, apiKey, baseUrl };
  }

  // Built-in resolution (no named model).
  let provider = explicitProvider;
  if (!provider) {
    if (process.env.ANTHROPIC_API_KEY) provider = "anthropic";
    else if (process.env.OPENAI_API_KEY) provider = "openai";
    else provider = "ollama";
  }

  const model = explicitModel || PROVIDER_DEFAULTS[provider] || "default";
  const apiKey = envApiKey(provider);
  const baseUrl = process.env.METALMIND_BASE_URL ?? defaultBaseUrl(provider, apiKey);

  return { provider, model, apiKey, baseUrl };
}
