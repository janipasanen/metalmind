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
