import { loadConfigFromFile, loadMergedConfig } from "@metalmind/config";
import type { MetalmindConfig } from "@metalmind/schemas";

import type { UserConfig } from "@metalmind/config";

export interface TuiConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** True when the user explicitly chose a provider/model (CLI flag or env) → bypass auto-routing. */
  explicit: boolean;
  /** Global models and routing from config.json */
  models?: Record<string, string[]>;
  routing?: UserConfig["routing"];
  /** --continue: resume the most recent persisted session on launch. */
  continueSession?: boolean;
  /** --resume <id>: resume a specific persisted session on launch. */
  resumeSessionId?: string;
}

/** Resolve credentials/base URL for a provider from the environment.
 *  For ollama-cloud, also falls back to the "ollama" key in XDG config
 *  because users typically set their Ollama API key via the "ollama" provider UI. */
export function providerCredentials(provider: string): { apiKey?: string; baseUrl?: string } {
  const mergedConfig = loadMergedConfig();
  // For ollama-cloud, check both "ollama-cloud" and "ollama" keys (user may have set either).
  const configKey =
    mergedConfig.apiKeys[provider] ||
    (provider === "ollama-cloud" ? mergedConfig.apiKeys["ollama"] : undefined) ||
    undefined;
  const apiKey = resolveApiKey(provider, configKey);
  // Use the provider's own default/env (OLLAMA_HOST, OLLAMA_CLOUD_BASE_URL, MLX_BASE_URL).
  // METALMIND_BASE_URL is NOT applied here — it would wrongly repoint OTHER tiers'
  // providers (e.g. an escalated cloud model) at the active provider's URL (#234).
  return { apiKey, baseUrl: defaultBaseUrl(provider, apiKey) };
}

/**
 * Resolve a provider's API key. A **non-empty** environment variable wins over
 * the stored config key (12-factor: env overrides config/source, so a user can
 * fix auth without editing files or rebuilding). An unset or empty env var
 * (e.g. `OLLAMA_API_KEY=`) falls back to the config key rather than blanking it.
 */
export function resolveApiKey(provider: string, configKey?: string): string | undefined {
  const env = envApiKey(provider);
  if (env && env.trim().length > 0) return env;
  return configKey && configKey.length > 0 ? configKey : undefined;
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  ollama: "deepseek-coder:1.3b",
  "ollama-cloud": "glm-5.2:cloud",
  mlx: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
};

// Base URLs are overridable via env so users can repoint providers without
// touching source (e.g. a proxy, a self-hosted endpoint, a different cloud host).
const DEFAULT_MLX_BASE_URL = process.env.MLX_BASE_URL || "http://127.0.0.1:8742";
const OLLAMA_CLOUD_BASE_URL = process.env.OLLAMA_CLOUD_BASE_URL || "https://api.ollama.com";

function envApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "ollama" || provider === "ollama-cloud") return process.env.OLLAMA_API_KEY;
  if (provider === "mlx") return process.env.MLX_API_KEY;
  return undefined;
}

function defaultBaseUrl(provider: string, _apiKey?: string): string | undefined {
  // ollama-cloud = remote Ollama API (api.ollama.com)
  // ollama       = local Ollama daemon (localhost:11434) — NEVER route to cloud
  if (provider === "ollama-cloud") return OLLAMA_CLOUD_BASE_URL;
  if (provider === "ollama") return process.env.OLLAMA_HOST || undefined; // honor the standard Ollama env var
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
  let continueSession = false;
  let resumeSessionId = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && argv[i + 1]) cliProvider = argv[++i];
    else if (argv[i] === "--model" && argv[i + 1]) cliModel = argv[++i];
    else if (argv[i]?.startsWith("--provider=")) cliProvider = argv[i].slice(11);
    else if (argv[i]?.startsWith("--model=")) cliModel = argv[i].slice(8);
    else if (argv[i] === "--continue" || argv[i] === "-c") continueSession = true;
    else if (argv[i] === "--resume" && argv[i + 1] && !argv[i + 1].startsWith("-")) resumeSessionId = argv[++i];
    else if (argv[i]?.startsWith("--resume=")) resumeSessionId = argv[i].slice(9);
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
    const apiKey = resolveApiKey(provider, entry.apiKey);
    const baseUrl =
      process.env.METALMIND_BASE_URL ?? entry.baseUrl ?? defaultBaseUrl(provider, apiKey);
    return { provider, model: entry.model, apiKey, baseUrl, explicit, continueSession, resumeSessionId: resumeSessionId || undefined };
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
    // Auto-detect from env vars first: Ollama Cloud > Anthropic > OpenAI > local Ollama
    if (process.env.OLLAMA_API_KEY) {
      provider = "ollama-cloud";
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

  // An unknown provider (typo in --provider, a stale env var, or a config.json
  // from a newer/older build) has no PROVIDER_DEFAULTS entry, so rawModel was
  // `undefined` and the very next line threw a raw TypeError before the first
  // paint (#436). Fail with a message that names the valid values instead.
  if (!(provider in PROVIDER_DEFAULTS)) {
    throw new Error(
      `Unknown provider "${provider}". Valid providers: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}. ` +
        `Check --provider, METALMIND_PROVIDER, or "activeProvider" in your config.json.`,
    );
  }
  const rawModel = explicitModel || (explicitProvider || autoDetected ? PROVIDER_DEFAULTS[provider] : (mergedConfig.activeModel || PROVIDER_DEFAULTS[provider]));
  // Strip any accidental "provider/" prefix from the model name.
  const prefix = provider + "/";
  const model = rawModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
  // A non-empty env var wins over the stored config key (see resolveApiKey);
  // an empty/unset env var falls back to config.
  const apiKey = resolveApiKey(provider, mergedConfig.apiKeys[provider]);
  const baseUrl = process.env.METALMIND_BASE_URL ?? defaultBaseUrl(provider, apiKey);

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    explicit,
    models: mergedConfig.models,
    routing: mergedConfig.routing,
    continueSession,
    resumeSessionId: resumeSessionId || undefined,
  };
}
