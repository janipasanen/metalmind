import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { MetalmindConfigSchema, type MetalmindConfig } from "@metalmind/schemas";

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
  routing?: {
    defaultLocalModel?: string;
    defaultReasoningModel?: string;
  };
  mcpServers: Record<string, McpServerConfig>;
  workspacePaths: string[];
  uiTheme: "light" | "dark" | "system";
  recentModels: { provider: string; model: string; timestamp: number }[];
  permissions: {
    autoApprove: boolean;
  };
  editor?: {
    /** When true, run `formatCommand` on each file the agent writes/edits. */
    formatOnWrite?: boolean;
    /** Formatter command; the changed file path is appended. Default: prettier. */
    formatCommand?: string;
  };
  /** Soft session spend cap in USD; once reached, cloud routing downgrades to local (#182). */
  budgetUsd?: number;
  /** Persisted per-tier model overrides (1=local MLX, 2=local Ollama, 3=cloud) (#185).
   *  An optional baseUrl lets a tier point at a specific host (#248). */
  tierModels?: Record<string, { provider: string; model: string; baseUrl?: string }>;
  /** Remote-brain mode: cloud model coordinates and delegates bounded subtasks to the local model (#186). */
  remoteBrain?: boolean;
  /** Saved, reusable prompt templates by name; {{vars}} are filled at use time (#201). */
  prompts?: Record<string, string>;
  /** Enable vim modal editing in the input bar (#184). */
  vimMode?: boolean;
  /** OAuth tokens for authenticated MCP servers, keyed by server id (#199).
   *  Used as a fallback store when the macOS keychain helper is unavailable. */
  mcpTokens?: Record<string, { accessToken: string; refreshToken?: string; expiresAt?: number; tokenType?: string }>;
  /** Persisted, granular auto-approval allowlist so trusted ops don't re-prompt (#220). */
  approvalAllowlist?: {
    /** Tool names always allowed (e.g. "writeFile"). */
    tools?: string[];
    /** Glob patterns for file-op paths (e.g. "src/**"). */
    paths?: string[];
    /** Command prefixes for runCommand/runBackground (e.g. "npm test"). */
    commands?: string[];
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
  // OAuth 2.0 endpoints for authType: "oauth2" servers, used by /mcp auth (#199).
  oauth?: {
    authEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    scope?: string;
  };
}

const DEFAULT_XDG_CONFIG: UserConfig = {
  activeProvider: "ollama",
  activeModel: "gpt-oss:120b",
  defaultProvider: "ollama",
  defaultModel: "gpt-oss:120b",
  apiKeys: {},
  models: {
    openai: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    anthropic: ["claude-sonnet-4-6", "claude-3-5-sonnet"],
    ollama: ["gpt-oss:120b", "gpt-oss:20b", "gemma3:27b", "llama3.3:70b"],
    mlx: ["mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit"],
  },
  mcpServers: {},
  workspacePaths: [],
  uiTheme: "system",
  recentModels: [],
  permissions: {
    autoApprove: false,
  },
  editor: {
    formatOnWrite: false,
    formatCommand: "npx prettier --write",
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
    const fresh = structuredClone(DEFAULT_XDG_CONFIG);
    saveXdgConfig(fresh);
    return fresh;
  }

  try {
    const raw = readFileSync(XDG_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    // Deep-merge the nested objects against the defaults so a partial config
    // (e.g. `editor: { formatOnWrite: true }` or `permissions: {}`) doesn't drop
    // sibling defaults like editor.formatCommand / permissions.autoApprove (#272).
    const config: UserConfig = {
      ...DEFAULT_XDG_CONFIG,
      ...parsed,
      models: { ...DEFAULT_XDG_CONFIG.models, ...(parsed.models ?? {}) },
      permissions: { ...DEFAULT_XDG_CONFIG.permissions, ...(parsed.permissions ?? {}) },
      editor: { ...DEFAULT_XDG_CONFIG.editor, ...(parsed.editor ?? {}) },
    };

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
    // Return a fresh clone so a caller mutating it can't corrupt the shared default.
    return structuredClone(DEFAULT_XDG_CONFIG);
  }
}

export function saveXdgConfig(config: UserConfig): void {
  ensureConfigDir();
  // Atomic write: serialize to a unique temp file then rename over the target.
  // rename() is atomic on POSIX, so a concurrent reader (or a crash mid-write)
  // never sees a truncated/half-written config — it gets the old or new file whole.
  const tmp = `${XDG_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
    renameSync(tmp, XDG_CONFIG_FILE);
    return;
  } catch {
    // Fall back to a direct write if temp+rename isn't possible (e.g. cross-device).
    writeFileSync(XDG_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  }
}

export function updateXdgConfig(updates: Partial<UserConfig>): void {
  const current = loadXdgConfig();
  saveXdgConfig({ ...current, ...updates });
}

export { themes, THEME_DIR, THEME_FILE, switchTheme, loadTheme } from "./themes.js";
export type { Theme } from "./themes.js";
export { loadMergedConfig } from "./merged-config.js";
