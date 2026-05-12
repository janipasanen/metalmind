import { z } from "zod";

export const ToolCallResponseSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.string(),
  isError: z.boolean(),
});
export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;
