export interface McpToolPermission {
  allow: boolean | "ask";
}

export class PermissionManager {
  allowReadFiles: boolean | "ask" = true;
  allowWriteFiles: boolean | "ask" = "ask";
  allowDeleteFiles: boolean | "ask" = "ask";
  allowShellCommands: boolean | "ask" = "ask";
  allowGitCommit: boolean | "ask" = "ask";
  allowMcpTools: boolean | "ask" = "ask";

  /** Per-server MCP tool permissions. Key = server name, value = allow/ask/deny */
  mcpServerPermissions: Record<string, boolean | "ask"> = {};

  /** Per-tool MCP permission overrides. Key = "serverName:toolName" or "toolName" wildcard */
  mcpToolPermissions: Record<string, boolean | "ask"> = {};

  needsConfirmation(action: string): boolean {
    const setting = this[action as keyof PermissionManager] ?? "ask";
    return setting === "ask";
  }

  isAllowed(action: string): boolean {
    const setting = this[action as keyof PermissionManager] ?? false;
    return setting === true;
  }

  isBlocked(action: string): boolean {
    const setting = this[action as keyof PermissionManager];
    return setting === false;
  }

  /**
   * Check if an MCP tool needs confirmation, is allowed, or is blocked.
   * Priority: per-tool > per-server > global allowMcpTools.
   */
  checkMcpTool(serverName: string, toolName: string): {
    needsConfirmation: boolean;
    allowed: boolean;
    blocked: boolean;
  } {
    const toolKey = `${serverName}:${toolName}`;

    // Per-tool override
    if (this.mcpToolPermissions[toolKey] !== undefined) {
      const val = this.mcpToolPermissions[toolKey];
      if (val === false) return { needsConfirmation: false, allowed: false, blocked: true };
      if (val === true) return { needsConfirmation: false, allowed: true, blocked: false };
      return { needsConfirmation: true, allowed: true, blocked: false };
    }

    // Per-server override
    if (this.mcpServerPermissions[serverName] !== undefined) {
      const val = this.mcpServerPermissions[serverName];
      if (val === false) return { needsConfirmation: false, allowed: false, blocked: true };
      if (val === true) return { needsConfirmation: false, allowed: true, blocked: false };
      return { needsConfirmation: true, allowed: true, blocked: false };
    }

    // Global MCP permission
    const global = this.allowMcpTools;
    if (global === false) return { needsConfirmation: false, allowed: false, blocked: true };
    if (global === true) return { needsConfirmation: false, allowed: true, blocked: false };
    return { needsConfirmation: true, allowed: true, blocked: false };
  }
}
