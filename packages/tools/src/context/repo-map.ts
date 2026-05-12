import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";

export interface RepoMapEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  lastModified: Date;
}

export interface RepoMapOptions {
  excludeDirs?: string[];
  maxDepth?: number;
  maxFiles?: number;
}

const DEFAULT_EXCLUDE = ["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".venv", "vendor"];

export class RepoMap {
  private root: string;
  private options: RepoMapOptions;

  constructor(root: string, options: RepoMapOptions = {}) {
    this.root = root;
    this.options = options;
  }

  generate(): RepoMapEntry[] {
    const exclude = new Set(this.options.excludeDirs ?? DEFAULT_EXCLUDE);
    const maxDepth = this.options.maxDepth ?? Infinity;
    const maxFiles = this.options.maxFiles ?? 500;
    const results: RepoMapEntry[] = [];

    this.walk(this.root, exclude, maxDepth, 0, results, maxFiles);
    return results;
  }

  private walk(
    dir: string,
    exclude: Set<string>,
    maxDepth: number,
    currentDepth: number,
    results: RepoMapEntry[],
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
        results.push({
          path: relPath,
          type: "file",
          size: stat.size,
          lastModified: stat.mtime,
        });
      }
    }
  }

  toTreeString(): string {
    const entries = this.generate();
    return entries
      .map((e) => {
        const depth = e.path.split(sep).length - 1;
        const indent = "  ".repeat(Math.max(0, depth));
        return `${indent}${basename(e.path) || e.path}`;
      })
      .join("\n");
  }

  getSummary(): string {
    const entries = this.generate();
    const files = entries.filter((e) => e.type === "file");
    const dirs = entries.filter((e) => e.type === "directory");
    const totalSize = files.reduce((s, f) => s + f.size, 0);

    const byExt = new Map<string, number>();
    for (const f of files) {
      const ext = f.path.includes(".") ? f.path.split(".").pop() ?? "" : "(none)";
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    }

    const topExts = [...byExt.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => `  .${ext}: ${count}`)
      .join("\n");

    return `Project: ${basename(this.root)}
Files: ${files.length}
Directories: ${dirs.length}
Total size: ${this.formatSize(totalSize)}

Top extensions:
${topExts}`;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
