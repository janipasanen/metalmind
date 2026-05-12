/**
 * Tool audit log for recording all tool executions.
 * Stores entries in memory with optional persistence hook.
 */
import type { ToolAuditEntry } from "../types.js";

export interface AuditLogOptions {
  maxEntries?: number;
  persistFn?: (entries: ToolAuditEntry[]) => Promise<void>;
}

export class AuditLog {
  private entries: ToolAuditEntry[] = [];
  private maxEntries: number;
  private persistFn?: (entries: ToolAuditEntry[]) => Promise<void>;

  constructor(options: AuditLogOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.persistFn = options.persistFn;
  }

  log: (entry: ToolAuditEntry) => void = (entry: ToolAuditEntry) => {
    this.entries.push(entry);

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  };

  getEntries(): ReadonlyArray<ToolAuditEntry> {
    return this.entries;
  }

  getEntriesByTool(toolName: string): ToolAuditEntry[] {
    return this.entries.filter((e) => e.toolName === toolName);
  }

  getFailedEntries(): ToolAuditEntry[] {
    return this.entries.filter((e) => !e.success);
  }

  getRecent(n: number = 20): ToolAuditEntry[] {
    return this.entries.slice(-n);
  }

  clear(): void {
    this.entries = [];
  }

  get count(): number {
    return this.entries.length;
  }

  get failureCount(): number {
    return this.entries.filter((e) => !e.success).length;
  }
}
