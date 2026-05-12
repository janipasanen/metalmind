import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry, parseInput } from "./tool-registry.js";
import type { AgentTool, ToolExecutionContext } from "./types.js";

describe("ToolRegistry", () => {
  const ctx: ToolExecutionContext = { projectRoot: "/tmp/test" };

  function makeTool(name: string): AgentTool<{ x: number }, string> {
    return {
      toolName: name,
      description: "test tool",
      inputSchema: z.object({ x: z.number() }),
      requiresConfirmation: false,
      execute: async (input) => `got ${input.x}`,
    };
  }

  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("test");
    registry.register(tool);
    expect(registry.get("test")).toBe(tool);
  });

  it("lists registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("a"));
    registry.register(makeTool("b"));
    expect(registry.list()).toHaveLength(2);
    expect(registry.listNames()).toEqual(["a", "b"]);
  });

  it("executes a tool with validated input", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue("result");
    registry.register({
      toolName: "run",
      description: "",
      inputSchema: z.object({ arg: z.number() }),
      requiresConfirmation: false,
      execute,
    });
    const result = await registry.execute("run", { arg: 1 }, ctx);
    expect(result).toBe("result");
    expect(execute).toHaveBeenCalledWith({ arg: 1 }, ctx);
  });

  it("rejects invalid input with Zod error", async () => {
    const registry = new ToolRegistry();
    registry.register({
      toolName: "numOnly",
      description: "",
      inputSchema: z.object({ n: z.number() }),
      requiresConfirmation: false,
      execute: async () => null,
    });

    await expect(
      registry.execute("numOnly", { n: "not-a-number" }, ctx),
    ).rejects.toThrow(/Invalid input for "numOnly"/);
  });

  it("rejects missing required fields", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("required"));
    await expect(registry.execute("required", {}, ctx)).rejects.toThrow(/Invalid input/);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("dup");
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });

  it("throws executing unknown tool", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("unknown", {}, ctx)).rejects.toThrow(/not found/);
  });

  it("removes and clears tools", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("x");
    registry.register(tool);
    expect(registry.remove("x")).toBe(true);
    expect(registry.remove("x")).toBe(false);
    registry.register(tool);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it("calls auditLog on execution", async () => {
    const registry = new ToolRegistry();
    const auditEntries: unknown[] = [];
    const ctxWithAudit: ToolExecutionContext = {
      projectRoot: "/tmp",
      auditLog: (entry) => auditEntries.push(entry),
    };

    registry.register(makeTool("audit"));
    await registry.execute("audit", { x: 42 }, ctxWithAudit);

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      toolName: "audit",
      success: true,
    });
  });

  it("audit log records failures", async () => {
    const registry = new ToolRegistry();
    const auditEntries: unknown[] = [];
    const ctxWithAudit: ToolExecutionContext = {
      projectRoot: "/tmp",
      auditLog: (entry) => auditEntries.push(entry),
    };

    registry.register({
      toolName: "failing",
      description: "",
      inputSchema: z.object({}),
      requiresConfirmation: false,
      execute: async () => {
        throw new Error("kaboom");
      },
    });

    await expect(
      registry.execute("failing", {}, ctxWithAudit),
    ).rejects.toThrow("kaboom");

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      toolName: "failing",
      success: false,
      error: "kaboom",
    });
  });

  it("validates complex nested schemas", async () => {
    const registry = new ToolRegistry();
    registry.register({
      toolName: "nested",
      description: "",
      inputSchema: z.object({
        path: z.string(),
        options: z.object({ mode: z.enum(["read", "write"]) }).optional(),
      }),
      requiresConfirmation: false,
      execute: async (input) => input,
    });

    const result = await registry.execute(
      "nested",
      { path: "/test", options: { mode: "read" } },
      ctx,
    );
    expect(result).toEqual({ path: "/test", options: { mode: "read" } });
  });
});

describe("parseInput", () => {
  it("parses JSON string", () => {
    expect(parseInput('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns string as-is for non-JSON", () => {
    expect(parseInput("hello")).toBe("hello");
  });
});
