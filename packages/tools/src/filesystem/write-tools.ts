import { z } from "zod";
import {
  writeFileSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
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

export const editFileTool: AgentTool<z.input<typeof editFileSchema>, string> = createTool({
  toolName: "editFile",
  description: "Edit a file by finding and replacing a specific string.",
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
      if (count === 0) throw new Error(`String not found in ${input.path}:\n${input.oldString}`);
      writeFileSync(
        safePath,
        original.replaceAll(input.oldString, input.newString),
        "utf-8",
      );
      return `Replaced ${count} occurrence(s) in ${input.path}`;
    }

    if (!original.includes(input.oldString)) {
      throw new Error(`String not found in ${input.path}:\n${input.oldString}`);
    }

    const occ = original.split(input.oldString).length - 1;
    if (occ > 1) {
      throw new Error(
        `Found ${occ} occurrences. Use replaceAll: true or be more specific.`,
      );
    }

    writeFileSync(
      safePath,
      original.replace(input.oldString, input.newString),
      "utf-8",
    );
    return `Edited ${input.path}`;
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
          e.replaceAll ? current.replaceAll(e.oldString, e.newString) : current.replace(e.oldString, e.newString),
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

export const allWriteTools = [
  writeFileTool,
  createFileTool,
  editFileTool,
  multiEditTool,
  deleteFileTool,
  moveFileTool,
  createDirectoryTool,
];
