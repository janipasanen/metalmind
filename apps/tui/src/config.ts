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

export function resolveConfig(argv: string[] = process.argv.slice(2)): TuiConfig {
  let provider = process.env.METALMIND_PROVIDER ?? "";
  let model = process.env.METALMIND_MODEL ?? "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && argv[i + 1]) provider = argv[++i];
    else if (argv[i] === "--model" && argv[i + 1]) model = argv[++i];
    else if (argv[i]?.startsWith("--provider=")) provider = argv[i].slice(11);
    else if (argv[i]?.startsWith("--model=")) model = argv[i].slice(8);
  }

  // auto-detect provider from available API keys if not specified
  if (!provider) {
    if (process.env.ANTHROPIC_API_KEY) provider = "anthropic";
    else if (process.env.OPENAI_API_KEY) provider = "openai";
    else provider = "ollama";
  }

  if (!model) model = PROVIDER_DEFAULTS[provider] ?? "default";

  const apiKey =
    provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : provider === "openai"
        ? process.env.OPENAI_API_KEY
        : undefined;

  const baseUrl =
    process.env.METALMIND_BASE_URL ??
    (provider === "mlx" ? DEFAULT_MLX_BASE_URL : undefined);

  return { provider, model, apiKey, baseUrl };
}
