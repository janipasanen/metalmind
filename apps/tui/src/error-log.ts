import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { XDG_CONFIG_DIR } from "@metalmind/config";

/**
 * Lightweight crash/error log (#217) so failures survive the session. Errors are
 * appended to a single rotating file (capped line count) and surfaced via
 * /diagnostics. Best-effort: logging never throws.
 */

const MAX_LINES = 1000;

export function errorLogPath(): string {
  return join(XDG_CONFIG_DIR, "logs", "errors.log");
}

function isoNow(): string {
  // new Date() is fine in the app runtime (not a workflow script).
  return new Date().toISOString();
}

/** Append a single error entry, rotating the file to keep the last MAX_LINES lines. */
export function logError(context: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack.split("\n")[1]?.trim() : "";
    const line = `[${isoNow()}] [${context}] ${message}${stack ? `  (${stack})` : ""}`;
    const path = errorLogPath();
    mkdirSync(join(XDG_CONFIG_DIR, "logs"), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
    existing.push(line);
    const kept = existing.slice(-MAX_LINES);
    writeFileSync(path, kept.join("\n") + "\n", "utf-8");
  } catch {
    // never let logging break the app
  }
}

/** Return the most recent error entries (newest last). */
export function recentErrors(n = 20): string[] {
  try {
    const path = errorLogPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/** Format recent errors for /diagnostics. */
export function diagnosticsReport(n = 20): string {
  const errors = recentErrors(n);
  if (errors.length === 0) return `No errors logged this session or earlier. (Log: ${errorLogPath()})`;
  return [`Recent errors (newest last) — ${errorLogPath()}:`, ...errors.map((e) => `  ${e}`)].join("\n");
}
