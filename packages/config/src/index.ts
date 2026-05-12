import { MetalmindConfigSchema, type MetalmindConfig } from "@metalmind/schemas";

const defaultConfig: MetalmindConfig = {
  models: {},
};

export function loadConfig(raw: unknown): MetalmindConfig {
  if (!raw || typeof raw !== "object") return defaultConfig;
  const parsed = MetalmindConfigSchema.safeParse(raw);
  if (!parsed.success) return defaultConfig;
  return parsed.data;
}

export { defaultConfig };
