import type { SymbolInfo, ParseResult } from "./tree-sitter-parser.js";

export interface ReferenceInfo {
  symbolName: string;
  filePath: string;
  range: { startRow: number; startColumn: number; endRow: number; endColumn: number };
  context: string; // surrounding line
}

/**
 * Indexes symbol definitions and references for findSymbol/findReferences tools.
 */
export class ReferenceIndex {
  private definitions = new Map<string, Map<string, SymbolInfo>>(); // filename -> symbolName -> SymbolInfo
  private references = new Map<string, ReferenceInfo[]>(); // symbolName -> references
  private callGraph = new Map<string, Set<string>>(); // caller -> callees

  /**
   * Index symbols and references from a parsed file.
   */
  indexFile(filePath: string, result: ParseResult, source: string): void {
    // Re-indexing the same file used to APPEND its references again, so every
    // save inflated findReferences counts (10 edits => 10x the real hits) and
    // grew memory without bound. Drop this file's previous entries first (#399).
    this.purgeFile(filePath);

    const fileDefs = new Map<string, SymbolInfo>();

    // Register definitions
    for (const sym of result.symbols) {
      fileDefs.set(sym.name, sym);
    }

    // Collect all function names for cross-file call tracking
    for (const sym of result.symbols) {
      if (sym.kind === "function") {
        this.allFunctionNames.add(sym.name);
      }
    }

    // Track call graph from function bodies (using all known function names)
    for (const sym of result.symbols) {
      this.extractCalls(sym, source);
    }

    this.definitions.set(filePath, fileDefs);

    // Extract references (all identifier usages not at definition sites)
    this.extractReferences(filePath, result, source);
  }

  /**
   * Find a symbol by name across all indexed files.
   */
  findSymbol(name: string): {
    definitions: Array<{ filePath: string; symbol: SymbolInfo }>;
    references: ReferenceInfo[];
  } {
    const definitions: Array<{ filePath: string; symbol: SymbolInfo }> = [];
    for (const [filePath, fileDefs] of this.definitions) {
      const sym = fileDefs.get(name);
      if (sym) {
        definitions.push({ filePath, symbol: sym });
      }
    }

    return {
      definitions,
      references: this.references.get(name) ?? [],
    };
  }

  /**
   * Find all references to a symbol.
   */
  findReferences(name: string): ReferenceInfo[] {
    return this.references.get(name) ?? [];
  }

  /**
   * Get callers of a function.
   */
  getCallers(functionName: string): string[] {
    const callers: string[] = [];
    for (const [caller, callees] of this.callGraph) {
      if (callees.has(functionName)) {
        callers.push(caller);
      }
    }
    return callers;
  }

  /**
   * Get callees of a function.
   */
  getCallees(functionName: string): string[] {
    return [...(this.callGraph.get(functionName) ?? [])];
  }

  /**
   * Get call graph as adjacency list.
   */
  getCallGraph(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [caller, callees] of this.callGraph) {
      result[caller] = [...callees];
    }
    return result;
  }

  /**
   * Get all indexed file paths.
   */
  getFiles(): string[] {
    return [...this.definitions.keys()];
  }

  private allFunctionNames = new Set<string>();

  clear(): void {
    this.definitions.clear();
    this.references.clear();
    this.callGraph.clear();
    this.allFunctionNames.clear();
  }

  private extractReferences(filePath: string, result: ParseResult, source: string): void {
    const lines = source.split("\n");
    const defRanges = new Set<string>();

    // Collect definition ranges so we don't count them as references
    for (const sym of result.symbols) {
      defRanges.add(`${sym.range.startRow}:${sym.range.startColumn}`);
    }

    // For each symbol, find other occurrences in the source
    for (const sym of result.symbols) {
      const refs = this.findIdentifierOccurrences(
        sym.name,
        lines,
        filePath,
        defRanges,
        sym,
      );
      if (refs.length > 0) {
        const existing = this.references.get(sym.name) ?? [];
        existing.push(...refs);
        this.references.set(sym.name, existing);
      }
    }
  }

  private findIdentifierOccurrences(
    name: string,
    lines: string[],
    filePath: string,
    defRanges: Set<string>,
    symbol: SymbolInfo,
  ): ReferenceInfo[] {
    const refs: ReferenceInfo[] = [];

    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      if (!line) continue;

      let col = 0;
      while (col < line.length) {
        const idx = line.indexOf(name, col);
        if (idx === -1) break;

        // Check it's a word boundary match
        const before = idx > 0 ? line[idx - 1] : " ";
        const after = idx + name.length < line.length ? line[idx + name.length] : " ";
        const isWordBoundary = !/[a-zA-Z0-9_$]/.test(before!) && !/[a-zA-Z0-9_$]/.test(after!);

        if (isWordBoundary) {
          const rangeKey = `${row}:${idx}`;
          if (!defRanges.has(rangeKey)) {
            refs.push({
              symbolName: name,
              filePath,
              range: {
                startRow: row,
                startColumn: idx,
                endRow: row,
                endColumn: idx + name.length,
              },
              context: line.trim(),
            });
          }
        }

        col = idx + 1;
      }
    }

    return refs;
  }

  /** Remove every entry contributed by `filePath` (#399). */
  private purgeFile(filePath: string): void {
    const previous = this.definitions.get(filePath);
    this.definitions.delete(filePath);
    for (const [name, refs] of this.references) {
      const kept = refs.filter((r) => r.filePath !== filePath);
      if (kept.length === 0) this.references.delete(name);
      else if (kept.length !== refs.length) this.references.set(name, kept);
    }
    // Call-graph entries are keyed by symbol name; drop the ones this file owned.
    for (const name of previous?.keys() ?? []) this.callGraph.delete(name);
  }

  /** All indexed symbol names — used to suggest near-misses on a lookup (#395). */
  allSymbolNames(): string[] {
    const names = new Set<string>();
    for (const fileDefs of this.definitions.values()) {
      for (const n of fileDefs.keys()) names.add(n);
    }
    return [...names];
  }

  private extractCalls(sym: SymbolInfo, source: string): void {
    if (sym.kind !== "function") return;

    // Get the function body text
    const lines = source.split("\n");
    const bodyLines = lines.slice(sym.range.startRow, sym.range.endRow + 1);
    const bodyText = bodyLines.join("\n");

    // Scan the body ONCE for `identifier(` and intersect with known function
    // names, instead of running a fresh regex over the body for every known
    // function (#398). The old loop was O(functions x symbols x bodySize) — on a
    // large monorepo that is minutes of blocked event loop; this is linear.
    const callees = new Set<string>();
    const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = CALL.exec(bodyText)) !== null) {
      const name = m[1];
      if (name === sym.name) continue; // skip self
      if (this.allFunctionNames.has(name)) callees.add(name);
    }

    if (callees.size > 0) {
      this.callGraph.set(sym.name, callees);
    }
  }
}

