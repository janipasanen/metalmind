import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { createTool } from "../types.js";

interface BackgroundProcess {
  id: string;
  command: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
}

const LOG_CAP = 64 * 1024; // keep the most recent 64KB of each stream
const registry = new Map<string, BackgroundProcess>();
let counter = 0;

function appendCapped(existing: string, chunk: string): string {
  const next = existing + chunk;
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
}

/** Spawn a detached-from-the-loop background process and return its handle id. */
export function startBackgroundProcess(command: string, cwd: string): string {
  const id = `bg-${++counter}`;
  const child = spawn(command, { shell: true, cwd });
  const proc: BackgroundProcess = {
    id,
    command,
    child,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
  };
  child.stdout?.on("data", (d: Buffer) => {
    proc.stdout = appendCapped(proc.stdout, d.toString());
  });
  child.stderr?.on("data", (d: Buffer) => {
    proc.stderr = appendCapped(proc.stderr, d.toString());
  });
  child.on("exit", (code, sig) => {
    proc.exitCode = code;
    proc.signal = sig;
  });
  child.on("error", (err) => {
    proc.stderr = appendCapped(proc.stderr, `\n[spawn error] ${err.message}`);
    proc.exitCode = proc.exitCode ?? -1;
  });
  registry.set(id, proc);
  return id;
}

function statusOf(proc: BackgroundProcess): string {
  if (proc.exitCode === null && proc.signal === null) return "running";
  if (proc.signal) return `stopped (signal ${proc.signal})`;
  return `exited (code ${proc.exitCode})`;
}

/** Return accumulated stdout/stderr + status for a background process. */
export function pollBackgroundProcess(id: string): string {
  const proc = registry.get(id);
  if (!proc) return `No background process with id "${id}".`;
  const uptime = Math.round((Date.now() - proc.startedAt) / 1000);
  return [
    `[${id}] ${statusOf(proc)} — ${proc.command} (${uptime}s)`,
    proc.stdout ? `--- stdout ---\n${proc.stdout.trim()}` : "--- stdout --- (empty)",
    proc.stderr ? `--- stderr ---\n${proc.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Kill a background process by id. */
export function stopBackgroundProcess(id: string): string {
  const proc = registry.get(id);
  if (!proc) return `No background process with id "${id}".`;
  if (proc.exitCode !== null || proc.signal !== null) {
    return `[${id}] already ${statusOf(proc)}.`;
  }
  proc.child.kill("SIGTERM");
  return `[${id}] sent SIGTERM to "${proc.command}".`;
}

/** List all tracked background processes. */
export function listBackgroundProcesses(): string {
  if (registry.size === 0) return "No background processes.";
  return [...registry.values()].map((p) => `[${p.id}] ${statusOf(p)} — ${p.command}`).join("\n");
}

/** Kill every tracked process — call on session exit. */
export function killAllBackgroundProcesses(): void {
  for (const proc of registry.values()) {
    if (proc.exitCode === null && proc.signal === null) {
      try {
        proc.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

/** Test-only: reset the registry. */
export function _resetBackgroundRegistry(): void {
  killAllBackgroundProcesses();
  registry.clear();
  counter = 0;
}

const runBackgroundSchema = z.object({
  command: z.string().min(1),
});

export const runBackgroundTool: AgentTool<z.input<typeof runBackgroundSchema>, string> = createTool({
  toolName: "runBackground",
  description:
    "Start a long-running shell command (dev server, watcher, long build) in the background and return immediately with a process id. Use pollBackground to read its output and stopBackground to kill it.",
  inputSchema: runBackgroundSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof runBackgroundSchema>, ctx: ToolExecutionContext): Promise<string> {
    const id = startBackgroundProcess(input.command, ctx.projectRoot);
    return `Started background process [${id}]: ${input.command}\nUse pollBackground({ id: "${id}" }) to read output, stopBackground({ id: "${id}" }) to stop.`;
  },
});

const pollBackgroundSchema = z.object({
  id: z.string().min(1).optional().describe("Process id; omit to list all background processes."),
});

export const pollBackgroundTool: AgentTool<z.input<typeof pollBackgroundSchema>, string> = createTool({
  toolName: "pollBackground",
  description: "Read accumulated stdout/stderr and status for a background process by id, or list all if id is omitted.",
  inputSchema: pollBackgroundSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof pollBackgroundSchema>): Promise<string> {
    return input.id ? pollBackgroundProcess(input.id) : listBackgroundProcesses();
  },
});

const stopBackgroundSchema = z.object({
  id: z.string().min(1),
});

export const stopBackgroundTool: AgentTool<z.input<typeof stopBackgroundSchema>, string> = createTool({
  toolName: "stopBackground",
  description: "Stop (SIGTERM) a background process by id.",
  inputSchema: stopBackgroundSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof stopBackgroundSchema>): Promise<string> {
    return stopBackgroundProcess(input.id);
  },
});

export const backgroundShellTools = [runBackgroundTool, pollBackgroundTool, stopBackgroundTool];
