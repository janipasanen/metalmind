import { z, type ZodSchema } from "zod";

export interface ToolExecutionContext {
  projectRoot: string;
  /** Additional directories the agent is allowed to read/write. */
  workspaceRoots?: string[];
  auditLog?: (entry: ToolAuditEntry) => void;
  /** Turn-level abort signal — long-running tools should honour it (#284). */
  signal?: AbortSignal;
}

export interface ToolAuditEntry {
  timestamp: string;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: ZodSchema<TInput>;
  readonly requiresConfirmation: boolean;
  execute(input: TInput, executionContext: ToolExecutionContext): Promise<TOutput>;
}

export function createTool<TInput, TOutput>(
  def: Omit<AgentTool<TInput, TOutput>, "inputSchema"> & { inputSchema: ZodSchema<TInput> },
): AgentTool<TInput, TOutput> {
  return def;
}
