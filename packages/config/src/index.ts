import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { MetalmindConfigSchema, type MetalmindConfig } from "@metalmind/schemas";

export const CONFIG_FILE = "metalmind.yaml";
/** Config root. Overridable via METALMIND_CONFIG_DIR (#415) so tests — and
 *  container/multi-profile setups — never read or write the developer's real
 *  ~/.config/metalmind, which holds apiKeys and mcpServers. Resolved once at
 *  module load, so the variable must be set before the module is imported. */
export const XDG_CONFIG_DIR =
  process.env.METALMIND_CONFIG_DIR?.trim() || join(homedir(), ".config", "metalmind");
export const XDG_CONFIG_FILE = join(XDG_CONFIG_DIR, "config.json");
/** User-level metalmind.yaml, applied when a project does not define its own.
 *  `metalmind` is installed once and run in any directory, but models/routing
 *  used to come only from a metalmind.yaml found by walking up from the cwd —
 *  so outside a configured project every tier silently fell back to a built-in
 *  default (tier 2 as "ministral-3:3b", whether or not it was installed). */
export const GLOBAL_CONFIG_FILE = join(XDG_CONFIG_DIR, CONFIG_FILE);

export const defaultConfig: MetalmindConfig = {
  models: {},
};

export function loadConfig(raw: unknown): MetalmindConfig {
  if (!raw || typeof raw !== "object") return structuredClone(defaultConfig);
  const parsed = MetalmindConfigSchema.safeParse(raw);
  if (!parsed.success) return structuredClone(defaultConfig);
  return parsed.data;
}

/** Why the last loadConfigFromFile call fell back to defaults, if it did (#383).
 *  A metalmind.yaml that fails to parse or validate is discarded WHOLE — every
 *  section in it stops applying — so the reason must be surfacable to the user
 *  (/doctor reads this) instead of vanishing. */
export interface ConfigLoadIssue {
  path: string;
  reason: string;
}
let lastConfigIssue: ConfigLoadIssue | null = null;
export function getConfigLoadIssue(): ConfigLoadIssue | null {
  return lastConfigIssue;
}

/** Read and validate one metalmind.yaml. Returns null — and records why — when
 *  the file is unusable, so a broken file is discarded whole rather than
 *  half-applied. */
function readConfigAt(configPath: string): MetalmindConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    lastConfigIssue = { path: configPath, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
    return null;
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    lastConfigIssue = { path: configPath, reason: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` };
    return null;
  }

  if (!data || typeof data !== "object") {
    lastConfigIssue = { path: configPath, reason: "file is empty or not a YAML mapping" };
    return null;
  }

  const parsed = MetalmindConfigSchema.safeParse(data);
  if (!parsed.success) {
    lastConfigIssue = {
      path: configPath,
      reason: parsed.error.errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`).join("; "),
    };
    return null;
  }
  return parsed.data;
}

/** Layer a project config over the user-level one.
 *
 *  `models` is a registry, so it merges by name — a project adding one model
 *  keeps the rest. Every other section is replaced wholesale when the project
 *  defines it, which keeps the rule easy to state: define a section and you own
 *  it. `models` cannot use that rule because the schema defaults it to `{}` on
 *  every parse, so wholesale replacement would erase the global registry from
 *  any project config that never mentioned models. */
function layerConfig(base: MetalmindConfig, over: MetalmindConfig): MetalmindConfig {
  const merged: MetalmindConfig = { ...base };
  for (const [key, value] of Object.entries(over) as Array<[keyof MetalmindConfig, unknown]>) {
    if (value === undefined) continue;
    if (key === "models") continue; // handled below
    (merged as Record<string, unknown>)[key] = value;
  }
  merged.models = { ...(base.models ?? {}), ...(over.models ?? {}) };
  return merged;
}

export interface LoadConfigOptions {
  /** User-level config path. Defaults to GLOBAL_CONFIG_FILE; pass an explicit
   *  path (or null to skip it) so a test never reads or writes the shared one —
   *  vitest runs files in parallel, and that file is now an input to every
   *  loadConfigFromFile call in the run. */
  globalFile?: string | null;
}

export function loadConfigFromFile(
  directory: string = process.cwd(),
  options: LoadConfigOptions = {},
): MetalmindConfig {
  lastConfigIssue = null;
  const projectPath = findConfigFile(directory);

  const globalCandidate = options.globalFile === undefined ? GLOBAL_CONFIG_FILE : options.globalFile;
  // Skip the global file when the walk already found it, so a config living in
  // the config dir is not applied twice.
  const globalPath =
    globalCandidate && projectPath !== globalCandidate && existsSync(globalCandidate)
      ? globalCandidate
      : null;

  const globalConfig = globalPath ? readConfigAt(globalPath) : null;
  const projectConfig = projectPath ? readConfigAt(projectPath) : null;

  if (!globalConfig && !projectConfig) return structuredClone(defaultConfig);
  if (!projectConfig) return globalConfig!;
  if (!globalConfig) return projectConfig;
  return layerConfig(globalConfig, projectConfig);
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
    /** Evaluate every prompt to pick a tier (default true). When false, every
     *  turn goes straight to tier 3 without classification. */
    evaluateEachPrompt?: boolean;
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
    /** Project check command for /check and end-of-turn verification (#282/#295).
     *  Default: `npx tsc --noEmit` when a tsconfig.json exists. */
    checkCommand?: string;
    /** Run the check automatically after turns that edited files (default true) (#282). */
    checkOnEdit?: boolean;
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
  // Empty on a FRESH install (#416): writing a concrete provider/model into the
  // brand-new config made resolveConfig take the "saved preference" branch and
  // skip env auto-detection entirely — so an exported OLLAMA_API_KEY was ignored
  // and the user was pinned to the LOCAL provider with a cloud-only 120B model
  // that isn't installed there. Empty means "not chosen yet": auto-detect runs.
  activeProvider: "",
  activeModel: "",
  defaultProvider: "ollama",
  defaultModel: "",
  apiKeys: {},
  models: {
    openai: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    anthropic: ["claude-sonnet-4-6", "claude-3-5-sonnet"],
    ollama: ["gpt-oss:120b", "gpt-oss:20b", "gemma3:27b", "llama3.3:70b"],
    "ollama-cloud": ["glm-5.2:cloud", "glm-5.1", "deepseek-v4-pro", "kimi-k2.7-code", "gpt-oss:120b"],
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
    // 0700: the directory holds api keys and OAuth tokens; the default 0755
    // left them readable by every account on the machine (#396).
    mkdirSync(XDG_CONFIG_DIR, { recursive: true, mode: 0o700 });
    return;
  }
  // Tighten an existing directory created before this (or by an older version).
  try {
    chmodSync(XDG_CONFIG_DIR, 0o700);
  } catch {
    /* best-effort — a read-only or foreign-owned dir must not break startup */
  }
}

/** Restrict a credential-bearing file to the owner (#396). */
function restrictPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
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

  // Repair permissions on an EXISTING install too (#396): waiting for the next
  // save would leave a world-readable key file sitting there indefinitely.
  restrictPermissions(XDG_CONFIG_FILE);

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
    // mode 0600 at CREATE time, so the key is never briefly world-readable
    // between write and chmod (#396).
    writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, XDG_CONFIG_FILE);
    restrictPermissions(XDG_CONFIG_FILE); // rename preserves the tmp's mode, but be explicit
    return;
  } catch {
    // Fall back to a direct write if temp+rename isn't possible (e.g. cross-device).
    writeFileSync(XDG_CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    restrictPermissions(XDG_CONFIG_FILE);
  }
}

export function updateXdgConfig(updates: Partial<UserConfig>): void {
  const current = loadXdgConfig();
  saveXdgConfig({ ...current, ...updates });
}

export { themes, THEME_DIR, THEME_FILE, switchTheme, loadTheme } from "./themes.js";
export type { Theme } from "./themes.js";
export { loadMergedConfig } from "./merged-config.js";
