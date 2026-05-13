import { EventEmitter } from "node:events";
import { McpToolRegistry } from "./mcp-tool-registry.js";
import { McpClient, type McpServerConfig } from "./mcp-client.js";
import { z } from "zod";
import type { PermissionManager } from "@metalmind/core";

export const McpServersConfigSchema = z.record(
  z.string(),
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    autoConnect: z.boolean().default(false),
  }),
);

export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

export interface McpManagerState {
  servers: Map<string, {
    config: McpServerConfig;
    connected: boolean;
    toolCount: number;
    autoConnect: boolean;
  }>;
}

export class McpManager extends EventEmitter {
  private registry: McpToolRegistry;
  private serverConfigs = new Map<string, McpServerConfig & { autoConnect: boolean }>();
  private serverState = new Map<string, { connected: boolean; toolCount: number }>();

  constructor(registry: McpToolRegistry = new McpToolRegistry()) {
    super();
    this.registry = registry;
  }

  /**
   * Configure MCP servers from config (metalmind.yaml).
   */
  configure(servers: z.input<typeof McpServersConfigSchema>): void {
    for (const [name, cfg] of Object.entries(servers)) {
      this.serverConfigs.set(name, {
        name,
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        cwd: cfg.cwd,
        autoConnect: cfg.autoConnect ?? false,
      });
    }
  }

  /**
   * Set the permission manager for MCP tool permission checks.
   */
  setPermissionManager(pm: PermissionManager): void {
    this.registry.setPermissionManager(pm);
  }

  /**
   * Start all auto-connect servers.
   */
  async startAll(): Promise<string[]> {
    const names: string[] = [];
    for (const [name, config] of this.serverConfigs) {
      if (config.autoConnect) {
        await this.connectServer(name);
        names.push(name);
      }
    }
    return names;
  }

  /**
   * Connect to a specific MCP server.
   */
  async connectServer(name: string): Promise<string[]> {
    const config = this.serverConfigs.get(name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);

    const tools = await this.registry.connectServer(config);
    this.serverState.set(name, { connected: true, toolCount: tools.length });
    this.emit("serverConnected", { name, toolCount: tools.length });
    return tools;
  }

  /**
   * Disconnect a specific MCP server.
   */
  async disconnectServer(name: string): Promise<void> {
    await this.registry.disconnectServer(name);
    this.serverState.set(name, { connected: false, toolCount: 0 });
    this.emit("serverDisconnected", { name });
  }

  /**
   * Get all MCP tools registered across all servers.
   */
  getTools() {
    return this.registry.getTools();
  }

  /**
   * Get current state of all servers.
   */
  getState(): McpManagerState {
    const servers = new Map<string, { config: McpServerConfig; connected: boolean; toolCount: number; autoConnect: boolean }>();
    for (const [name, cfg] of this.serverConfigs) {
      const state = this.serverState.get(name) ?? { connected: false, toolCount: 0 };
      servers.set(name, { config: cfg, connected: state.connected, toolCount: state.toolCount, autoConnect: cfg.autoConnect });
    }
    return { servers };
  }

  /**
   * Shutdown all servers.
   */
  async shutdown(): Promise<void> {
    for (const name of this.registry.getServerNames()) {
      try {
        await this.disconnectServer(name);
      } catch { /* best effort */ }
    }
  }
}
