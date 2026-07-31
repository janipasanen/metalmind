import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runShellAsync } from "@metalmind/tools";
import { XDG_CONFIG_DIR } from "@metalmind/config";

/**
 * User-configurable lifecycle hooks (#346): shell commands run at fixed points
 * of the agent loop — before/after each tool call, at session start, and when
 * a turn finishes. Defined in JSON at ~/.config/metalmind/hooks.json (global)
 * and <project>/.metalmind/hooks.json (project; appended after global):
 *
 *   {
 *     "preTool":  [{ "matcher": "runCommand|editFile", "command": "./guard.sh" }],
 *     "postTool": [{ "command": "echo done >> /tmp/log" }],
 *     "sessionStart": [{ "command": "..." }],
 *     "stop": [{ "command": "afplay /System/Library/Sounds/Glass.aiff" }]
 *   }
 *
 * Hooks receive context via env vars (MM_EVENT, MM_PROJECT_ROOT, MM_TOOL_NAME,
 * MM_TOOL_INPUT, MM_TOOL_OUTPUT). A preTool hook exiting with code 2 BLOCKS the
 * tool call; its output becomes the refusal reason shown to the model.
 */

export type HookEvent = "preTool" | "postTool" | "sessionStart" | "stop";

export interface HookDef {
  /** Regex matched against the tool name (preTool/postTool only). Absent = every tool. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HookOutcome {
  /** Set when a preTool hook blocked the call (exit code 2). */
  blocked?: string;
  /** Non-blocking hook output, for surfacing/logging. */
  notes: string[];
}

const EVENTS: HookEvent[] = ["preTool", "postTool", "sessionStart", "stop"];
const MAX_HOOKS_PER_EVENT = 10;

export function hookFiles(projectRoot: string, includeProject = true): string[] {
  const files = [join(XDG_CONFIG_DIR, "hooks.json")];
  // The PROJECT file is execute-on-open, so the caller gates it on workspace
  // trust (#442). The global file is the user's own and always applies.
  if (includeProject) files.push(join(projectRoot, ".metalmind", "hooks.json"));
  return files;
}

export function loadHooks(
  projectRoot: string,
  opts: { includeProject?: boolean } = {},
): Partial<Record<HookEvent, HookDef[]>> {
  const merged: Partial<Record<HookEvent, HookDef[]>> = {};
  for (const file of hookFiles(projectRoot, opts.includeProject ?? true)) {
    try {
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      for (const ev of EVENTS) {
        for (const d of Array.isArray(raw[ev]) ? (raw[ev] as unknown[]) : []) {
          const def = d as { command?: unknown; matcher?: unknown; timeoutMs?: unknown };
          if (typeof def?.command !== "string" || !def.command.trim()) continue;
          const list = (merged[ev] ??= []);
          if (list.length >= MAX_HOOKS_PER_EVENT) continue;
          list.push({
            command: def.command,
            matcher: typeof def.matcher === "string" ? def.matcher : undefined,
            timeoutMs: typeof def.timeoutMs === "number" ? def.timeoutMs : undefined,
          });
        }
      }
    } catch {
      // malformed hooks file — skip it rather than crash the session
    }
  }
  return merged;
}

/** Shell-safe single-quoted value for the env-var prefix. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function runHooks(
  hooks: Partial<Record<HookEvent, HookDef[]>>,
  event: HookEvent,
  projectRoot: string,
  env: Record<string, string> = {},
): Promise<HookOutcome> {
  const outcome: HookOutcome = { notes: [] };
  for (const hook of hooks[event] ?? []) {
    if (hook.matcher && env.MM_TOOL_NAME !== undefined) {
      try {
        if (!new RegExp(hook.matcher).test(env.MM_TOOL_NAME)) continue;
      } catch {
        continue; // invalid matcher regex — skip this hook
      }
    }
    // Values are passed as an env prefix (single-quoted, truncated) because the
    // shared shell runner doesn't take an env map. The command runs inside
    // `sh -c` so inline $MM_* references expand in a shell that HAS the vars —
    // a bare `MM_X=1 echo $MM_X` would expand in the parent shell and print
    // nothing.
    const prefix = Object.entries({ MM_EVENT: event, MM_PROJECT_ROOT: projectRoot, ...env })
      .map(([k, v]) => `${k}=${shq(v.slice(0, 4000))}`)
      .join(" ");
    const r = await runShellAsync(`${prefix} sh -c ${shq(hook.command)}`, projectRoot, hook.timeoutMs ?? 10_000);
    const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n").slice(0, 2000);
    if (event === "preTool" && r.exitCode === 2) {
      outcome.blocked = text || `blocked by preTool hook: ${hook.command}`;
      return outcome;
    }
    if (text) outcome.notes.push(text);
  }
  return outcome;
}
