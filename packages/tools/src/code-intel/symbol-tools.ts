import { z } from "zod";
import { createTool, type AgentTool } from "../types.js";
import { parseSource } from "./tree-sitter-parser.js";
import { ReferenceIndex } from "./reference-index.js";
import type { LspClient } from "./lsp-client.js";
import { readFileSync, existsSync } from "node:fs";

/** Optional LSP client; when connected, symbol tools prefer it over the heuristic index (#178). */
let activeLspClient: LspClient | null = null;
export function setLspClient(client: LspClient | null): void {
  activeLspClient = client;
}

/** Shut down the shared language server, if one is running (#424).
 *  LspClient.shutdown() existed but nothing ever called it, so every agent
 *  rebuild (model switch, provider switch) left another typescript-language-
 *  server running for the lifetime of the terminal session. */
export async function shutdownLspClient(): Promise<void> {
  const client = activeLspClient;
  activeLspClient = null;
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    /* best-effort */
  }
}

const FindSymbolSchema = z.object({
  name: z.string().min(1).describe("Symbol name to find"),
  filePath: z.string().optional().describe("Limit search to this file"),
});

const FindReferencesSchema = z.object({
  name: z.string().min(1).describe("Symbol name to find references for"),
});

const GetCallGraphSchema = z.object({
  functionName: z.string().optional().describe("Optional: filter to a specific function"),
});

/**
 * Maintains a global reference index across tool invocations.
 */
let globalIndex: ReferenceIndex | null = null;

export function getReferenceIndex(): ReferenceIndex {
  if (!globalIndex) {
    globalIndex = new ReferenceIndex();
  }
  return globalIndex;
}

export function resetReferenceIndex(): void {
  globalIndex = new ReferenceIndex();
}

/**
 * Index a file into the global reference index.
 */
export function indexFile(filePath: string): void {
  if (!existsSync(filePath)) return;

  const source = readFileSync(filePath, "utf-8");
  const result = parseSource(source, filePath);
  const index = getReferenceIndex();
  index.indexFile(filePath, result, source);
}

/**
 * findSymbol tool — locates a symbol definition and its references.
 */
/** Up to 5 indexed symbol names closest to `name` (case-insensitive substring,
 *  then prefix), so a miss points somewhere useful instead of dumping paths (#395). */
function nearestSymbols(index: { allSymbolNames?: () => string[] }, name: string): string[] {
  const all = index.allSymbolNames?.() ?? [];
  if (all.length === 0) return [];
  const q = name.toLowerCase();
  const contains = all.filter((n) => n.toLowerCase().includes(q));
  const prefix = all.filter((n) => q.length >= 3 && n.toLowerCase().startsWith(q.slice(0, 3)));
  return [...new Set([...contains, ...prefix])].slice(0, 5);
}

export const findSymbolTool: AgentTool = createTool({
  toolName: "findSymbol",
  description:
    "Find a symbol definition across the codebase. Returns definition locations and references.",
  inputSchema: FindSymbolSchema,
  requiresConfirmation: false,
  async execute(input, ctx) {
    const index = getReferenceIndex();

    const result = index.findSymbol(input.name);

    if (result.definitions.length === 0) {
      // Do NOT dump every indexed path (#395): with 400 absolute paths that was
      // 6-40KB of unactionable text on a FAILURE path, crowding out context the
      // model needs. Give the count plus an actionable next step instead.
      const files = index.getFiles();
      const near = files.length
        ? nearestSymbols(index, input.name)
        : [];
      const hint = near.length
        ? ` Similar indexed symbols: ${near.join(", ")}.`
        : " Try `search` for a text match, or check the spelling/casing.";
      return `No symbol "${input.name}" found across ${files.length} indexed file(s).${hint}`;
    }

    const defLines = result.definitions.map(
      (d) =>
        `  ${d.filePath}:${d.symbol.range.startRow + 1} — ${d.symbol.kind} ${d.symbol.name}${d.symbol.exported ? " (exported)" : ""}`,
    );

    const refLines = result.references.slice(0, 20).map(
      (r) => `  ${r.filePath}:${r.range.startRow + 1} — ${r.context}`,
    );

    let output = `Symbol: ${input.name}\n`;
    output += `Definitions (${result.definitions.length}):\n${defLines.join("\n")}\n`;
    output += `References (${result.references.length}):\n${refLines.join("\n")}`;

    if (result.references.length > 20) {
      output += `\n  ... and ${result.references.length - 20} more references`;
    }

    // Call graph info
    const callers = index.getCallers(input.name);
    const callees = index.getCallees(input.name);
    if (callers.length > 0) {
      output += `\nCallers: ${callers.join(", ")}`;
    }
    if (callees.length > 0) {
      output += `\nCallees: ${callees.join(", ")}`;
    }

    return output;
  },
});

/**
 * findReferences tool — finds all usages of a symbol.
 */
export const findReferencesTool: AgentTool = createTool({
  toolName: "findReferences",
  description: "Find all references to a symbol across the codebase.",
  inputSchema: FindReferencesSchema,
  requiresConfirmation: false,
  async execute(input) {
    const index = getReferenceIndex();

    // Prefer real LSP references when a language server is connected (#178);
    // fall back to the heuristic index otherwise.
    if (activeLspClient?.isConnected()) {
      try {
        const def = index.findSymbol(input.name).definitions[0];
        if (def) {
          const locs = await activeLspClient.references(
            def.filePath,
            def.symbol.range.startRow,
            def.symbol.range.startColumn ?? 0,
          );
          if (locs.length > 0) {
            const lines = locs.slice(0, 30).map((l) => `  ${l.filePath}:${l.line + 1}`);
            return (
              `References to "${input.name}" via LSP (${locs.length}):\n${lines.join("\n")}` +
              (locs.length > 30 ? `\n  ... and ${locs.length - 30} more` : "")
            );
          }
        }
      } catch {
        // language server hiccup — fall through to the heuristic index
      }
    }

    const refs = index.findReferences(input.name);

    if (refs.length === 0) {
      return `No references found for "${input.name}".`;
    }

    const lines = refs.slice(0, 30).map(
      (r) => `  ${r.filePath}:${r.range.startRow + 1} — ${r.context}`,
    );

    let output = `References to "${input.name}" (${refs.length}):\n${lines.join("\n")}`;

    if (refs.length > 30) {
      output += `\n  ... and ${refs.length - 30} more`;
    }

    return output;
  },
});

/**
 * getCallGraph tool — shows call relationships.
 */
export const getCallGraphTool: AgentTool = createTool({
  toolName: "getCallGraph",
  description:
    "Show the call graph for the codebase or a specific function.",
  inputSchema: GetCallGraphSchema,
  requiresConfirmation: false,
  async execute(input) {
    const index = getReferenceIndex();

    if (input.functionName) {
      const callers = index.getCallers(input.functionName);
      const callees = index.getCallees(input.functionName);

      let output = `Call graph for "${input.functionName}":\n`;
      if (callers.length > 0) {
        output += `  Called by: ${callers.join(", ")}\n`;
      } else {
        output += `  Called by: (none — may be an entry point)\n`;
      }
      if (callees.length > 0) {
        output += `  Calls: ${callees.join(", ")}\n`;
      } else {
        output += `  Calls: (none — leaf function)\n`;
      }
      return output;
    }

    const graph = index.getCallGraph();
    if (Object.keys(graph).length === 0) {
      return "No call graph data available. Index some files first.";
    }

    const lines = Object.entries(graph).map(
      ([caller, callees]) => `  ${caller} → ${callees.join(", ")}`,
    );

    return `Call graph (${Object.keys(graph).length} functions):\n${lines.join("\n")}`;
  },
});

/**
 * All symbol-related tools.
 */
export const allSymbolTools: AgentTool[] = [
  findSymbolTool,
  findReferencesTool,
  getCallGraphTool,
];
