import { describe, it, expect } from "vitest";
import { LspClient } from "./lsp-client.js";

describe("LspClient", () => {
  it("creates client with root path", () => {
    const client = new LspClient("/tmp/test-project");
    expect(client).toBeDefined();
    expect(client.isConnected()).toBe(false);
  });

  it("isConnected returns false before start", () => {
    const client = new LspClient("/tmp");
    expect(client.isConnected()).toBe(false);
  });

  it("getAllDiagnostics returns empty when no diagnostics received", () => {
    const client = new LspClient("/tmp");
    const diags = client.getAllDiagnostics();
    expect(diags.size).toBe(0);
  });
});

describe("createDiagnosticsTool", () => {
  it("createDiagnosticsTool returns an AgentTool", async () => {
    const { createDiagnosticsTool } = await import("./diagnostics-tool.js");
    const tool = createDiagnosticsTool("/tmp/test-project");

    expect(tool.toolName).toBe("getDiagnostics");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.description).toContain("diagnostics");
  });
});

import { LspClient as LspClient178 } from "./lsp-client.js";

describe("LspClient definition/references/hover (#178)", () => {
  it("returns empty/null gracefully when no server is connected", async () => {
    const client = new LspClient178(process.cwd());
    expect(await client.definition("src/index.ts", 0, 0)).toEqual([]);
    expect(await client.references("src/index.ts", 0, 0)).toEqual([]);
    expect(await client.hover("src/index.ts", 0, 0)).toBeNull();
  });
});
