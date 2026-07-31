import { z } from "zod";
import {
  writeFileSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  readFileSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const writeFileTool: AgentTool<z.input<typeof writeFileSchema>, string> = createTool({
  toolName: "writeFile",
  description: "Write content to a file, overwriting if it exists.",
  inputSchema: writeFileSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof writeFileSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, input.content, "utf-8");
    return `Wrote ${input.content.length} bytes to ${input.path}`;
  },
});

const createFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().default(""),
});

export const createFileTool: AgentTool<z.input<typeof createFileSchema>, string> = createTool({
  toolName: "createFile",
  description: "Create a new file with optional content. Fails if already exists.",
  inputSchema: createFileSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof createFileSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    if (existsSync(safePath)) throw new Error(`File already exists: ${input.path}`);
    mkdirSync(dirname(safePath), { recursive: true });
    const content = input.content ?? "";
    writeFileSync(safePath, content, "utf-8");
    return `Created ${input.path} (${content.length} bytes)`;
  },
});

const editFileSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
});

/** A short line-numbered snippet at a KNOWN line of `content`, so the model can
 *  verify its edit landed without re-reading the file (#291). Anchored by the
 *  edit position (computed by the caller), not by text search — searching for
 *  newString's first line pointed at the wrong region whenever that line was
 *  empty ("" matches everything → top of file) or non-unique ("}", "return;"). */
function snippetAtLine(content: string, lineIdx: number, spanLines: number, context = 2): string {
  const lines = content.split("\n");
  const start = Math.max(0, lineIdx - context);
  const end = Math.min(lines.length, lineIdx + spanLines + context);
  const width = String(end).length;
  return lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(width)}→${l}`).join("\n");
}

/** When oldString doesn't match, explain the most likely reason so the model can
 *  self-correct instead of retrying blind (#292). */
function nearMissHint(original: string, oldString: string): string {
  // Whitespace-insensitive comparison: does it match modulo spacing?
  const squash = (s: string) => s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  if (squash(original).includes(squash(oldString))) {
    return "A near-match exists that differs only in whitespace/indentation — re-read the exact lines (readFile shows line numbers) and copy the indentation exactly.";
  }
  // Anchor on the longest line of oldString: if present, the mismatch is nearby.
  const anchor = oldString.split("\n").reduce((a, b) => (b.trim().length > a.trim().length ? b : a), "").trim();
  if (anchor.length >= 8) {
    const lines = original.split("\n");
    const at = lines.findIndex((l) => l.includes(anchor));
    if (at >= 0) {
      const start = Math.max(0, at - 2);
      const excerpt = lines.slice(start, at + 3).map((l, i) => `${start + i + 1}→${l}`).join("\n");
      return `A similar region exists around line ${at + 1} — the file differs from your oldString. Actual content:\n${excerpt}`;
    }
  }
  return "No similar content found — the file may have changed since you read it. Re-read it before editing.";
}

export const editFileTool: AgentTool<z.input<typeof editFileSchema>, string> = createTool({
  toolName: "editFile",
  description:
    "Edit a file by replacing an exact string. oldString must match the file exactly (including whitespace) " +
    "and be unique unless replaceAll is set. Returns a snippet of the edited region so you can verify the result.",
  inputSchema: editFileSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof editFileSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    if (!existsSync(safePath) || !statSync(safePath).isFile()) throw new Error(`File not found: ${input.path}`);
    const original = readFileSync(safePath, "utf-8");

    const replaceAll = input.replaceAll ?? false;
    if (replaceAll) {
      const count = original.split(input.oldString).length - 1;
      if (count === 0) {
        throw new Error(`String not found in ${input.path}. ${nearMissHint(original, input.oldString)}`);
      }
      // Function replacement (#438): a STRING replacement makes String.replace
      // expand $&, $`, $', $$ and $1 — so newString containing any of them
      // silently corrupted the file (and the diff preview). A function
      // replacement is inserted verbatim.
      const updated = original.replaceAll(input.oldString, () => input.newString);
      writeFileSync(safePath, updated, "utf-8");
      return `Replaced ${count} occurrence(s) in ${input.path}`;
    }

    if (!original.includes(input.oldString)) {
      throw new Error(`String not found in ${input.path}. ${nearMissHint(original, input.oldString)}`);
    }

    const occ = original.split(input.oldString).length - 1;
    if (occ > 1) {
      throw new Error(
        `Found ${occ} occurrences. Use replaceAll: true or include more surrounding context to make the match unique.`,
      );
    }

    const updated = original.replace(input.oldString, () => input.newString);
    writeFileSync(safePath, updated, "utf-8");
    // Anchor the verification snippet on the edit's actual position (known from
    // the unique match), not a text search for newString.
    const editPos = original.indexOf(input.oldString);
    const editLine = original.slice(0, editPos).split("\n").length - 1;
    const span = Math.max(1, input.newString.split("\n").length);
    const snip = snippetAtLine(updated, editLine, span);
    return snip ? `Edited ${input.path}. Result:\n${snip}` : `Edited ${input.path}`;
  },
});

const deleteFileSchema = z.object({
  path: z.string().min(1),
});

export const deleteFileTool: AgentTool<z.input<typeof deleteFileSchema>, string> = createTool({
  toolName: "deleteFile",
  description: "Delete a file permanently.",
  inputSchema: deleteFileSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof deleteFileSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    if (!existsSync(safePath)) throw new Error(`File not found: ${input.path}`);
    if (!statSync(safePath).isFile()) throw new Error(`Not a file: ${input.path}`);
    unlinkSync(safePath);
    return `Deleted ${input.path}`;
  },
});

const moveFileSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
});

export const moveFileTool: AgentTool<z.input<typeof moveFileSchema>, string> = createTool({
  toolName: "moveFile",
  description: "Move or rename a file or directory.",
  inputSchema: moveFileSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof moveFileSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safeSource = validator.resolveSafePath(input.source);
    const safeDest = validator.resolveSafePath(input.destination);
    if (!existsSync(safeSource)) throw new Error(`Source not found: ${input.source}`);
    mkdirSync(dirname(safeDest), { recursive: true });
    renameSync(safeSource, safeDest);
    return `Moved ${input.source} → ${input.destination}`;
  },
});

const createDirectorySchema = z.object({
  path: z.string().min(1),
});

export const createDirectoryTool: AgentTool<z.input<typeof createDirectorySchema>, string> = createTool({
  toolName: "createDirectory",
  description: "Create a new directory and parent directories.",
  inputSchema: createDirectorySchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof createDirectorySchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    if (existsSync(safePath)) throw new Error(`Path already exists: ${input.path}`);
    mkdirSync(safePath, { recursive: true });
    return `Created directory ${input.path}`;
  },
});

const deleteDirectorySchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false).describe("Delete a non-empty directory and its contents"),
});

export const deleteDirectoryTool: AgentTool<z.input<typeof deleteDirectorySchema>, string> = createTool({
  toolName: "deleteDirectory",
  description: "Delete a directory. Set recursive=true to remove a non-empty directory and all its contents.",
  inputSchema: deleteDirectorySchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof deleteDirectorySchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    if (!existsSync(safePath)) throw new Error(`Directory not found: ${input.path}`);
    if (!statSync(safePath).isDirectory()) throw new Error(`Not a directory: ${input.path}`);
    if (input.recursive) {
      rmSync(safePath, { recursive: true, force: true });
    } else {
      // rmdirSync removes an empty directory and throws ENOTEMPTY otherwise.
      rmdirSync(safePath);
    }
    return `Deleted directory ${input.path}${input.recursive ? " (recursively)" : ""}`;
  },
});

const multiEditSchema = z.object({
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        oldString: z.string().min(1),
        newString: z.string(),
        replaceAll: z.boolean().default(false),
      }),
    )
    .min(1)
    .describe("Edits applied as a single all-or-nothing transaction across one or more files."),
});

export const multiEditTool: AgentTool<z.input<typeof multiEditSchema>, string> = createTool({
  toolName: "multiEdit",
  description:
    "Apply a batch of find/replace edits across one or more files atomically. If any edit fails, ALL files are rolled back to their pre-operation state. Use for refactors that touch many sites.",
  inputSchema: multiEditSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof multiEditSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);

    // Snapshot every distinct target file up-front so we can roll back on any failure.
    const snapshots = new Map<string, string>();
    const resolved = input.edits.map((e) => ({ ...e, safePath: validator.resolveSafePath(e.path) }));
    for (const e of resolved) {
      if (!existsSync(e.safePath) || !statSync(e.safePath).isFile()) {
        throw new Error(`File not found: ${e.path}`);
      }
      if (!snapshots.has(e.safePath)) snapshots.set(e.safePath, readFileSync(e.safePath, "utf-8"));
    }

    // Apply sequentially against in-memory buffers; only flush to disk if all succeed.
    const buffers = new Map(snapshots);
    try {
      for (const e of resolved) {
        const current = buffers.get(e.safePath)!;
        const count = current.split(e.oldString).length - 1;
        if (count === 0) throw new Error(`String not found in ${e.path}:\n${e.oldString}`);
        if (!e.replaceAll && count > 1) {
          throw new Error(`Found ${count} occurrences in ${e.path}. Use replaceAll: true or be more specific.`);
        }
        buffers.set(
          e.safePath,
          e.replaceAll ? current.replaceAll(e.oldString, () => e.newString) : current.replace(e.oldString, () => e.newString),
        );
      }
      // All edits computed successfully → commit every changed file.
      for (const [path, content] of buffers) writeFileSync(path, content, "utf-8");
    } catch (err) {
      // Roll back anything already written to guarantee all-or-nothing.
      for (const [path, original] of snapshots) {
        try {
          writeFileSync(path, original, "utf-8");
        } catch {
          // best-effort restore
        }
      }
      throw new Error(`multiEdit rolled back — no files changed. Cause: ${err instanceof Error ? err.message : String(err)}`);
    }

    const fileCount = snapshots.size;
    return `Applied ${input.edits.length} edit(s) across ${fileCount} file(s) atomically.`;
  },
});

const replaceInProjectSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
  include: z.string().optional().describe("Optional glob to limit which files are searched, e.g. '*.ts'."),
  isRegex: z.boolean().default(false),
});

export const replaceInProjectTool: AgentTool<z.input<typeof replaceInProjectSchema>, string> = createTool({
  toolName: "replaceInProject",
  description:
    "Find and replace a string (or regex) across ALL matching files in the project in one atomic operation (respects .gitignore, excludes node_modules/.git). Use for renames/refactors spanning many files. Rolls back every file on any failure.",
  inputSchema: replaceInProjectSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof replaceInProjectSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);

    // Match phase via ripgrep — respects ignore files, excludes vendored dirs.
    const args = ["--files-with-matches"];
    if (!input.isRegex) args.push("--fixed-strings");
    // --hidden so the WRITE path sees what the READ path advertises (#420): #406
    // taught searchInFiles/findFiles about .github/.claude/.vscode, but this
    // match phase still skipped them, so a repo-wide rename silently missed
    // every workflow and dotfile while reporting full success.
    args.push("--hidden", "--glob", "!**/node_modules/**", "--glob", "!**/.git/**");
    if (input.include) args.push("--glob", input.include);
    args.push("-e", input.find, ".");

    const rg = spawnSync("rg", args, {
      cwd: ctx.projectRoot,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (rg.error) {
      throw new Error("replaceInProject requires ripgrep (rg). Install it (brew install ripgrep).");
    }
    if (rg.status !== 0 && rg.status !== 1) {
      throw new Error(`Match phase failed: ${rg.stderr ?? `rg exit ${rg.status}`}`);
    }

    const matched = (rg.stdout ?? "").split("\n").filter(Boolean);
    if (matched.length === 0) {
      return `No files contain ${input.isRegex ? "pattern" : "string"} "${input.find}".`;
    }

    // Snapshot all targets up-front. Blocked paths are SKIPPED, not fatal (#420):
    // with --hidden the match set can now include .env* files, and
    // resolveSafePath throws on those — which would abort an otherwise valid
    // refactor instead of just leaving the secret file alone.
    const snapshots = new Map<string, string>();
    const skippedSensitive: string[] = [];
    for (const rel of matched) {
      let safe: string;
      try {
        safe = validator.resolveSafePath(rel);
      } catch {
        skippedSensitive.push(rel);
        continue;
      }
      if (existsSync(safe) && statSync(safe).isFile()) snapshots.set(safe, readFileSync(safe, "utf-8"));
    }

    const buffers = new Map(snapshots);
    let totalReplacements = 0;
    const unchanged: string[] = [];
    try {
      // MULTILINE (#394): ripgrep matches line by line, so `^`/`$` anchor to
      // lines. Applying the same pattern to the whole file WITHOUT `m` anchored
      // them to the file instead — rg reported N matching files, the JS regex
      // replaced nothing in some of them, and the tool still claimed success.
      const re = input.isRegex ? new RegExp(input.find, "gm") : null;
      for (const [path, content] of buffers) {
        let count: number;
        let updated: string;
        if (re) {
          count = (content.match(re) ?? []).length;
          updated = content.replace(re, input.replace);
        } else {
          count = content.split(input.find).length - 1;
          updated = content.split(input.find).join(input.replace);
        }
        if (count > 0) {
          buffers.set(path, updated);
          totalReplacements += count;
        } else {
          // rg matched this file but our apply phase did not — report it rather
          // than silently counting it as replaced (#394).
          unchanged.push(relative(ctx.projectRoot, path) || path);
        }
      }
      for (const [path, content] of buffers) writeFileSync(path, content, "utf-8");
    } catch (err) {
      for (const [path, original] of snapshots) {
        try {
          writeFileSync(path, original, "utf-8");
        } catch {
          // best-effort restore
        }
      }
      throw new Error(
        `replaceInProject rolled back — no files changed. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const changedFiles = snapshots.size - unchanged.length;
    let report = `Replaced ${totalReplacements} occurrence(s) across ${changedFiles} file(s).`;
    if (skippedSensitive.length > 0) {
      report += `\n⚠ skipped ${skippedSensitive.length} sensitive file(s) (never edited by this tool): ${skippedSensitive.slice(0, 5).join(", ")}.`;
    }
    if (unchanged.length > 0) {
      // Actionable partial-success signal: name the files so the model can fix
      // its pattern instead of believing the refactor is complete (#394).
      report +=
        `\n⚠ ${unchanged.length} file(s) matched the search but were NOT modified — the apply-phase pattern found nothing in them: ` +
        `${unchanged.slice(0, 10).join(", ")}${unchanged.length > 10 ? `, …(+${unchanged.length - 10})` : ""}.` +
        `\nThis usually means the regex relies on ripgrep-specific behaviour (e.g. multiline spans or PCRE features). Adjust the pattern and retry.`;
    }
    return report;
  },
});

export const allWriteTools = [
  writeFileTool,
  createFileTool,
  editFileTool,
  multiEditTool,
  replaceInProjectTool,
  deleteFileTool,
  moveFileTool,
  createDirectoryTool,
  deleteDirectoryTool,
];
