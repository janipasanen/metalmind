import type { AgentTool, ToolExecutionContext } from "@metalmind/tools";
import type { PermissionManager } from "@metalmind/core";
import { z, type ZodSchema } from "zod";
import { McpClient, type McpServerConfig } from "./mcp-client.js";

export interface McpToolState {
  serverName: string;
  mcpToolName: string;
  connected: boolean;
}

export class McpToolRegistry {
  private permissionManager: PermissionManager | null = null;
  private clients = new Map<string, McpClient>();
  private toolMap = new Map<string, McpToolState>();
  private registeredTools = new Map<string, AgentTool>();

  /**
   * Set the permission manager for MCP tool permission checks.
   */
  setPermissionManager(pm: PermissionManager): void {
    this.permissionManager = pm;
  }

  /**
   * Connect to an MCP server, discover its tools, and register them.
   */
  async connectServer(config: McpServerConfig): Promise<string[]> {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server "${config.name}" already connected`);
    }

    const client = new McpClient(config);
    await client.connect();

    this.clients.set(config.name, client);

    const toolNames: string[] = [];
    for (const tool of client.tools) {
      const internalName = `mcp:${config.name}:${tool.name}`;
      this.toolMap.set(internalName, {
        serverName: config.name,
        mcpToolName: tool.name,
        connected: true,
      });

      const agentTool = this.createAgentTool(internalName, tool, config.name);
      this.registeredTools.set(internalName, agentTool);
      toolNames.push(internalName);
    }

    client.on("disconnect", () => {
      for (const [name, state] of this.toolMap) {
        if (state.serverName === config.name) {
          state.connected = false;
          this.registeredTools.delete(name);
        }
      }
    });

    return toolNames;
  }

  /**
   * Disconnect a server and unregister its tools.
   */
  async disconnectServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;

    await client.disconnect();
    this.clients.delete(name);

    for (const [toolName, state] of this.toolMap) {
      if (state.serverName === name) {
        this.toolMap.delete(toolName);
        this.registeredTools.delete(toolName);
      }
    }
  }

  /**
   * Get all registered MCP tools as AgentTool instances.
   */
  getTools(): AgentTool[] {
    return [...this.registeredTools.values()];
  }

  /**
   * Get a specific MCP tool by internal name.
   */
  getTool(name: string): AgentTool | undefined {
    return this.registeredTools.get(name);
  }

  /**
   * Check if a server is connected.
   */
  isConnected(serverName: string): boolean {
    return this.clients.has(serverName);
  }

  /**
   * Get all connected server names.
   */
  getServerNames(): string[] {
    return [...this.clients.keys()];
  }

  private createAgentTool(
    internalName: string,
    mcpTool: { name: string; description: string; inputSchema: Record<string, unknown> },
    serverName: string,
  ): AgentTool {
    const zodSchema = z.record(z.string(), z.unknown());

    return {
      toolName: internalName,
      description: mcpTool.description || `MCP tool: ${mcpTool.name} (server: ${serverName})`,
      inputSchema: zodSchema,
      requiresConfirmation: true,
      execute: async (input: Record<string, unknown> | undefined, ctx: ToolExecutionContext) => {
        // Check MCP tool permissions
        if (this.permissionManager) {
          const perm = this.permissionManager.checkMcpTool(serverName, mcpTool.name);
          if (perm.blocked) {
            throw new Error(
              `MCP tool "${mcpTool.name}" (server: ${serverName}) is blocked by permission policy`,
            );
          }
        }

        const client = this.clients.get(serverName);
        if (!client || !client.connected) {
          throw new Error(`MCP server "${serverName}" is not connected`);
        }

        const result = await client.callTool(mcpTool.name, input ?? {});
        const normalized = normalizeMcpResult(result);
        ctx.auditLog?.({
          timestamp: new Date().toISOString(),
          toolName: internalName,
          input: input ?? {},
          output: normalized,
          success: true,
        });
        return normalized;
      },
    };
  }
}

function normalizeMcpResult(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";

  if (typeof raw !== "object") return String(raw);

  const obj = raw as Record<string, unknown>;

  // MCP content array format
  const content = obj.content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  // Tool result with content
  const toolResult = obj.toolResult as Record<string, unknown> | undefined;
  const trContent = toolResult?.content;
  if (Array.isArray(trContent)) {
    return (trContent as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  // Simple result object
  if (obj.result !== undefined) return JSON.stringify(obj.result);

  return JSON.stringify(obj);
}

export { normalizeMcpResult };
