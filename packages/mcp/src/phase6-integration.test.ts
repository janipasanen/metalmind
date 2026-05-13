import { describe, it, expect } from "vitest";
import { McpManager, McpServersConfigSchema, McpToolRegistry, normalizeMcpResult } from "./index.js";
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
