import { z } from "zod";

export const AgentRole = z.enum(["system", "user", "assistant", "tool"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  argumentsJson: z.string(),
});
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

export const AgentMessageSchema = z.object({
  role: AgentRole,
  content: z.string(),
  toolCalls: z.array(AgentToolCallSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.string(),
  isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
