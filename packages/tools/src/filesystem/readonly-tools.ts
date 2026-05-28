import { z } from "zod";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";

export const readFileSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

type ReadFileInput = z.infer<typeof readFileSchema>;

export const readFileTool: AgentTool<ReadFileInput, string> = createTool({
  toolName: "readFile",
  description: "Read the contents of a file at the given path, optionally with offset and limit.",
  inputSchema: readFileSchema,
  requiresConfirmation: false,
  async execute(input: ReadFileInput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);

    if (!statSync(safePath).isFile()) {
      throw new Error(`Not a file: ${input.path}`);
    }

    const content = readFileSync(safePath, "utf-8");
    const lines = content.split("\n");

    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    const sliced = lines.slice(start, end);

    return sliced.join("\n");
  },
});

export const listDirectorySchema = z.object({
  path: z.string().default("."),
});
type ListDirectoryOutput = z.output<typeof listDirectorySchema>;

export const listDirectoryTool: AgentTool<z.input<typeof listDirectorySchema>, string> = createTool({
  toolName: "listDirectory",
  description: "List the contents of a directory.",
  inputSchema: listDirectorySchema,
  requiresConfirmation: false,
  async execute(input: ListDirectoryOutput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);

    if (!statSync(safePath).isDirectory()) {
      throw new Error(`Not a directory: ${input.path}`);
    }

    const entries = readdirSync(safePath, { withFileTypes: true });
    const lines = entries.map((e) => {
      const suffix = e.isDirectory() ? "/" : "";
      return `${e.name}${suffix}`;
    });

    return lines.join("\n");
  },
});

function globMatch(name: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(name);
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        results.push(...walkDir(join(dir, entry.name)));
      } else {
        results.push(join(dir, entry.name));
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return results;
}

export const findFilesSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
});
type FindFilesOutput = z.output<typeof findFilesSchema>;

export const findFilesTool: AgentTool<z.input<typeof findFilesSchema>, string> = createTool({
  toolName: "findFiles",
  description: "Find files matching a glob pattern within the project.",
  inputSchema: findFilesSchema,
  requiresConfirmation: false,
  async execute(input: FindFilesOutput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const searchDir = validator.resolveSafePath(input.path);

    if (!existsSync(searchDir)) return "";

    const isFile = statSync(searchDir).isFile();
    if (isFile && globMatch(searchDir.split(sep).pop()!, input.pattern)) {
      return relative(context.projectRoot, searchDir);
    }

    if (isFile) return "";

    const allFiles = walkDir(searchDir);
    const matched = allFiles
      .filter((f) => globMatch(f.split(sep).pop()!, input.pattern))
      .map((f) => relative(context.projectRoot, f))
      .slice(0, 200);

    return matched.join("\n");
  },
});

export const searchInFilesSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  include: z.string().optional(),
});
type SearchInFilesOutput = z.output<typeof searchInFilesSchema>;

export const searchInFilesTool: AgentTool<z.input<typeof searchInFilesSchema>, string> = createTool({
  toolName: "searchInFiles",
  description: "Search for a regex pattern in files within the project using ripgrep.",
  inputSchema: searchInFilesSchema,
  requiresConfirmation: false,
  async execute(input: SearchInFilesOutput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);

    const args: string[] = ["--heading", "--line-number", "--color=never", "--max-count=100", "-e", input.pattern];

    if (input.include) {
      args.push("--glob", input.include);
    }

    args.push(safePath);

    const result = spawnSync("rg", args, {
      cwd: context.projectRoot,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status === 1) return "";
    if (result.error) {
      throw new Error(`Search failed: rg not found. Install ripgrep (brew install ripgrep).`);
    }
    if (result.status !== 0) {
      throw new Error(`Search failed: ${result.stderr}`);
    }

    return result.stdout.trim();
  },
});

export const allReadOnlyTools = [
  readFileTool,
  listDirectoryTool,
  findFilesTool,
  searchInFilesTool,
];
