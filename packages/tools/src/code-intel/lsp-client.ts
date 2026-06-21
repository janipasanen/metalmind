import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LspLocation {
  filePath: string;
  line: number;
  character: number;
}

export interface LspDiagnostic {
  filePath: string;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  code?: string;
  source?: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Lightweight LSP client for diagnostics via stdio JSON-RPC.
 * Targets TypeScript/JavaScript via typescript-language-server.
 */
export class LspClient {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private connected = false;
  private rootPath: string;
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private opened = new Set<string>();
  private docVersions = new Map<string, number>();

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  /**
   * Start the language server and initialize.
   */
  async start(): Promise<void> {
    if (this.connected) return;

    const command = this.findServerCommand();
    const args = this.getServerArgs();

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.rootPath,
    });

    this.process.on("exit", () => {
      this.connected = false;
    });

    this.rl = createInterface({ input: this.process.stdout! });

    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          this.handleDiagnostics(msg.params as PublishDiagnosticsParams);
        }
      } catch {
        // ignore non-JSON
      }
    });

    // Initialize
    await this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${this.rootPath}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
        },
      },
    });

    this.sendNotification("initialized", {});
    this.connected = true;
  }

  /**
   * Request diagnostics for a specific file.
   */
  async getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    // Sync the file's CURRENT content to the server (the old code sent text:"",
    // so diagnostics were computed against an empty buffer) (#221).
    const uri = this.syncDocument(filePath);

    // Wait briefly for diagnostics to arrive
    await new Promise((r) => setTimeout(r, 500));

    return this.diagnostics.get(uri) ?? [];
  }

  /** Send the file's real content via didOpen (first time) or didChange (subsequent),
   *  so diagnostics/positions reflect the file as it is on disk now (#221). */
  private syncDocument(filePath: string): string {
    const absPath = resolve(this.rootPath, filePath);
    const uri = `file://${absPath}`;
    let text = "";
    try {
      text = readFileSync(absPath, "utf-8");
    } catch {
      text = "";
    }
    if (!this.opened.has(uri)) {
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: this.getLanguageId(filePath), version: 1, text },
      });
      this.opened.add(uri);
      this.docVersions.set(uri, 1);
    } else {
      const version = (this.docVersions.get(uri) ?? 1) + 1;
      this.docVersions.set(uri, version);
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }], // full-document sync
      });
    }
    return uri;
  }

  /**
   * Get all cached diagnostics.
   */
  getAllDiagnostics(): Map<string, LspDiagnostic[]> {
    return new Map(this.diagnostics);
  }

  /** Open a document with its real content so position-based requests work. */
  private ensureOpen(filePath: string): string {
    const absPath = resolve(this.rootPath, filePath);
    const uri = `file://${absPath}`;
    if (!this.opened.has(uri)) {
      let text = "";
      try {
        text = readFileSync(absPath, "utf-8");
      } catch {
        text = "";
      }
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: this.getLanguageId(filePath), version: 1, text },
      });
      this.opened.add(uri);
      this.docVersions.set(uri, 1);
    }
    return uri;
  }

  /** textDocument/definition at a 0-based position (#178). */
  async definition(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this.connected) return [];
    const uri = this.ensureOpen(filePath);
    await new Promise((r) => setTimeout(r, 200));
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    }).catch(() => null);
    return this.parseLocations(result);
  }

  /** textDocument/references at a 0-based position (#178). */
  async references(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this.connected) return [];
    const uri = this.ensureOpen(filePath);
    await new Promise((r) => setTimeout(r, 200));
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    }).catch(() => null);
    return this.parseLocations(result);
  }

  /** textDocument/hover at a 0-based position; returns the hover text (#178). */
  async hover(filePath: string, line: number, character: number): Promise<string | null> {
    if (!this.connected) return null;
    const uri = this.ensureOpen(filePath);
    await new Promise((r) => setTimeout(r, 200));
    const result = (await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    }).catch(() => null)) as { contents?: unknown } | null;
    return this.parseHover(result);
  }

  private parseLocations(result: unknown): LspLocation[] {
    const arr = Array.isArray(result) ? result : result ? [result] : [];
    return arr
      .filter((l): l is { uri: string; range?: { start?: { line?: number; character?: number } } } => !!l && typeof (l as { uri?: unknown }).uri === "string")
      .map((l) => ({
        filePath: l.uri.replace("file://", ""),
        line: l.range?.start?.line ?? 0,
        character: l.range?.start?.character ?? 0,
      }));
  }

  private parseHover(result: { contents?: unknown } | null): string | null {
    const c = result?.contents;
    if (!c) return null;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x === "string" ? x : (x as { value?: string })?.value ?? "")).filter(Boolean).join("\n") || null;
    }
    return (c as { value?: string }).value ?? null;
  }

  /**
   * Shutdown the LSP server.
   */
  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", {});
      this.sendNotification("exit", {});
    } catch {
      // best effort
    }
    this.rl?.close();
    this.process?.kill();
    this.process = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private findServerCommand(): string {
    // Try npx first, fall back to direct
    return "npx";
  }

  private getServerArgs(): string[] {
    return ["-y", "typescript-language-server", "--stdio"];
  }

  private getLanguageId(filePath: string): string {
    if (filePath.endsWith(".tsx")) return "typescriptreact";
    if (filePath.endsWith(".ts")) return "typescript";
    if (filePath.endsWith(".jsx")) return "javascriptreact";
    return "javascript";
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;

      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request timeout: ${method}`));
        }
      }, 30_000);

      // Clear the timer on every settle path (response, error, dispose), so the
      // 30s timer doesn't linger after a fast reply (#245).
      this.pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timeout); resolve(v); },
        reject: (e: Error) => { clearTimeout(timeout); reject(e); },
      });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process?.stdin?.write(msg);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process?.stdin?.write(msg);
  }

  private handleDiagnostics(params: PublishDiagnosticsParams): void {
    const fileUri = params.uri;
    const diags: LspDiagnostic[] = (params.diagnostics ?? []).map((d) => ({
      filePath: fileUri.replace("file://", ""),
      range: {
        startLine: d.range.start.line,
        startCharacter: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
      },
      severity: this.mapSeverity(d.severity),
      message: d.message,
      code: d.code ? String(d.code) : undefined,
      source: d.source,
    }));
    this.diagnostics.set(fileUri, diags);
  }

  private mapSeverity(
    severity: number | undefined,
  ): LspDiagnostic["severity"] {
    switch (severity) {
      case 1:
        return "error";
      case 2:
        return "warning";
      case 3:
        return "information";
      case 4:
        return "hint";
      default:
        return "information";
    }
  }
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    severity?: number;
    message: string;
    code?: string | number;
    source?: string;
  }>;
}
