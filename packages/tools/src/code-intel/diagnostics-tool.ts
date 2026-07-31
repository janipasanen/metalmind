import { z } from "zod";
import { createTool, type AgentTool } from "../types.js";
import { LspClient, type LspDiagnostic } from "./lsp-client.js";
import { setLspClient } from "./symbol-tools.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const GetDiagnosticsSchema = z.object({
  filePath: z.string().optional().describe("Optional: specific file to check"),
});

/**
 * getDiagnostics tool — gets LSP diagnostics for files.
 */
export function createDiagnosticsTool(projectRoot: string): AgentTool {
  let client: LspClient | null = null;
  let lastStartAttempt = 0;
  // In-flight start, shared by concurrent callers (#427). Without it, a second
  // getDiagnostics arriving while the server was still starting saw
  // isConnected() === false, reported "LSP server is down", and could spawn a
  // SECOND language server.
  let starting: Promise<LspClient> | null = null;

  return createTool({
    toolName: "getDiagnostics",
    description:
      "Get language server diagnostics (errors, warnings, hints) for the project or a specific file.",
    inputSchema: GetDiagnosticsSchema,
    requiresConfirmation: false,
    async execute(input) {
      try {
        // Server died mid-session (crash/OOM/kill) — restart it, but at most
        // once per 30s so a crash-looping server degrades to a clear error
        // instead of a spawn storm (#337).
        // A start already in flight: wait for it instead of declaring the server
        // down or starting a competing one (#427).
        if (starting) {
          client = await starting;
        } else if (client && !client.isConnected()) {
          if (Date.now() - lastStartAttempt < 30_000) {
            return "LSP server is down and was restarted recently. Diagnostics temporarily unavailable — try again in ~30s.";
          }
          client = null;
        }
        if (!client) {
          lastStartAttempt = Date.now();
          starting = (async () => {
            const fresh = new LspClient(projectRoot);
            await fresh.start();
            // Share the running server so the symbol tools prefer LSP too (#178).
            setLspClient(fresh);
            return fresh;
          })();
          try {
            client = await starting;
          } finally {
            starting = null;
          }
        }

        let allDiagnostics: Map<string, LspDiagnostic[]>;

        if (input.filePath) {
          const absPath = resolve(projectRoot, input.filePath);
          if (!existsSync(absPath)) {
            return `File not found: ${input.filePath}`;
          }
          const diags = await client.getDiagnostics(absPath);
          allDiagnostics = new Map();
          allDiagnostics.set(absPath, diags);
        } else {
          allDiagnostics = client.getAllDiagnostics();
        }

        // Format output
        const entries = [...allDiagnostics.entries()];
        if (entries.length === 0 && !input.filePath) {
          return "No diagnostics available. Try checking a specific file with getDiagnostics({ filePath: \"src/file.ts\" }).";
        }

        if (input.filePath) {
          const [_, diags] = entries[0] ?? ["", []];
          if (diags.length === 0) {
            return `No diagnostics found for ${input.filePath}.`;
          }

          const bySeverity = groupBySeverity(diags);
          return formatDiagnosticGroup(input.filePath, bySeverity);
        }

        // Summarize all files
        const allDiags = entries.flatMap(([_, d]) => d);
        if (allDiags.length === 0) {
          return "No diagnostics found in any open files.";
        }

        const filesWithDiags = entries.filter(([_, d]) => d.length > 0);
        const errorCount = allDiags.filter((d) => d.severity === "error").length;
        const warnCount = allDiags.filter((d) => d.severity === "warning").length;

        let output = `Diagnostics summary: ${errorCount} errors, ${warnCount} warnings in ${filesWithDiags.length} files\n\n`;

        for (const [file, diags] of filesWithDiags.slice(0, 5)) {
          const shortPath = file.replace(projectRoot + "/", "");
          const bySev = groupBySeverity(diags);
          output += formatDiagnosticGroup(shortPath, bySev) + "\n";
        }

        if (filesWithDiags.length > 5) {
          output += `\n... and ${filesWithDiags.length - 5} more files with diagnostics`;
        }

        return output;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `LSP diagnostics unavailable: ${msg}. Make sure typescript-language-server is installed (npm install -g typescript-language-server typescript).`;
      }
    },
  });
}

function groupBySeverity(diagnostics: LspDiagnostic[]): Record<string, LspDiagnostic[]> {
  const groups: Record<string, LspDiagnostic[]> = {
    error: [],
    warning: [],
    information: [],
    hint: [],
  };
  for (const d of diagnostics) {
    groups[d.severity]?.push(d);
  }
  return groups;
}

function formatDiagnosticGroup(
  filePath: string,
  groups: Record<string, LspDiagnostic[]>,
): string {
  const lines: string[] = [];
  const icons: Record<string, string> = {
    error: "✗",
    warning: "⚠",
    information: "ℹ",
    hint: "💡",
  };

  for (const [severity, diags] of Object.entries(groups)) {
    if (diags.length === 0) continue;
    const icon = icons[severity] ?? "•";
    for (const d of diags.slice(0, 10)) {
      lines.push(
        `  ${icon} ${filePath}:${d.range.startLine + 1}:${d.range.startCharacter + 1} — ${d.message} [${severity}]`,
      );
    }
    if (diags.length > 10) {
      lines.push(`  ... and ${diags.length - 10} more ${severity}s`);
    }
  }

  return lines.join("\n");
}
