import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { MetalmindConfigSchema, type MetalmindConfig } from "@metalmind/schemas";
import { loadMergedConfig, saveGlobalConfig } from "./merged-config.js";

export const CONFIG_FILE = "metalmind.yaml";
export const XDG_CONFIG_DIR = join(homedir(), ".config", "metalmind");
export const XDG_CONFIG_FILE = join(XDG_CONFIG_DIR, "config.json");

export const defaultConfig: MetalmindConfig = {
  models: {},
};

export function loadConfig(raw: unknown): MetalmindConfig {
  if (!raw || typeof raw !== "object") return structuredClone(defaultConfig);
  const parsed = MetalmindConfigSchema.safeParse(raw);
  if (!parsed.success) return structuredClone(defaultConfig);
  return parsed.data;
}

export function loadConfigFromFile(
  directory: string = process.cwd(),
): MetalmindConfig {
  const configPath = findConfigFile(directory);
  if (!configPath) return structuredClone(defaultConfig);

  const raw = readFileSync(configPath, "utf-8");
  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch {
    return structuredClone(defaultConfig);
  }

  if (!data || typeof data !== "object") return structuredClone(defaultConfig);
  const parsed = MetalmindConfigSchema.safeParse(data);
  if (!parsed.success) return structuredClone(defaultConfig);
  return parsed.data;
}

function findConfigFile(startDir: string): string | null {
  let current = startDir;
  const root = "/";

  while (true) {
    const configPath = join(current, CONFIG_FILE);
    if (existsSync(configPath)) return configPath;

    const parent = dirname(current);
    if (parent === current || current === root) return null;
    current = parent;
  }
}

export function validateConfig(raw: unknown): {
  success: boolean;
  config?: MetalmindConfig;
  errors?: string[];
} {
  const parsed = MetalmindConfigSchema.safeParse(raw);
  if (parsed.success) {
    return { success: true, config: parsed.data };
  }
  return {
    success: false,
    errors: parsed.error.errors.map(
      (e) => `${e.path.join(".")}: ${e.message}`,
    ),
  };
}

export interface UserConfig {
  activeProvider: string;
  activeModel: string;
  defaultProvider: string;
  defaultModel: string;
  apiKeys: Record<string, string>;
  models: Record<string, string[]>;
  mcpServers: Record<string, McpServerConfig>;
  workspacePaths: string[];
  uiTheme: "light" | "dark" | "system";
  recentModels: { provider: string; model: string; timestamp: number }[];
  permissions: {
    autoApprove: boolean;
  };
}

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  authType?: "none" | "oauth2" | "bearer";
  // Stdio transport (command-based MCP server)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // HTTP/SSE transport (URL-based MCP server)
  url?: string;
  headers?: Record<string, string>;
}

const DEFAULT_XDG_CONFIG: UserConfig = {
  activeProvider: "ollama",
  activeModel: "gemini-3-flash-preview:cloud",
  defaultProvider: "ollama",
  defaultModel: "gemini-3-flash-preview:cloud",
  apiKeys: {},
  models: {
    openai: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    anthropic: ["claude-sonnet-4-6", "claude-3-5-sonnet"],
    ollama: ["gemini-3-flash-preview:cloud", "gemma3:27b", "llama3.3:70b"],
    mlx: ["mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit"],
  },
  mcpServers: {},
  workspacePaths: [],
  uiTheme: "system",
  recentModels: [],
  permissions: {
    autoApprove: false,
  },
};

function ensureConfigDir(): void {
  if (!existsSync(XDG_CONFIG_DIR)) {
    mkdirSync(XDG_CONFIG_DIR, { recursive: true });
  }
}

/** Strip an accidental "provider/" prefix from a model name. */
export function normalizeModelName(provider: string, model: string): string {
  const prefix = provider + "/";
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

const LOCAL_ONLY_MODELS = new Set(["deepseek-coder:1.3b", "deepseek-coder:6.7b"]);
const KNOWN_PROVIDERS = ["ollama", "openai", "anthropic", "mlx"];

/** True when a model name looks corrupted (contains multiple slashes or is very long). */
function isCorruptedModel(model: string): boolean {
  const slashCount = (model.match(/\//g) ?? []).length;
  return slashCount > 1 || model.length > 120;
}

export function loadXdgConfig(): UserConfig {
  ensureConfigDir();

  if (!existsSync(XDG_CONFIG_FILE)) {
    saveXdgConfig(DEFAULT_XDG_CONFIG);
    return DEFAULT_XDG_CONFIG;
  }

  try {
    const raw = readFileSync(XDG_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const config: UserConfig = { ...DEFAULT_XDG_CONFIG, ...parsed };

    let dirty = false;

    // Normalize activeModel: strip accidental "provider/" prefix.
    const normalizedActive = normalizeModelName(config.activeProvider, config.activeModel);
    if (normalizedActive !== config.activeModel) {
      config.activeModel = normalizedActive;
      dirty = true;
    }

    // Migrate: local-only Ollama model while cloud key is present.
    if (
      config.activeProvider === "ollama" &&
      LOCAL_ONLY_MODELS.has(config.activeModel) &&
      config.apiKeys?.["ollama"]
    ) {
      config.activeModel = DEFAULT_XDG_CONFIG.activeModel;
      dirty = true;
    }

    // Normalize and de-duplicate each provider's models list.
    for (const provider of KNOWN_PROVIDERS) {
      const list = config.models[provider];
      if (!Array.isArray(list)) continue;
      const cleaned = Array.from(
        new Set(
          list
            .map((m: string) => normalizeModelName(provider, m))
            .filter((m: string) => !isCorruptedModel(m) && m.length > 0),
        ),
      );
      if (cleaned.length !== list.length || cleaned.some((m, i) => m !== list[i])) {
        config.models = { ...config.models, [provider]: cleaned };
        dirty = true;
      }
    }

    if (dirty) saveXdgConfig(config);
    return config;
  } catch {
    return DEFAULT_XDG_CONFIG;
  }
}

export function saveXdgConfig(config: UserConfig): void {
  ensureConfigDir();
  writeFileSync(XDG_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function updateXdgConfig(updates: Partial<UserConfig>): void {
  const current = loadXdgConfig();
  saveXdgConfig({ ...current, ...updates });
}

export { themes, THEME_DIR, THEME_FILE, switchTheme, loadTheme } from "./themes.js";
export type { Theme } from "./themes.js";
export { loadMergedConfig, saveGlobalConfig } from "./merged-config.js";
