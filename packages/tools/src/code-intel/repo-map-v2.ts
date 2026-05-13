import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep, basename, dirname } from "node:path";
import { parseSource, type SymbolInfo } from "./tree-sitter-parser.js";
import { ReferenceIndex } from "./reference-index.js";
import type { RepoMapEntry } from "../context/repo-map.js";

export interface EnhancedEntry extends RepoMapEntry {
  symbols?: SymbolInfo[];
  importCount?: number;
  exportedSymbols?: number;
  relevanceScore?: number;
  dependencies?: string[];
}

export interface RepoMapV2Options {
  excludeDirs?: string[];
  maxDepth?: number;
  maxFiles?: number;
  includeSymbols?: boolean;
  includeImports?: boolean;
}

const DEFAULT_EXCLUDE = [
  "node_modules", ".git", "dist", ".next", "build",
  "__pycache__", ".venv", "vendor", "coverage",
];

/**
 * Enhanced repo map using Tree-sitter code structure, symbol index,
 * and import graphs for better context selection.
 */
export class RepoMapV2 {
  private root: string;
  private options: RepoMapV2Options;
  private referenceIndex = new ReferenceIndex();
  private dependencyGraph = new Map<string, Set<string>>(); // file -> files it imports from

  constructor(root: string, options: RepoMapV2Options = {}) {
    this.root = root;
    this.options = options;
  }

  /**
   * Generate an enhanced repo map with code intelligence.
   */
  generate(): EnhancedEntry[] {
    const exclude = new Set(this.options.excludeDirs ?? DEFAULT_EXCLUDE);
    const maxDepth = this.options.maxDepth ?? Infinity;
    const maxFiles = this.options.maxFiles ?? 500;
    const results: EnhancedEntry[] = [];

    this.walk(this.root, exclude, maxDepth, 0, results, maxFiles);

    // Build dependency graph and relevance scores
    if (this.options.includeImports) {
      this.computeRelevanceScores(results);
    }

    return results;
  }

  /**
   * Build the dependency graph from parsed imports.
   */
  getDependencyGraph(): Map<string, Set<string>> {
    return new Map(this.dependencyGraph);
  }

  /**
   * Get files that depend on a given file.
   */
  getDependents(filePath: string): string[] {
    const dependents: string[] = [];
    for (const [file, deps] of this.dependencyGraph) {
      if (deps.has(filePath)) {
        dependents.push(file);
      }
    }
    return dependents;
  }

  /**
   * Get files that a given file depends on.
   */
  getDependencies(filePath: string): string[] {
    return [...(this.dependencyGraph.get(filePath) ?? [])];
  }

  /**
   * Get the global reference index built during map generation.
   */
  getReferenceIndex(): ReferenceIndex {
    return this.referenceIndex;
  }

  /**
   * Generate a human-readable tree with code intelligence annotations.
   */
  toTreeString(): string {
    const entries = this.generate();
    return entries
      .map((e) => {
        const depth = e.path.split(sep).length - 1;
        const indent = "  ".repeat(Math.max(0, depth));
        const name = basename(e.path) || e.path;
        let annotation = "";

        if (e.exportedSymbols && e.exportedSymbols > 0) {
          annotation += ` [exports: ${e.exportedSymbols}]`;
        }
        if (e.symbols && e.symbols.length > 0) {
          const kinds = new Set(e.symbols.map((s) => s.kind));
          annotation += ` (${[...kinds].join(", ")})`;
        }
        if (e.dependencies && e.dependencies.length > 0) {
          annotation += ` → ${e.dependencies.length} deps`;
        }

        return `${indent}${name}${annotation}`;
      })
      .join("\n");
  }

  /**
   * Generate an enhanced summary with code intelligence metrics.
   */
  getSummary(): string {
    const entries = this.generate();
    const files = entries.filter((e) => e.type === "file");
    const dirs = entries.filter((e) => e.type === "directory");

    const totalSymbols = entries.reduce(
      (sum, e) => sum + (e.symbols?.length ?? 0), 0,
    );
    const totalExports = entries.reduce(
      (sum, e) => sum + (e.exportedSymbols ?? 0), 0,
    );
    const totalDeps = this.dependencyGraph.size;
    const mostReferenced = this.findMostReferenced(entries);

    return [
      `Project: ${basename(this.root)}`,
      `Files: ${files.length} | Dirs: ${dirs.length}`,
      `Symbols: ${totalSymbols} | Exports: ${totalExports}`,
      `Dependency graph: ${totalDeps} files with imports`,
      mostReferenced
        ? `Most referenced: ${mostReferenced.name} (${mostReferenced.count} refs)`
        : "",
      "",
      "Top files by relevance:",
      ...entries
        .filter((e) => e.type === "file" && (e.relevanceScore ?? 0) > 0)
        .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
        .slice(0, 10)
        .map((e) => `  ${e.path} (score: ${(e.relevanceScore ?? 0).toFixed(2)})`),
    ].join("\n");
  }

  private walk(
    dir: string,
    exclude: Set<string>,
    maxDepth: number,
    currentDepth: number,
    results: EnhancedEntry[],
    maxFiles: number,
  ): void {
    if (currentDepth > maxDepth || results.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries.sort()) {
      if (exclude.has(name) || name.startsWith(".")) continue;
      if (results.length >= maxFiles) return;

      const fullPath = join(dir, name);
      const relPath = relative(this.root, fullPath);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        results.push({
          path: relPath + sep,
          type: "directory",
          size: 0,
          lastModified: stat.mtime,
        });
        this.walk(fullPath, exclude, maxDepth, currentDepth + 1, results, maxFiles);
      } else if (stat.isFile()) {
        const entry: EnhancedEntry = {
          path: relPath,
          type: "file",
          size: stat.size,
          lastModified: stat.mtime,
        };

        // Parse code structure if enabled
        if (this.options.includeSymbols && this.isCodeFile(relPath)) {
          try {
            const source = readFileSync(fullPath, "utf-8");
            const parseResult = parseSource(source, relPath);
            entry.symbols = parseResult.symbols;
            entry.exportedSymbols = parseResult.symbols.filter(
              (s) => s.exported,
            ).length;
            entry.importCount = parseResult.imports.length;

            // Index into reference index
            this.referenceIndex.indexFile(relPath, parseResult, source);

            // Build dependency graph
            if (this.options.includeImports) {
              const deps = new Set<string>();
              for (const imp of parseResult.imports) {
                const resolved = this.resolveImport(imp.source, fullPath);
                if (resolved) deps.add(resolved);
              }
              entry.dependencies = [...deps];
              if (deps.size > 0) {
                this.dependencyGraph.set(relPath, deps);
              }
            }
          } catch {
            // Skip files that can't be parsed
          }
        }

        results.push(entry);
      }
    }
  }

  private isCodeFile(path: string): boolean {
    const codeExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    return codeExts.some((ext) => path.endsWith(ext));
  }

  private resolveImport(
    importPath: string,
    fromFile: string,
  ): string | null {
    const fromDir = dirname(fromFile);

    // Relative imports
    if (importPath.startsWith(".")) {
      const candidates = [
        join(fromDir, importPath + ".ts"),
        join(fromDir, importPath + ".tsx"),
        join(fromDir, importPath + ".js"),
        join(fromDir, importPath + ".jsx"),
        join(fromDir, importPath, "index.ts"),
        join(fromDir, importPath, "index.tsx"),
        join(fromDir, importPath, "index.js"),
      ];
      for (const candidate of candidates) {
        const absPath = join(this.root, candidate);
        if (existsSync(absPath)) {
          return candidate;
        }
      }
      return null;
    }

    // Package imports — skip for now
    return null;
  }

  private computeRelevanceScores(entries: EnhancedEntry[]): void {
    // Compute how many files depend on each file
    const depCount = new Map<string, number>();
    for (const [_, deps] of this.dependencyGraph) {
      for (const dep of deps) {
        depCount.set(dep, (depCount.get(dep) ?? 0) + 1);
      }
    }

    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const imports = entry.dependencies?.length ?? 0;
      const dependents = depCount.get(entry.path) ?? 0;
      const exports = entry.exportedSymbols ?? 0;
      const symbols = entry.symbols?.length ?? 0;

      // Relevance = weighted combination
      entry.relevanceScore =
        dependents * 3 + // High weight: many files depend on this
        exports * 2 + // Medium weight: exports are important
        imports * 0.5 + // Low weight: importing suggests integration
        symbols * 0.1; // Very low weight: just having symbols
    }
  }

  private findMostReferenced(
    entries: EnhancedEntry[],
  ): { name: string; count: number } | null {
    let best: { name: string; count: number } | null = null;
    const depCount = new Map<string, number>();
    for (const [_, deps] of this.dependencyGraph) {
      for (const dep of deps) {
        depCount.set(dep, (depCount.get(dep) ?? 0) + 1);
      }
    }
    for (const [name, count] of depCount) {
      if (!best || count > best.count) {
        best = { name: basename(name), count };
      }
    }
    return best;
  }
}
