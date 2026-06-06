import { z } from "zod";

export const ModelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const RoutingConfigSchema = z.object({
  defaultLocalModel: z.string(),        // tier 1 — fastest local (MLX GPU)
  defaultFallbackModel: z.string().optional(), // tier 2 — local Ollama fallback
  defaultReasoningModel: z.string(),    // tier 3 — cloud for complex tasks
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


export const McpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  autoConnect: z.boolean().default(false),
});

export const McpServersConfigSchema = z.record(z.string(), McpServerConfigSchema);

export const MetalmindConfigSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema),
  routing: RoutingConfigSchema.optional(),
  permissions: PermissionsConfigSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  ui: UIConfigSchema.optional(),
  mcp: McpServersConfigSchema.optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type UIConfig = z.infer<typeof UIConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;
export type MetalmindConfig = z.infer<typeof MetalmindConfigSchema>;
