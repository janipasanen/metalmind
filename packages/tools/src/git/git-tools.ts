import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { createTool } from "../types.js";
import { PathValidator } from "../path-validator.js";

// Run git with an argv array via execFileSync (no shell), so paths, commit
// messages, and branch names can never be interpreted as shell syntax — closes
// the $()/backtick/`;` command-injection vector of the old string interpolation (#255).
// Failures are SURFACED, not swallowed: a nonzero exit always carries an explicit
// "--- git exit: N" trailer so the model/user can tell an error from output (#301).
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
    const msg = execErr.stderr?.trim() || execErr.stdout?.trim() || "";
    const status = execErr.status ?? "unknown";
    if (!msg) return `git ${args[0]} exited with status ${status} (no output)`;
    return `${msg}\n--- git exit: ${status}`;
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

export const gitDiffSchema = z.object({
  /** Show the staged (--cached) diff instead of the working-tree diff. */
  staged: z.boolean().default(false),
});

export const gitDiffTool: AgentTool<z.input<typeof gitDiffSchema>, string> = createTool({
  toolName: "gitDiff",
  description: "Show changes between the working tree and the index (or the staged diff with staged:true).",
  inputSchema: gitDiffSchema,
  requiresConfirmation: false,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    const args = ["diff"];
    if (input.staged) args.push("--cached");
    args.push("--unified=3");
    return gitCmd(args, ctx.projectRoot);
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

export const gitLogSchema = z.object({
  /** Number of commits to show (default 10). */
  count: z.number().int().min(1).max(100).default(10),
  /** Optional revision range, e.g. "main..HEAD". Validated to bare rev syntax. */
  range: z.string().regex(/^[a-zA-Z0-9._/~^-]+(\.\.\.?[a-zA-Z0-9._/~^-]+)?$/).optional(),
});

export const gitLogTool: AgentTool<z.input<typeof gitLogSchema>, string> = createTool({
  toolName: "gitLog",
  description: "Show recent commits (oneline). Optional range like main..HEAD to see branch-only commits.",
  inputSchema: gitLogSchema,
  requiresConfirmation: false,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    const args = ["log", "--oneline", `-${input.count ?? 10}`];
    if (input.range) args.push(input.range);
    return gitCmd(args, ctx.projectRoot);
  },
});

export const gitPushSchema = z.object({
  /** Push the current branch and set upstream (git push -u origin HEAD). */
  setUpstream: z.boolean().default(true),
});

export const gitPushTool: AgentTool<z.input<typeof gitPushSchema>, string> = createTool({
  toolName: "gitPush",
  description: "Push the current branch to origin (sets upstream by default).",
  inputSchema: gitPushSchema,
  requiresConfirmation: true,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    const args = input.setUpstream === false ? ["push"] : ["push", "-u", "origin", "HEAD"];
    return gitCmd(args, ctx.projectRoot);
  },
});

export const createPullRequestSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().default(""),
  /** Base branch (defaults to the repo's default branch when omitted). */
  base: z.string().regex(/^[a-zA-Z0-9._/-]+$/).optional(),
  draft: z.boolean().default(false),
});

export const createPullRequestTool: AgentTool<z.input<typeof createPullRequestSchema>, string> = createTool({
  toolName: "createPullRequest",
  description:
    "Create a GitHub pull request for the current branch via the gh CLI (must be installed and authenticated). " +
    "Push the branch first (gitPush).",
  inputSchema: createPullRequestSchema,
  requiresConfirmation: true,
  async execute(input, ctx: ToolExecutionContext): Promise<string> {
    // argv array via execFileSync — title/body can never be shell-interpreted (#255).
    const args = ["pr", "create", "--title", input.title, "--body", input.body ?? ""];
    if (input.base) args.push("--base", input.base);
    if (input.draft) args.push("--draft");
    try {
      return execFileSync("gh", args, {
        cwd: ctx.projectRoot,
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number; stderr?: string; stdout?: string };
      if (e.code === "ENOENT") {
        throw new Error("gh CLI not found. Install it (brew install gh) and authenticate (gh auth login) to create PRs.");
      }
      const msg = e.stderr?.trim() || e.stdout?.trim() || String(err);
      throw new Error(`gh pr create failed (exit ${e.status ?? "?"}): ${msg}`);
    }
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
  gitLogTool,
  gitPushTool,
  createPullRequestTool,
];
