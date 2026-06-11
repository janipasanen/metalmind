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
  /** Optional image attachments for vision models — data URLs ("data:image/png;base64,…")
   *  or remote https URLs. Serialized into multimodal content parts by the providers (#177). */
  images: z.array(z.string()).optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.string(),
  isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
