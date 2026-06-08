import { z } from "zod";
import { execSync, spawnSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { createTool } from "../types.js";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export const runCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout: z.number().int().min(1000).max(300_000).default(120_000),
});

export const runCommandTool: AgentTool<z.input<typeof runCommandSchema>, string> = createTool({
  toolName: "runCommand",
  description: "Run a shell command. Supports any CLI tool: gh, git, npm, brew, etc. Use `cwd` to run in a specific directory (defaults to project root). Returns stdout, stderr, and exit code.",
  inputSchema: runCommandSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof runCommandSchema>, ctx: ToolExecutionContext): Promise<string> {
    const blocked = ["rm -rf", "sudo", "curl | sh", "wget | sh", "chmod -R", "chown -R",
      "git reset --hard", "git clean -fd", "docker system prune", "killall", ":(){", "shutdown"];

    for (const b of blocked) {
      if (input.command.includes(b)) {
        throw new Error(`Dangerous command blocked: "${b}"`);
      }
    }

    const workDir = input.cwd ?? ctx.projectRoot;
    const start = Date.now();
    try {
      const result = execSync(input.command, {
        cwd: workDir,
        encoding: "utf-8",
        timeout: input.timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const duration = Date.now() - start;
      return `${result.trim()}\n--- Exit: 0, ${duration}ms`;
    } catch (err: unknown) {
      const duration = Date.now() - start;
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      return `${execErr.stdout?.trim() ?? ""}\n${execErr.stderr?.trim() ?? ""}\n--- Exit: ${execErr.status ?? 1}, ${duration}ms`;
    }
  },
});

export const runTestsSchema = z.object({
  command: z.string().default("npm test"),
  timeout: z.number().int().min(1000).default(300_000),
});

export const runTestsTool: AgentTool<z.input<typeof runTestsSchema>, string> = createTool({
  toolName: "runTests",
  description: "Run the project test suite.",
  inputSchema: runTestsSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof runTestsSchema>, ctx: ToolExecutionContext): Promise<string> {
    const start = Date.now();
    try {
      const result = execSync(input.command, {
        cwd: ctx.projectRoot,
        encoding: "utf-8",
        timeout: input.timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const duration = Date.now() - start;
      return `${result.trim()}\n--- Tests passed, ${duration}ms`;
    } catch (err: unknown) {
      const duration = Date.now() - start;
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      return `${execErr.stdout?.trim() ?? ""}\n${execErr.stderr?.trim() ?? ""}\n--- Tests FAILED, ${duration}ms`;
    }
  },
});

export const runBuildSchema = z.object({
  command: z.string().default("npm run build"),
  timeout: z.number().int().min(1000).default(300_000),
});

export const runBuildTool: AgentTool<z.input<typeof runBuildSchema>, string> = createTool({
  toolName: "runBuild",
  description: "Run the project build.",
  inputSchema: runBuildSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof runBuildSchema>, ctx: ToolExecutionContext): Promise<string> {
    const start = Date.now();
    try {
      const result = execSync(input.command, {
        cwd: ctx.projectRoot,
        encoding: "utf-8",
        timeout: input.timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const duration = Date.now() - start;
      return `${result.trim()}\n--- Build succeeded, ${duration}ms`;
    } catch (err: unknown) {
      const duration = Date.now() - start;
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      return `${execErr.stdout?.trim() ?? ""}\n${execErr.stderr?.trim() ?? ""}\n--- Build FAILED, ${duration}ms`;
    }
  },
});

export const runLintSchema = z.object({
  command: z.string().default("npm run lint"),
  timeout: z.number().int().min(1000).default(300_000),
});

export const runLintTool: AgentTool<z.input<typeof runLintSchema>, string> = createTool({
  toolName: "runLint",
  description: "Run the project linter.",
  inputSchema: runLintSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof runLintSchema>, ctx: ToolExecutionContext): Promise<string> {
    const start = Date.now();
    try {
      const result = execSync(input.command, {
        cwd: ctx.projectRoot,
        encoding: "utf-8",
        timeout: input.timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const duration = Date.now() - start;
      return `${result.trim()}\n--- Lint passed, ${duration}ms`;
    } catch (err: unknown) {
      const duration = Date.now() - start;
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      return `${execErr.stdout?.trim() ?? ""}\n${execErr.stderr?.trim() ?? ""}\n--- Lint failed, ${duration}ms`;
    }
  },
});

export const runFormatSchema = z.object({
  command: z.string().default("npx prettier --write"),
  path: z.string().optional().describe("File or glob to format; appended to the command."),
  timeout: z.number().int().min(1000).default(120_000),
});

export const runFormatTool: AgentTool<z.input<typeof runFormatSchema>, string> = createTool({
  toolName: "runFormat",
  description:
    "Run a code formatter (default: prettier --write). Pass `path` to format a specific file or glob; otherwise formats per the command's own defaults.",
  inputSchema: runFormatSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof runFormatSchema>, ctx: ToolExecutionContext): Promise<string> {
    const cmd = input.path ? `${input.command} ${JSON.stringify(input.path)}` : input.command;
    const start = Date.now();
    try {
      const result = execSync(cmd, {
        cwd: ctx.projectRoot,
        encoding: "utf-8",
        timeout: input.timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return `${result.trim()}\n--- Format complete, ${Date.now() - start}ms`;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string };
      return `${execErr.stdout?.trim() ?? ""}\n${execErr.stderr?.trim() ?? ""}\n--- Format failed, ${Date.now() - start}ms`;
    }
  },
});

export const runShellTools = [runCommandTool, runTestsTool, runBuildTool, runLintTool, runFormatTool];
