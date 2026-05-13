import { describe, it, expect } from "vitest";
import { PermissionManager } from "./permission-manager.js";

describe("PermissionManager", () => {
  it("defaults to ask for writes", () => {
    const pm = new PermissionManager();
    expect(pm.needsConfirmation("allowWriteFiles")).toBe(true);
  });

  it("allows reads by default", () => {
    const pm = new PermissionManager();
    expect(pm.isAllowed("allowReadFiles")).toBe(true);
  });

  it("requires confirmation for shell commands by default", () => {
    const pm = new PermissionManager();
    expect(pm.needsConfirmation("allowShellCommands")).toBe(true);
  });

  it("does not need confirmation when set to true", () => {
    const pm = new PermissionManager();
    pm.allowWriteFiles = true;
    expect(pm.needsConfirmation("allowWriteFiles")).toBe(false);
    expect(pm.isAllowed("allowWriteFiles")).toBe(true);
  });

  it("blocks when set to false", () => {
    const pm = new PermissionManager();
    pm.allowDeleteFiles = false;
    expect(pm.isBlocked("allowDeleteFiles")).toBe(true);
  });

  it("returns false for unknown actions", () => {
    const pm = new PermissionManager();
    expect(pm.isAllowed("unknownAction")).toBe(false);
  });
});

describe("PermissionManager MCP tool permissions", () => {
  it("defaults to ask for MCP tools", () => {
    const pm = new PermissionManager();
    expect(pm.needsConfirmation("allowMcpTools")).toBe(true);
  });

  it("checkMcpTool defaults to global permission (ask)", () => {
    const pm = new PermissionManager();
    const result = pm.checkMcpTool("filesystem", "read_file");
    expect(result.needsConfirmation).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("checkMcpTool allows when global is true", () => {
    const pm = new PermissionManager();
    pm.allowMcpTools = true;
    const result = pm.checkMcpTool("filesystem", "read_file");
    expect(result.needsConfirmation).toBe(false);
    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("checkMcpTool blocks when global is false", () => {
    const pm = new PermissionManager();
    pm.allowMcpTools = false;
    const result = pm.checkMcpTool("filesystem", "read_file");
    expect(result.needsConfirmation).toBe(false);
    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("checkMcpTool respects per-server permission", () => {
    const pm = new PermissionManager();
    pm.allowMcpTools = false; // blocked globally
    pm.mcpServerPermissions["filesystem"] = true; // but allowed for this server
    const result = pm.checkMcpTool("filesystem", "read_file");
    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("checkMcpTool respects per-tool permission override", () => {
    const pm = new PermissionManager();
    pm.allowMcpTools = true; // allowed globally
    pm.mcpToolPermissions["filesystem:delete_file"] = false; // but blocked for this tool
    const result = pm.checkMcpTool("filesystem", "delete_file");
    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("checkMcpTool per-tool takes priority over per-server", () => {
    const pm = new PermissionManager();
    pm.mcpServerPermissions["filesystem"] = false; // server blocked
    pm.mcpToolPermissions["filesystem:read_file"] = true; // but tool allowed
    const result = pm.checkMcpTool("filesystem", "read_file");
    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("checkMcpTool ask for per-server overrides global allow", () => {
    const pm = new PermissionManager();
    pm.allowMcpTools = true; // allowed globally
    pm.mcpServerPermissions["unsafe-server"] = "ask"; // but ask for this server
    const result = pm.checkMcpTool("unsafe-server", "any_tool");
    expect(result.needsConfirmation).toBe(true);
    expect(result.allowed).toBe(true);
  });
});
