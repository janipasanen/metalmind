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

import { vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("LspClient getDiagnostics syncs real content (#221)", () => {
  it("sends the file's actual content via didOpen, not an empty buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-lsp221-"));
    writeFileSync(join(dir, "a.ts"), "export const x: number = 'oops';");
    const client = new LspClient(dir);
    const spy = vi
      .spyOn(client as unknown as { sendNotification: (m: string, p: unknown) => void }, "sendNotification")
      .mockImplementation(() => {});
    try {
      await client.getDiagnostics("a.ts");
      const open = spy.mock.calls.find((c) => c[0] === "textDocument/didOpen");
      expect(open).toBeDefined();
      const text = (open![1] as { textDocument: { text: string } }).textDocument.text;
      expect(text).toContain("export const x");
      expect(text).not.toBe("");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
