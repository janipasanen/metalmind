import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { MetalmindConfigSchema, type MetalmindConfig } from "@metalmind/schemas";

export const CONFIG_FILE = "metalmind.yaml";

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
