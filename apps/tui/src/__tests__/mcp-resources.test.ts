import { describe, it, expect, vi, afterEach } from "vitest";
import { McpHttpClient } from "../mcp-http.js";

/** Mock the JSON-RPC endpoint: respond based on the request method. */
function mockRpc(byMethod: Record<string, unknown>) {
  return vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: byMethod[method] ?? {} }),
      text: async () => "{}",
    };
  });
}

describe("McpHttpClient resources & prompts (#219)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists resources", async () => {
    vi.stubGlobal("fetch", mockRpc({
      "resources/list": { resources: [{ uri: "file:///a.md", name: "A" }, { uri: "db://t" }] },
    }));
    const client = new McpHttpClient("https://mcp.example/rpc");
    const res = await client.listResources();
    expect(res.map((r) => r.uri)).toEqual(["file:///a.md", "db://t"]);
  });

  it("reads a resource's text content", async () => {
    vi.stubGlobal("fetch", mockRpc({
      "resources/read": { contents: [{ text: "hello" }, { text: "world" }] },
    }));
    const client = new McpHttpClient("https://mcp.example/rpc");
    expect(await client.readResource("file:///a.md")).toBe("hello\nworld");
  });

  it("lists prompts", async () => {
    vi.stubGlobal("fetch", mockRpc({
      "prompts/list": { prompts: [{ name: "summarize", description: "Summarize text" }] },
    }));
    const client = new McpHttpClient("https://mcp.example/rpc");
    const prompts = await client.listPrompts();
    expect(prompts[0]).toEqual({ name: "summarize", description: "Summarize text" });
  });

  it("renders a prompt's messages to text", async () => {
    vi.stubGlobal("fetch", mockRpc({
      "prompts/get": { messages: [
        { role: "system", content: { type: "text", text: "You are helpful." } },
        { role: "user", content: "Hi" },
      ] },
    }));
    const client = new McpHttpClient("https://mcp.example/rpc");
    expect(await client.getPrompt("greet")).toBe("system: You are helpful.\nuser: Hi");
  });
});

describe("McpHttpClient 401 guidance (#225)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("turns a 401 into actionable re-auth guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "Unauthorized" }));
    const client = new McpHttpClient("https://mcp.example/rpc");
    await expect(client.listResources()).rejects.toThrow(/401 Unauthorized.*\/mcp auth/);
  });
});
