import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "@metalmind/tools";
import { McpManager } from "./mcp-manager.js";
import { McpClient } from "./mcp-client.js";
import { McpIntegration } from "./mcp-integration.js";

describe("McpIntegration", () => {
  let toolRegistry: ToolRegistry;
  let mcpManager: McpManager;
  let integration: McpIntegration;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    mcpManager = new McpManager();
    integration = new McpIntegration(toolRegistry, mcpManager);
  });

  afterEach(async () => {
    try {
      await integration.shutdown();
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates integration with tool registry and MCP manager", () => {
    expect(integration).toBeDefined();
  });

  it("start returns empty state when no servers configured", async () => {
    const state = await integration.start();
    expect(state.connectedServers).toHaveLength(0);
    expect(state.toolCount).toBe(0);
    expect(state.errors).toHaveLength(0);
  });

  it("start configures servers and returns state", async () => {
    const state = await integration.start({
      myserver: { command: "echo", args: ["hello"] },
    });

    expect(state.connectedServers).toHaveLength(0); // autoConnect defaults to false
  });

  it("throws when started twice", async () => {
    await integration.start();
    await expect(integration.start()).rejects.toThrow(/already started/);
  });

  it("throws for unknown server on connect", async () => {
    await integration.start();
    await expect(integration.connectServer("nonexistent")).rejects.toThrow(
      /Unknown/,
    );
  });

  it("getState returns integration state", async () => {
    await integration.start();
    const state = integration.getState();
    expect(state.connectedServers).toBeDefined();
    expect(state.toolCount).toBe(0);
    expect(state.errors).toBeDefined();
  });

  it("shutdown cleans up servers", async () => {
    await integration.start();
    await integration.shutdown();
    // Should not throw on second shutdown
    await integration.shutdown();
  });

  it("disconnectServer handles non-existent gracefully", async () => {
    await integration.start();
    // disconnectServer on McpManager for non-existent is a no-op
    // This should not throw
    await expect(
      integration.disconnectServer("nonexistent"),
    ).resolves.toBeUndefined();
  });
});

describe("McpManager config and lifecycle", () => {
  it("getServerStatus returns empty array when no servers configured", () => {
    const manager = new McpManager();
    expect(manager.getServerStatus()).toHaveLength(0);
  });

  it("getServerStatus returns configured servers with state", () => {
    const manager = new McpManager();
    manager.configure({
      "fs": { command: "npx", args: ["-y", "mcp-filesystem"] },
    });

    const status = manager.getServerStatus();
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("fs");
    expect(status[0].connected).toBe(false);
  });

  it("McpClient.isHealthy reflects connection state", () => {
    const client = new McpClient({ name: "test", command: "echo" });
    // Before connect, isHealthy returns false (not connected yet)
    expect(client.isHealthy()).toBe(false);
  });
});
