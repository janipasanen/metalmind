import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../src/tool-registry.js";
import type { AgentTool, ToolExecutionContext } from "../src/types.js";

describe("ToolRegistry", () => {
  const ctx: ToolExecutionContext = { projectRoot: "/tmp/test" };

  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const tool: AgentTool = {
      toolName: "test",
      description: "A test tool",
      inputSchema: {},
      requiresConfirmation: false,
      execute: async () => "ok",
    };
    registry.register(tool);
    expect(registry.get("test")).toBe(tool);
  });

  it("lists registered tools", () => {
    const registry = new ToolRegistry();
    registry.register({
      toolName: "a",
      description: "",
      inputSchema: {},
      requiresConfirmation: false,
      execute: async () => null,
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.listNames()).toEqual(["a"]);
  });

  it("executes a tool", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue("result");
    registry.register({
      toolName: "run",
      description: "",
      inputSchema: {},
      requiresConfirmation: false,
      execute,
    });
    const result = await registry.execute("run", { arg: 1 }, ctx);
    expect(result).toBe("result");
    expect(execute).toHaveBeenCalledWith({ arg: 1 }, ctx);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool: AgentTool = {
      toolName: "dup",
      description: "",
      inputSchema: {},
      requiresConfirmation: false,
      execute: async () => null,
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });

  it("throws executing unknown tool", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("unknown", {}, ctx)).rejects.toThrow(/not found/);
  });

  it("removes and clears tools", () => {
    const registry = new ToolRegistry();
    const tool: AgentTool = {
      toolName: "x",
      description: "",
      inputSchema: {},
      requiresConfirmation: false,
      execute: async () => null,
    };
    registry.register(tool);
    expect(registry.remove("x")).toBe(true);
    expect(registry.remove("x")).toBe(false);
    registry.register(tool);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});
