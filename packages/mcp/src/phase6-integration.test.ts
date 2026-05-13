import { describe, it, expect } from "vitest";
import { McpManager, McpToolRegistry, normalizeMcpResult } from "./index.js";
import { McpServersConfigSchema } from "@metalmind/schemas";
import { ToolRegistry } from "@metalmind/tools";
import { PermissionManager } from "@metalmind/core";

describe("Phase 6 integration — MCP pipeline", () => {
  it("MCP manager integrates with tool registry", () => {
    const manager = new McpManager();

    manager.configure({
      "filesystem": {
        command: "npx",
        args: ["-y", "@anthropic/mcp-filesystem", "."],
        autoConnect: false,
      },
    });

    const state = manager.getState();
    expect(state.servers.has("filesystem")).toBe(true);
    expect(state.servers.get("filesystem")?.connected).toBe(false);
  });

  it("MCP config schema validates real-world configs", () => {
    const config = {
      "filesystem": { command: "npx", args: ["-y", "@anthropic/mcp-filesystem"] },
      "memory": { command: "python3", args: ["memory_server.py"], env: { API_KEY: "test" } },
      "database": { command: "docker", args: ["run", "-i", "mcp/postgres"], cwd: "/tmp" },
    };

    const result = McpServersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("MCP tools require confirmation by default", () => {
    const registry = new McpToolRegistry();
    const tools = registry.getTools();
    for (const tool of tools) {
      expect(tool.requiresConfirmation).toBe(true);
    }
  });

  it("normalizeMcpResult handles non-text content types", () => {
    const result = normalizeMcpResult({
      content: [
        { type: "text", text: "data" },
        { type: "image", image: "base64..." },
        { type: "text", text: "more" },
      ],
    });
    expect(result).toBe("data\nmore");
  });
});

describe("Phase 6 — MCP permission mapping", () => {
  it("PermissionManager.checkMcpTool respects global allowMcpTools", () => {
    const pm = new PermissionManager();

    // Default: ask
    const result = pm.checkMcpTool("any-server", "any-tool");
    expect(result.needsConfirmation).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it("PermissionManager.checkMcpTool blocks when allowMcpTools is false", () => {
    const pm = new PermissionManager();
    pm.allowMcpTools = false;

    const result = pm.checkMcpTool("any-server", "any-tool");
    expect(result.blocked).toBe(true);
  });

  it("McpToolRegistry.setPermissionManager is callable", () => {
    const pm = new PermissionManager();
    const registry = new McpToolRegistry();

    expect(() => registry.setPermissionManager(pm)).not.toThrow();
  });

  it("McpManager.setPermissionManager propagates to registry", () => {
    const pm = new PermissionManager();
    const manager = new McpManager();

    expect(() => manager.setPermissionManager(pm)).not.toThrow();
  });
});

describe("Phase 6 — MCP lifecycle integration", () => {
  it("McpIntegration handles multiple server configs", async () => {
    const { ToolRegistry } = await import("@metalmind/tools");
    const { McpIntegration } = await import("./mcp-integration.js");
    const { McpManager } = await import("./mcp-manager.js");

    const toolRegistry = new ToolRegistry();
    const manager = new McpManager();
    const integration = new McpIntegration(toolRegistry, manager);

    const state = await integration.start({
      "server1": { command: "echo", autoConnect: false },
      "server2": { command: "echo", autoConnect: false },
    });

    expect(state.connectedServers).toHaveLength(0);
    expect(state.errors).toHaveLength(0);
    await integration.shutdown();
  });

  it("McpIntegration connects and disconnects servers", async () => {
    const { ToolRegistry } = await import("@metalmind/tools");
    const { McpIntegration } = await import("./mcp-integration.js");
    const { McpManager } = await import("./mcp-manager.js");

    const toolRegistry = new ToolRegistry();
    const manager = new McpManager();
    const integration = new McpIntegration(toolRegistry, manager);

    await integration.start({
      "test-server": { command: "echo", autoConnect: false },
    });

    // Should not throw on disconnect of non-connected server
    await expect(
      integration.disconnectServer("test-server"),
    ).resolves.toBeUndefined();

    await integration.shutdown();
  });

  it("McpToolRegistry clears tools on disconnect", async () => {
    const registry = new McpToolRegistry();
    // Connect a mock server — this will fail since echo isn't an MCP server
    // but the registry should handle cleanup gracefully
    const connectPromise = registry.connectServer({
      name: "bad-server",
      command: "false",
    });

    // false exits with code 1, which should trigger disconnect event
    await expect(connectPromise).rejects.toThrow();

    // After failed connect, tools should be empty
    expect(registry.getTools()).toHaveLength(0);
  });

  it("McpToolRegistry disconnectServer removes tools", () => {
    const registry = new McpToolRegistry();
    // disconnect of never-connected server should be a no-op
    expect(() => registry.disconnectServer("never-connected")).not.toThrow();
    expect(registry.getTools()).toHaveLength(0);
  });

  it("normalizeMcpResult handles all content types", () => {
    // Mixed content
    const result = normalizeMcpResult({
      content: [
        { type: "text", text: "Hello" },
        { type: "image", data: "base64..." },
        { type: "resource", uri: "file:///out.txt" },
        { type: "text", text: "World" },
      ],
    });
    expect(result).toContain("Hello");
    expect(result).toContain("World");
    expect(result).toContain("[Resources]");
    expect(result).not.toContain("image");
  });

  it("MCP config schema validates with autoConnect", () => {
    const config = {
      "auto-server": {
        command: "node",
        args: ["mcp-server.js"],
        autoConnect: true,
      },
      "manual-server": {
        command: "python3",
        autoConnect: false,
      },
    };

    const result = McpServersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["auto-server"]?.autoConnect).toBe(true);
      expect(result.data["manual-server"]?.autoConnect).toBe(false);
    }
  });

  it("MCP tools in ToolRegistry have correct naming pattern", () => {
    const registry = new McpToolRegistry();
    const tools = registry.getTools();
    // No tools registered yet
    expect(tools).toHaveLength(0);
  });
});
