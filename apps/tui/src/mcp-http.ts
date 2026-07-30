export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/** Handshake/list calls happen at startup and must not hang the TUI; tool calls
 *  get a longer budget because real work happens behind them (#379). */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

export class McpHttpClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private async rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    // Every request is time-bounded (#379): an unresponsive server used to block
    // startup forever behind a "connecting…" line with no way out but Ctrl+C.
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.extraHeaders },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s (${this.url} did not respond).`);
      }
      throw new Error(`MCP ${method} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(`MCP ${method} failed: 401 Unauthorized — run "/mcp auth <server>" to (re)authorize.`);
      }
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
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
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
    }, CALL_TIMEOUT_MS)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result?.isError) throw new Error(`MCP tool "${name}" returned an error`);
    return (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  /** List the resources a server exposes (#219). */
  async listResources(): Promise<McpResource[]> {
    const result = (await this.rpc("resources/list", {})) as { resources?: McpResource[] };
    return result?.resources ?? [];
  }

  /** Read a resource's text content by uri (#219). */
  async readResource(uri: string): Promise<string> {
    const result = (await this.rpc("resources/read", { uri })) as {
      contents?: Array<{ text?: string; blob?: string; mimeType?: string }>;
    };
    return (result?.contents ?? [])
      .map((c) => c.text ?? (c.blob ? `[binary ${c.mimeType ?? "data"}]` : ""))
      .filter(Boolean)
      .join("\n");
  }

  /** List the prompts a server exposes (#219). */
  async listPrompts(): Promise<McpPrompt[]> {
    const result = (await this.rpc("prompts/list", {})) as { prompts?: McpPrompt[] };
    return result?.prompts ?? [];
  }

  /** Fetch a prompt's messages, rendered to text (#219). */
  async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await this.rpc("prompts/get", { name, arguments: args })) as {
      messages?: Array<{ role: string; content?: { type: string; text?: string } | string }>;
    };
    return (result?.messages ?? [])
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : m.content?.text ?? "";
        return `${m.role}: ${text}`;
      })
      .join("\n");
  }
}
