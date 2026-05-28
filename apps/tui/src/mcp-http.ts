export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpHttpClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) {
      throw new Error(`MCP ${method} failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) throw new Error(`MCP error: ${json.error.message}`);
    return json.result;
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "metalmind", version: "1.0.0" },
    });
    // Send initialized notification
    await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpToolDef[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = (await this.rpc("tools/call", {
      name,
      arguments: args ?? {},
    })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result?.isError) throw new Error(`MCP tool "${name}" returned an error`);
    return (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
}
