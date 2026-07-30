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
  // detached: the shell becomes a process-GROUP leader, so stop/killAll can
  // signal the whole group. Without it only the wrapper `sh -c` was signalled
  // and the actual server (its grandchild) survived while status said
  // "stopped" — a dev server kept holding its port for the rest of the day (#408).
  const child = spawn(command, { shell: true, cwd, detached: true });
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

/** Signal a process and everything it spawned (#408). Falls back to signalling
 *  just the child when the group is unavailable (already reaped, no pid). */
function signalGroup(proc: BackgroundProcess, signal: NodeJS.Signals): void {
  try {
    if (proc.child.pid) process.kill(-proc.child.pid, signal);
    else proc.child.kill(signal);
  } catch {
    try {
      proc.child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Kill a background process by id. */
export function stopBackgroundProcess(id: string): string {
  const proc = registry.get(id);
  if (!proc) return `No background process with id "${id}".`;
  if (proc.exitCode !== null || proc.signal !== null) {
    return `[${id}] already ${statusOf(proc)}.`;
  }
  signalGroup(proc, "SIGTERM");
  // Escalate: a server that ignores SIGTERM (or a shell that exits while its
  // child lingers) must not survive a stop that reported success (#408).
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signal === null) signalGroup(proc, "SIGKILL");
  }, 3000);
  timer.unref?.();
  return `[${id}] sent SIGTERM to "${proc.command}" (and its child processes; SIGKILL in 3s if it ignores it).`;
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
      // Whole group (#408) — on exit there is no time to wait for a graceful
      // shutdown, so SIGKILL immediately after SIGTERM.
      signalGroup(proc, "SIGTERM");
      signalGroup(proc, "SIGKILL");
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
