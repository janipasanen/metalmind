import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DiffPreview {
  path: string;
  original: string;
  modified: string;
  patch: string;
}

export class DiffGenerator {
  static previewEdit(
    path: string,
    projectRoot: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): DiffPreview {
    const resolved = resolve(projectRoot, path);
    const original = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";

    const modified = replaceAll
      ? original.replaceAll(oldString, newString)
      : original.replace(oldString, newString);

    const patch = this.generatePatch(path, original, modified);
    return { path, original, modified, patch };
  }

  static previewWrite(path: string, projectRoot: string, content: string): DiffPreview {
    const resolved = resolve(projectRoot, path);
    const original = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
    const patch = this.generatePatch(path, original, content);
    return { path, original, modified: content, patch };
  }

  static generatePatch(filePath: string, original: string, modified: string): string {
    const origLines = original.split("\n");
    const modLines = modified.split("\n");
    const maxLen = Math.max(origLines.length, modLines.length);
    const contextSize = 3;
    const lines: string[] = [];
    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);

    let inHunk = false;
    let hunkLines: string[] = [];

    for (let i = 0; i < maxLen; i++) {
      const orig = i < origLines.length ? origLines[i] : undefined;
      const mod = i < modLines.length ? modLines[i] : undefined;

      if (orig === mod) {
        if (inHunk) {
          hunkLines.push(` ${orig}`);
          if (hunkLines.some((l) => l.startsWith("-") || l.startsWith("+"))) {
            lines.push(...hunkLines);
          }
          hunkLines = [];
          inHunk = false;
        }
      } else {
        if (!inHunk) {
          const start = Math.max(0, i - contextSize);
          for (let j = start; j < i; j++) {
            lines.push(` ${origLines[j]}`);
          }
          inHunk = true;
          hunkLines = [];
        }
        if (orig !== undefined) hunkLines.push(`-${orig}`);
        if (mod !== undefined) hunkLines.push(`+${mod}`);
      }
    }

    if (hunkLines.length > 0) lines.push(...hunkLines);
    if (lines.length <= 2) {
      const total = Math.max(origLines.length, modLines.length);
      lines.push(`@@ -1,${origLines.length} +1,${modLines.length} @@`);
    }

    return lines.join("\n");
  }
}
