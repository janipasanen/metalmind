import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DiffPreview {
  path: string;
  original: string;
  modified: string;
  patch: string;
}

type Op = { t: " " | "-" | "+"; s: string };

/** Context lines around each hunk. */
const CONTEXT = 3;
/** LCS is O(n·m); beyond this we emit a summary instead of a bogus diff. */
const MAX_CELLS = 4_000_000;

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

  /** Preview a multiEdit batch: apply each edit in-memory (grouped per file, in
   *  order) and emit one bounded unified diff per touched file (#279). */
  static previewMultiEdit(
    edits: Array<{ path: string; oldString: string; newString: string; replaceAll?: boolean }>,
    projectRoot: string,
    opts: { maxFiles?: number; maxLinesPerFile?: number } = {},
  ): string {
    const maxFiles = opts.maxFiles ?? 10;
    const maxLines = opts.maxLinesPerFile ?? 40;
    const buffers = new Map<string, { original: string; current: string }>();
    for (const e of edits) {
      let buf = buffers.get(e.path);
      if (!buf) {
        const resolved = resolve(projectRoot, e.path);
        const original = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
        buf = { original, current: original };
        buffers.set(e.path, buf);
      }
      buf.current = e.replaceAll
        ? buf.current.replaceAll(e.oldString, e.newString)
        : buf.current.replace(e.oldString, e.newString);
    }
    const files = [...buffers.entries()];
    const parts: string[] = [];
    for (const [path, buf] of files.slice(0, maxFiles)) {
      const patch = this.generatePatch(path, buf.original, buf.current);
      const lines = patch.split("\n");
      parts.push(lines.length > maxLines ? lines.slice(0, maxLines).join("\n") + `\n…(+${lines.length - maxLines} more diff lines)` : patch);
    }
    if (files.length > maxFiles) parts.push(`…(+${files.length - maxFiles} more files)`);
    return parts.join("\n");
  }

  /** Real unified diff (LCS line alignment + proper @@ hunk headers). An inserted
   *  or deleted line no longer cascades into the rest of the file (#278). */
  static generatePatch(filePath: string, original: string, modified: string): string {
    const a = original.split("\n");
    const b = modified.split("\n");
    const header = [`--- a/${filePath}`, `+++ b/${filePath}`];

    if (original === modified) {
      return [...header, "@@ (no changes) @@"].join("\n");
    }
    if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
      return [...header, `@@ file too large for an inline diff (${a.length} → ${b.length} lines) @@`].join("\n");
    }

    // LCS DP table (row-major (n+1)×(m+1)), then a standard backtrack into ops.
    const n = a.length;
    const m = b.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
      }
    }
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ t: " ", s: a[i] });
        i++; j++;
      } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
        ops.push({ t: "-", s: a[i] });
        i++;
      } else {
        ops.push({ t: "+", s: b[j] });
        j++;
      }
    }
    while (i < n) ops.push({ t: "-", s: a[i++] });
    while (j < m) ops.push({ t: "+", s: b[j++] });

    // Per-op source line numbers for the @@ headers.
    const aAt: number[] = [];
    const bAt: number[] = [];
    let aLine = 1;
    let bLine = 1;
    for (const o of ops) {
      aAt.push(aLine);
      bAt.push(bLine);
      if (o.t !== "+") aLine++;
      if (o.t !== "-") bLine++;
    }

    // Group changed ops into hunks with CONTEXT lines, merging near hunks.
    const changed: number[] = [];
    for (let k = 0; k < ops.length; k++) if (ops[k].t !== " ") changed.push(k);
    const hunks: Array<{ start: number; end: number }> = [];
    let hs = Math.max(0, changed[0] - CONTEXT);
    let he = Math.min(ops.length - 1, changed[0] + CONTEXT);
    for (const k of changed.slice(1)) {
      if (k - CONTEXT <= he + 1) he = Math.min(ops.length - 1, k + CONTEXT);
      else {
        hunks.push({ start: hs, end: he });
        hs = Math.max(0, k - CONTEXT);
        he = Math.min(ops.length - 1, k + CONTEXT);
      }
    }
    hunks.push({ start: hs, end: he });

    const out = [...header];
    for (const h of hunks) {
      let aCount = 0;
      let bCount = 0;
      for (let k = h.start; k <= h.end; k++) {
        if (ops[k].t !== "+") aCount++;
        if (ops[k].t !== "-") bCount++;
      }
      out.push(`@@ -${aAt[h.start]},${aCount} +${bAt[h.start]},${bCount} @@`);
      for (let k = h.start; k <= h.end; k++) out.push(`${ops[k].t}${ops[k].s}`);
    }
    return out.join("\n");
  }
}
