import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { createTool } from "../types.js";
import { PathValidator } from "../path-validator.js";

// Run git with an argv array via execFileSync (no shell), so paths, commit
// messages, and branch names can never be interpreted as shell syntax — closes
// the $()/backtick/`;` command-injection vector of the old string interpolation (#255).
function gitCmd(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (err: unknown) {
    const execErr = err as { status?: number; stderr?: string; stdout?: string };
    const msg = execErr.stderr?.trim() || execErr.stdout?.trim() || String(err);
    if (execErr.status === 128 && !msg) return "";
    return msg;
  }
}

export const gitStatusSchema = z.object({});

export const gitStatusTool: AgentTool<z.input<typeof gitStatusSchema>, string> = createTool({
  toolName: "gitStatus",
  description: "Show the working tree status.",
  inputSchema: gitStatusSchema,
  requiresConfirmation: false,
  async execute(_input, ctx: ToolExecutionContext): Promise<string> {
    return gitCmd(["status", "--porcelain", "--branch"], ctx.projectRoot);
  },
});

export const gitDiffSchema = z.object({});

export const gitDiffTool: AgentTool<z.input<typeof gitDiffSchema>, string> = createTool({
  toolName: "gitDiff",
  description: "Show changes between the working tree and the index or a tree.",
  inputSchema: gitDiffSchema,
  requiresConfirmation: false,
  async execute(_input, ctx: ToolExecutionContext): Promise<string> {
    return gitCmd(["diff", "--unified=3"], ctx.projectRoot);
  },
});

export const gitDiffFileSchema = z.object({
  path: z.string().min(1),
  staged: z.boolean().default(false),
});

export const gitDiffFileTool: AgentTool<z.input<typeof gitDiffFileSchema>, string> = createTool({
  toolName: "gitDiffFile",
  description: "Show changes for a specific file.",
  inputSchema: gitDiffFileSchema,
  requiresConfirmation: false,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    const v = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    v.resolveSafePath(input.path);
    const args = ["diff"];
    if (input.staged) args.push("--cached");
    args.push("--unified=3", "--", input.path);
    return gitCmd(args, ctx.projectRoot);
  },
});

export const gitAddSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export const gitAddTool: AgentTool<z.input<typeof gitAddSchema>, string> = createTool({
  toolName: "gitAdd",
  description: "Add file contents to the index.",
  inputSchema: gitAddSchema,
  requiresConfirmation: true,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    const v = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    for (const p of input.paths) v.resolveSafePath(p);
    return gitCmd(["add", "--", ...input.paths], ctx.projectRoot);
  },
});

export const gitCommitSchema = z.object({
  message: z.string().min(1),
});

export const gitCommitTool: AgentTool<z.input<typeof gitCommitSchema>, string> = createTool({
  toolName: "gitCommit",
  description: "Record staged changes to the repository.",
  inputSchema: gitCommitSchema,
  requiresConfirmation: true,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    return gitCmd(["commit", "-m", input.message], ctx.projectRoot);
  },
});

export const gitRestoreSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export const gitRestoreTool: AgentTool<z.input<typeof gitRestoreSchema>, string> = createTool({
  toolName: "gitRestore",
  description: "Restore working tree files (undo uncommitted changes).",
  inputSchema: gitRestoreSchema,
  requiresConfirmation: true,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    const v = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    for (const p of input.paths) v.resolveSafePath(p);
    return gitCmd(["restore", "--", ...input.paths], ctx.projectRoot);
  },
});

export const gitCreateBranchSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9._/-]+$/, "Invalid branch name"),
});

export const gitCreateBranchTool: AgentTool<z.input<typeof gitCreateBranchSchema>, string> = createTool({
  toolName: "gitCreateBranch",
  description: "Create a new branch.",
  inputSchema: gitCreateBranchSchema,
  requiresConfirmation: true,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    return gitCmd(["checkout", "-b", input.name], ctx.projectRoot);
  },
});

export const gitCurrentBranchSchema = z.object({});

export const gitCurrentBranchTool: AgentTool<z.input<typeof gitCurrentBranchSchema>, string> = createTool({
  toolName: "gitCurrentBranch",
  description: "Show the current branch name.",
  inputSchema: gitCurrentBranchSchema,
  requiresConfirmation: false,
  async execute(_input, ctx: ToolExecutionContext): Promise<string> {
    return gitCmd(["branch", "--show-current"], ctx.projectRoot);
  },
});

export const allGitTools = [
  gitStatusTool,
  gitDiffTool,
  gitDiffFileTool,
  gitAddTool,
  gitCommitTool,
  gitRestoreTool,
  gitCreateBranchTool,
  gitCurrentBranchTool,
];
