import { z } from "zod";

export const ModelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const RoutingConfigSchema = z.object({
  defaultLocalModel: z.string(),
  defaultReasoningModel: z.string(),
  fallbackReasoningModel: z.string().optional(),
});

export const PermissionsConfigSchema = z.object({
  allowReadFiles: z.union([z.boolean(), z.literal("ask")]).default(true),
  allowWriteFiles: z.union([z.boolean(), z.literal("ask")]).default("ask"),
  allowDeleteFiles: z.union([z.boolean(), z.literal("ask")]).default("ask"),
  allowShellCommands: z.union([z.boolean(), z.literal("ask")]).default("ask"),
  allowGitCommit: z.union([z.boolean(), z.literal("ask")]).default("ask"),
});

export const ToolsConfigSchema = z.object({
  filesystem: z.boolean().default(true),
  git: z.boolean().default(true),
  shell: z.boolean().default(true),
  mcp: z.boolean().default(true),
});

export const UIConfigSchema = z.object({
  theme: z.string().default("default"),
  showToolTimeline: z.boolean().default(true),
  showDiffBeforeApply: z.boolean().default(true),
});

export const MetalmindConfigSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema),
  routing: RoutingConfigSchema.optional(),
  permissions: PermissionsConfigSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  ui: UIConfigSchema.optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type UIConfig = z.infer<typeof UIConfigSchema>;
export type MetalmindConfig = z.infer<typeof MetalmindConfigSchema>;
