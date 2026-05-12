import { describe, it, expect } from "vitest";
import { AgentMessageSchema, AgentToolCallSchema } from "../src/messages.js";

describe("AgentMessageSchema", () => {
  it("parses a valid user message", () => {
    const msg = { role: "user", content: "hello" };
    expect(AgentMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an invalid role", () => {
    const msg = { role: "unknown", content: "hello" };
    expect(AgentMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("parses assistant message with tool calls", () => {
    const msg = {
      role: "assistant",
      content: "",
      toolCalls: [
        { toolCallId: "1", toolName: "readFile", argumentsJson: '{"path":"/a"}' },
      ],
    };
    const result = AgentMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolCalls).toHaveLength(1);
    }
  });

  it("rejects a missing content field", () => {
    const msg = { role: "user" };
    expect(AgentMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe("AgentToolCallSchema", () => {
  it("parses valid tool call", () => {
    const tc = { toolCallId: "1", toolName: "readFile", argumentsJson: "{}" };
    expect(AgentToolCallSchema.safeParse(tc).success).toBe(true);
  });

  it("rejects missing toolCallId", () => {
    const tc = { toolName: "readFile", argumentsJson: "{}" };
    expect(AgentToolCallSchema.safeParse(tc).success).toBe(false);
  });
});
