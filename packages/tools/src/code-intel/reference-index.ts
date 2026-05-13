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

  private extractCalls(sym: SymbolInfo, source: string): void {
    if (sym.kind !== "function") return;

    // Get the function body text
    const lines = source.split("\n");
    const bodyLines = lines.slice(sym.range.startRow, sym.range.endRow + 1);
    const bodyText = bodyLines.join("\n");

    // Find function calls in the body (simple heuristic: known function names followed by `(`)
    

    const callees = new Set<string>();
    for (const funcName of this.allFunctionNames) {
      if (funcName === sym.name) continue; // skip self
      // Check if funcName appears followed by ( in the body
      const callPattern = new RegExp(`\\b${escapeRegex(funcName)}\\s*\\(`);
      if (callPattern.test(bodyText)) {
        callees.add(funcName);
      }
    }

    if (callees.size > 0) {
      this.callGraph.set(sym.name, callees);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
