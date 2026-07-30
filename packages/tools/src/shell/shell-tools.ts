import { z } from "zod";
import { spawn } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { createTool } from "../types.js";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

const OUTPUT_CAP = 10 * 1024 * 1024;

/** Async shell runner (#284): spawn instead of execSync so the event loop (and
 *  the whole Ink TUI) keeps rendering during long commands, with a hard timeout
 *  and Esc-to-cancel via the turn's AbortSignal.
 *
 *  Settling is anchored on 'exit', NOT 'close': 'close' waits for the stdio
 *  pipes to drain, and a grandchild that inherits them (e.g. `npm run dev &`,
 *  or a test runner's orphaned worker) keeps them open forever — hanging the
 *  whole turn. After exit we give stdio a short grace to flush, then settle.
 *  Kill/abort also force-settle on their own, and the process GROUP is killed
 *  (detached + kill(-pid)) so grandchildren don't survive the timeout. */
export function runShellAsync(command: string, cwd: string, timeoutMs: number | undefined, signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<RunResult> {
  // Direct execute() calls (tests, registry bypass) may skip zod defaults.
  const effectiveTimeout = timeoutMs && timeoutMs >= 1000 ? timeoutMs : 120_000;
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const child = spawn(command, { shell: true, cwd, detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      const t = d.toString();
      if (stdout.length < OUTPUT_CAP) stdout += t;
      onOutput?.(t);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const t = d.toString();
      if (stderr.length < OUTPUT_CAP) stderr += t;
      onOutput?.(t);
    });

    let settled = false;
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, exitCode, duration: Date.now() - start });
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // whole group, incl. grandchildren
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    // When WE killed the process (timeout/abort), the child's own exit event
    // races the force-settle and would report a meaningless code — the forced
    // code (124 timeout / 130 cancelled) must win whichever event settles (#350).
    let forcedCode: number | null = null;
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${effectiveTimeout}ms — killed)`;
      forcedCode = 124;
      killGroup();
      // Force-settle: don't depend on any event arriving after a SIGKILL.
      setTimeout(() => settle(124), 250);
    }, effectiveTimeout);
    const onAbort = () => {
      stderr += "\n(cancelled)";
      forcedCode = 130;
      killGroup();
      setTimeout(() => settle(130), 250);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      stderr += String(err);
      settle(127);
    });
    // 'exit' fires when the process dies even if grandchildren hold the pipes;
    // give stdio 200ms to flush whatever is buffered, then settle.
    child.on("exit", (code) => {
      setTimeout(() => settle(forcedCode ?? code ?? 1), 200);
    });
    // Fast path: pipes closed too — settle immediately without the grace wait.
    child.on("close", (code) => settle(forcedCode ?? code ?? 1));
  });
}

/** POSIX single-quote a value so the shell treats it as one literal argument (#358). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function render(r: RunResult, trailer: string): string {
  const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
  return `${body}\n--- ${trailer}, ${r.duration}ms`;
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

    const r = await runShellAsync(input.command, input.cwd ?? ctx.projectRoot, input.timeout, ctx.signal, ctx.onOutput);
    return render(r, `Exit: ${r.exitCode}`);
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
    const r = await runShellAsync(input.command ?? "npm test", ctx.projectRoot, input.timeout, ctx.signal, ctx.onOutput);
    return render(r, r.exitCode === 0 ? "Tests passed" : "Tests FAILED");
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
    const r = await runShellAsync(input.command ?? "npm run build", ctx.projectRoot, input.timeout, ctx.signal, ctx.onOutput);
    return render(r, r.exitCode === 0 ? "Build succeeded" : "Build FAILED");
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
    const r = await runShellAsync(input.command ?? "npm run lint", ctx.projectRoot, input.timeout, ctx.signal, ctx.onOutput);
    return render(r, r.exitCode === 0 ? "Lint passed" : "Lint failed");
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
    const base = input.command ?? "npx prettier --write";
    // Single-quote, don't JSON.stringify (#358): the command runs under `sh -c`,
    // and DOUBLE quotes still expand $(…), backticks and $VAR — so a path like
    // `$(rm -rf ~)` executed. Single quotes suppress all of it; the embedded-
    // quote dance ('\'') is the only escape sh recognizes inside them.
    const cmd = input.path ? `${base} ${shellQuote(input.path)}` : base;
    const r = await runShellAsync(cmd, ctx.projectRoot, input.timeout, ctx.signal, ctx.onOutput);
    return render(r, r.exitCode === 0 ? "Format complete" : "Format failed");
  },
});

export const runShellTools = [runCommandTool, runTestsTool, runBuildTool, runLintTool, runFormatTool];
