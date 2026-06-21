import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  public connected = false;
  public tools: McpToolDef[] = [];
  private config: McpServerConfig;

  constructor(config: McpServerConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const args = this.config.args ?? [];
    const env = { ...process.env, ...this.config.env };

    this.process = spawn(this.config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.config.cwd,
    });

    this.process.on("exit", (code) => {
      this.connected = false;
      this.emit("disconnect", code);
      this.rejectAll(new Error(`MCP server exited with code ${code}`));
    });

    // A spawn failure (e.g. ENOENT for an unknown command) fires 'error'
    // asynchronously. Without this handler the pending initialize never settles
    // and connect() hangs; reject it so a bad stdio server fails fast (#155).
    this.process.on("error", (err: Error) => {
      this.connected = false;
      // Note: do NOT emit "error" — an EventEmitter with no 'error' listener
      // throws. Surface via "stderr" and reject the pending connect instead.
      this.emit("stderr", `spawn error: ${err.message}`);
      this.rejectAll(new Error(`MCP server "${this.config.name}" failed to start: ${err.message}`));
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.emit("stderr", data.toString());
    });

    // Swallow stdin errors (e.g. EPIPE when writing after the child has closed
    // its pipe). Without a listener, Node turns these into unhandled 'error'
    // events that crash the host process.
    this.process.stdin?.on("error", (err: Error) => {
      this.emit("stderr", `stdin error: ${err.message}`);
    });

    this.rl = createInterface({ input: this.process.stdout! });

    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    });

    // Initialize: send initialize request
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "metalmind", version: "0.1.0" },
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});

    // Discover tools
    const toolsResult = (await this.request("tools/list", {})) as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
    this.tools = toolsResult.tools ?? [];

    this.connected = true;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args,
    });
    return result;
  }

  /**
   * Health check — returns true if the MCP server process is alive and connected.
   */
  isHealthy(): boolean {
    return this.connected && this.process !== null && !this.process.killed;
  }

  async disconnect(): Promise<void> {
    try {
      this.sendNotification("notifications/cancelled", {});
    } catch { /* ignore */ }

    this.rejectAll(new Error("Client disconnected"));
    this.rl?.close();
    this.process?.kill();
    this.process = null;
    this.connected = false;
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const payload = JSON.stringify(req) + "\n";

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30_000);

      // Wrap both settle paths so the timer is cleared whenever the request
      // resolves, errors, or is rejected via rejectAll — not just on a 30s
      // timeout. (The prior wrapper reassigned a local after the map already
      // held the original, so clearTimeout never actually ran. #245)
      this.pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timeout); resolve(v); },
        reject: (e: Error) => { clearTimeout(timeout); reject(e); },
      });
      this.writeToStdin(payload);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.writeToStdin(payload);
  }

  /**
   * Writes to the child's stdin, tolerating a closed/destroyed pipe. The async
   * error path is also covered by the 'error' listener attached in connect().
   */
  private writeToStdin(payload: string): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(payload, (err) => {
        if (err) this.emit("stderr", `stdin write failed: ${err.message}`);
      });
    } catch (err) {
      this.emit("stderr", `stdin write threw: ${(err as Error).message}`);
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, { reject }] of this.pending) {
      this.pending.delete(id);
      reject(err);
    }
  }
}
