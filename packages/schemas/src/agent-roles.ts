import { z } from "zod";

export const AgentRoleType = z.enum(["cloud-main", "local-worker", "coordinator"]);
export type AgentRoleType = z.infer<typeof AgentRoleType>;

export const AgentTaskStatus = z.enum([
  "pending",
  "assigned",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentTaskStatus = z.infer<typeof AgentTaskStatus>;

export const AgentTaskSchema = z.object({
  taskId: z.string().uuid(),
  taskType: z.string().min(1),
  status: AgentTaskStatus,
  assignedTo: AgentRoleType,
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  parentId: z.string().uuid().optional(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const LocalWorkerTaskType = z.enum([
  "classifyUserIntent",
  "rankRelevantFiles",
  "summarizeFile",
  "summarizeDiff",
  "summarizeCommandOutput",
  "extractSymbols",
  "extractImports",
  "identifyLikelyTestFiles",
  "generateCommitMessageDraft",
  "validateJsonLikeOutput",
  "suggestSimpleEdit",
  "explainCompilerError",
]);
export type LocalWorkerTaskType = z.infer<typeof LocalWorkerTaskType>;

export const LocalWorkerTaskSchema = z.object({
  taskId: z.string().min(1),
  taskType: LocalWorkerTaskType,
  input: z.unknown(),
  outputSchemaName: z.string().min(1),
  maximumInputTokens: z.number().int().positive(),
  maximumOutputTokens: z.number().int().positive(),
  timeoutMilliseconds: z.number().int().positive(),
});
export type LocalWorkerTask = z.infer<typeof LocalWorkerTaskSchema>;

export const AgentResultSchema = z.object({
  taskId: z.string().min(1),
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  modelUsed: z.string().optional(),
  providerUsed: z.string().optional(),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const RoutingTarget = z.enum(["local-worker", "cloud-main", "direct-tool"]);
export type RoutingTarget = z.infer<typeof RoutingTarget>;

export const ModelRoutingDecisionSchema = z.object({
  target: RoutingTarget,
  taskType: z.string().min(1),
  modelId: z.string().optional(),
  provider: z.string().optional(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  escalatedFrom: RoutingTarget.optional(),
  escalatedReason: z.string().optional(),
  delegatedToLocal: z.boolean().default(false),
});
export type ModelRoutingDecision = z.infer<typeof ModelRoutingDecisionSchema>;

export const FORBIDDEN_LOCAL_WORKER_TASKS: ReadonlySet<string> = new Set([
  "executeShellCommand",
  "deleteFiles",
  "writeFiles",
  "editFiles",
  "commitCode",
  "decideTaskCompletion",
  "planArchitecture",
  "planRefactor",
]);