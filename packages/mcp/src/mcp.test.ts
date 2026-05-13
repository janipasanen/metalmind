import { describe, it, expect } from "vitest";
import { normalizeMcpResult } from "./mcp-tool-registry.js";
import { McpManager } from "./mcp-manager.js";
import { McpServersConfigSchema } from "@metalmind/schemas";
import { McpClient, type McpServerConfig } from "./mcp-client.js";
import { McpToolRegistry } from "./index.js";

describe("normalizeMcpResult", () => {
  it("passes through plain strings", () => {
    expect(normalizeMcpResult("hello")).toBe("hello");
  });

  it("extracts text from MCP content array", () => {
    const result = normalizeMcpResult({
      content: [
        { type: "text", text: "file contents" },
        { type: "text", text: " more data" },
      ],
    });
    expect(result).toBe("file contents\n more data");
  });

  it("extracts text from toolResult.content", () => {
    const result = normalizeMcpResult({
      toolResult: {
        content: [{ type: "text", text: "result output" }],
      },
    });
    expect(result).toBe("result output");
  });

  it("stringifies simple result objects", () => {
    const result = normalizeMcpResult({ result: 42 });
    expect(result).toBe("42");
  });

  it("handles null/undefined", () => {
    expect(normalizeMcpResult(null)).toBe("");
    expect(normalizeMcpResult(undefined)).toBe("");
  });

  it("JSON-serializes complex objects", () => {
    const result = normalizeMcpResult({ a: 1, b: [2, 3] });
    expect(JSON.parse(result)).toEqual({ a: 1, b: [2, 3] });
  });
});

describe("McpServersConfigSchema", () => {
  it("validates valid config", () => {
    const result = McpServersConfigSchema.safeParse({
      "filesystem": {
        command: "npx",
        args: ["-y", "@anthropic/mcp-filesystem", "."],
        autoConnect: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing command", () => {
    const result = McpServersConfigSchema.safeParse({
      "bad": { args: [] },
    });
    expect(result.success).toBe(false);
  });

  it("defaults autoConnect to false", () => {
    const result = McpServersConfigSchema.safeParse({
      "test": { command: "node" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test?.autoConnect).toBe(false);
    }
  });
});

describe("McpManager", () => {
  it("configures servers from YAML config", () => {
    const manager = new McpManager();
    manager.configure({
      "fs": { command: "npx", args: ["-y", "@anthropic/mcp-filesystem"] },
    });

    const state = manager.getState();
    expect(state.servers.has("fs")).toBe(true);
    expect(state.servers.get("fs")?.config.command).toBe("npx");
  });

  it("registers auto-connect servers at start", async () => {
    const manager = new McpManager();
    manager.configure({
      "noauto": { command: "echo", args: ["hello"] },
    });

    const started = await manager.startAll();
    expect(started).toHaveLength(0);
  });

  it("throws for unknown server on connect", async () => {
    const manager = new McpManager();
    await expect(manager.connectServer("nonexistent")).rejects.toThrow(/Unknown/);
  });

  it("getState returns server states", () => {
    const manager = new McpManager();
    manager.configure({
      "srv1": { command: "node" },
      "srv2": { command: "python3" },
    });

    const state = manager.getState();
    expect(state.servers.size).toBe(2);
  });
});

describe("McpToolRegistry", () => {
  it("handles empty registry", () => {
    const registry = new McpToolRegistry();
    expect(registry.getTools()).toHaveLength(0);
    expect(registry.getServerNames()).toHaveLength(0);
    expect(registry.isConnected("unknown")).toBe(false);
  });
});

describe("McpClient config", () => {
  it("accepts valid server config", () => {
    const config: McpServerConfig = {
      name: "test",
      command: "node",
      args: ["server.js"],
      env: { NODE_ENV: "test" },
    };
    expect(config.name).toBe("test");
    expect(config.args).toEqual(["server.js"]);
  });
});
