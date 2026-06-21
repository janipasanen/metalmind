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

describe("LspClient base-protocol framing (#251)", () => {
  it("writes Content-Length-framed messages (no trailing newline)", () => {
    const client = new LspClient("/tmp") as unknown as {
      process: unknown;
      writeMessage(p: Record<string, unknown>): void;
    };
    const writes: string[] = [];
    client.process = { stdin: { write: (s: string) => writes.push(s) } };
    client.writeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });

    const m = /^Content-Length: (\d+)\r\n\r\n([\s\S]*)$/.exec(writes[0]);
    expect(m).not.toBeNull();
    expect(Buffer.byteLength(m![2], "utf8")).toBe(Number(m![1]));
    expect(JSON.parse(m![2]).method).toBe("initialize");
  });

  it("parses a framed response and resolves the pending request", () => {
    const client = new LspClient("/tmp") as unknown as {
      pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
      stdoutBuffer: Buffer;
      drainMessages(): void;
    };
    const got: unknown[] = [];
    client.pending.set(1, { resolve: (v) => got.push(v), reject: () => {} });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    client.stdoutBuffer = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    client.drainMessages();
    expect(got).toEqual([{ ok: true }]);
  });

  it("waits for the full body across chunk boundaries", () => {
    const client = new LspClient("/tmp") as unknown as {
      pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
      stdoutBuffer: Buffer;
      drainMessages(): void;
    };
    const got: unknown[] = [];
    client.pending.set(7, { resolve: (v) => got.push(v), reject: () => {} });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, result: 42 });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    // First half: header + partial body → nothing resolves yet.
    client.stdoutBuffer = Buffer.from(frame.slice(0, frame.length - 5));
    client.drainMessages();
    expect(got).toHaveLength(0);
    // Remainder arrives → message completes.
    client.stdoutBuffer = Buffer.concat([client.stdoutBuffer, Buffer.from(frame.slice(frame.length - 5))]);
    client.drainMessages();
    expect(got).toEqual([42]);
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
