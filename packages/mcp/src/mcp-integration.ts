import { z } from "zod";
import { ToolRegistry } from "@metalmind/tools";
import { McpManager, McpServersConfigSchema } from "./mcp-manager.js";
import type { PermissionManager } from "@metalmind/core";
import type { McpServersConfig } from "./mcp-manager.js";

export interface McpIntegrationState {
  connectedServers: string[];
  toolCount: number;
  errors: string[];
}

/**
 * Bridges MCP server tools into the main ToolRegistry.
 *
 * Usage:
 *   const mcp = new McpIntegration(toolRegistry, mcpManager);
 *   await mcp.start();
 */
export class McpIntegration {
  private started = false;
  private serverErrors = new Map<string, string>();

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly mcpManager: McpManager,
    private readonly permissionManager?: PermissionManager,
  ) {}

  /**
   * Configure MCP servers from YAML config and start auto-connect servers.
   * Registers all discovered tools into the main ToolRegistry.
   */
  async start(servers?: z.input<typeof McpServersConfigSchema>): Promise<McpIntegrationState> {
    if (this.started) {
      throw new Error("McpIntegration already started");
    }

    if (servers) {
      this.mcpManager.configure(servers);
    }

    // Wire permission manager into MCP tool registry
    if (this.permissionManager) {
      this.mcpManager.setPermissionManager(this.permissionManager);
    }

    // Listen for server events
    this.mcpManager.on("serverConnected", ({ name, toolCount }) => {
      // Tools are already registered by McpToolRegistry internally
      // Now also register them in the main ToolRegistry
      const mcpTools = this.mcpManager.getTools();
      for (const tool of mcpTools) {
        if (!this.toolRegistry.get(tool.toolName)) {
          this.toolRegistry.register(tool);
        }
      }
    });

    this.mcpManager.on("serverDisconnected", ({ name }) => {
      // Remove tools for the disconnected server
      const mcpTools = this.mcpManager.getTools();
      const allTools = this.toolRegistry.listNames();
      const mcpToolNames = new Set(mcpTools.map((t) => t.toolName));
      for (const toolName of allTools) {
        if (toolName.startsWith(`mcp:${name}:`) && !mcpToolNames.has(toolName)) {
          this.toolRegistry.remove(toolName);
        }
      }
    });

    const errors: string[] = [];
    const connectedNames: string[] = [];

    try {
      const started = await this.mcpManager.startAll();
      connectedNames.push(...started);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    this.started = true;

    const state = this.mcpManager.getState();
    const toolCount = [...state.servers.values()]
      .filter((s) => s.connected)
      .reduce((sum, s) => sum + s.toolCount, 0);

    return {
      connectedServers: connectedNames,
      toolCount,
      errors,
    };
  }

  /**
   * Connect to a specific MCP server and register its tools.
   */
  async connectServer(name: string): Promise<string[]> {
    const tools = await this.mcpManager.connectServer(name);
    const mcpTools = this.mcpManager.getTools();
    for (const tool of mcpTools) {
      if (!this.toolRegistry.get(tool.toolName)) {
        this.toolRegistry.register(tool);
      }
    }
    return tools;
  }

  /**
   * Disconnect from a specific MCP server and unregister its tools.
   */
  async disconnectServer(name: string): Promise<void> {
    await this.mcpManager.disconnectServer(name);
    const allTools = this.toolRegistry.listNames();
    for (const toolName of allTools) {
      if (toolName.startsWith(`mcp:${name}:`)) {
        this.toolRegistry.remove(toolName);
      }
    }
  }

  /**
   * Get current integration state.
   */
  getState(): McpIntegrationState {
    const state = this.mcpManager.getState();
    const connectedServers: string[] = [];
    let toolCount = 0;

    for (const [name, s] of state.servers) {
      if (s.connected) {
        connectedServers.push(name);
        toolCount += s.toolCount;
      }
    }

    const errors = [...this.serverErrors.values()];

    return { connectedServers, toolCount, errors };
  }

  /**
   * Shutdown all MCP servers and clean up.
   */
  async shutdown(): Promise<void> {
    const state = this.mcpManager.getState();
    for (const [name] of state.servers) {
      await this.disconnectServer(name).catch(() => {});
    }
    await this.mcpManager.shutdown();
    this.started = false;
  }
}
