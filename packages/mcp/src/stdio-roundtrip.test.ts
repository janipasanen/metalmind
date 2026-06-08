import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpClient, normalizeMcpResult } from "./index.js";

// A minimal stdio MCP server (CommonJS .cjs so node runs it regardless of repo type).
const SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  } else if (msg.method === 'tools/call') {
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) || '';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + text }] } });
  }
});
`;

describe("stdio MCP transport round-trip (#155)", () => {
  let dir: string;
  let serverPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mm-mcp-"));
    serverPath = join(dir, "server.cjs");
    writeFileSync(serverPath, SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("connects to a stdio server, discovers tools, and calls one", async () => {
    const client = new McpClient({ name: "fixture", command: "node", args: [serverPath] });
    await client.connect();
    try {
      expect(client.connected).toBe(true);
      expect(client.tools.map((t) => t.name)).toContain("echo");

      const result = await client.callTool("echo", { text: "hello stdio" });
      expect(normalizeMcpResult(result)).toContain("echo: hello stdio");
    } finally {
      await client.disconnect();
    }
  }, 15000);

  it("reports a spawn failure rather than hanging", async () => {
    const client = new McpClient({ name: "broken", command: "this-binary-does-not-exist-xyz" });
    await expect(client.connect()).rejects.toBeTruthy();
  }, 15000);
});
