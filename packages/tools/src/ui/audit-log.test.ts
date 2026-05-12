import { describe, it, expect } from "vitest";
import { AuditLog } from "./audit-log.js";
import type { ToolAuditEntry } from "../types.js";

function makeEntry(toolName: string, success: boolean): ToolAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName,
    input: { x: 1 },
    output: "result",
    success,
  };
}

describe("AuditLog", () => {
  it("records entries via log callback", () => {
    const log = new AuditLog();
    log.log(makeEntry("readFile", true));
    expect(log.count).toBe(1);
  });

  it("filters entries by tool name", () => {
    const log = new AuditLog();
    log.log(makeEntry("readFile", true));
    log.log(makeEntry("writeFile", true));
    log.log(makeEntry("readFile", false));

    const readEntries = log.getEntriesByTool("readFile");
    expect(readEntries).toHaveLength(2);
  });

  it("returns only failed entries", () => {
    const log = new AuditLog();
    log.log(makeEntry("a", true));
    log.log(makeEntry("b", false));
    log.log(makeEntry("c", false));

    expect(log.getFailedEntries()).toHaveLength(2);
    expect(log.failureCount).toBe(2);
  });

  it("returns recent entries", () => {
    const log = new AuditLog();
    for (let i = 0; i < 30; i++) {
      log.log(makeEntry(`tool${i}`, true));
    }

    expect(log.getRecent(5)).toHaveLength(5);
    expect(log.getRecent(5)[4].toolName).toBe("tool29");
  });

  it("enforces max entries limit", () => {
    const log = new AuditLog({ maxEntries: 5 });
    for (let i = 0; i < 10; i++) {
      log.log(makeEntry(`tool${i}`, true));
    }

    expect(log.count).toBe(5);
    expect(log.getEntries()[4].toolName).toBe("tool9");
  });

  it("clears all entries", () => {
    const log = new AuditLog();
    log.log(makeEntry("a", true));
    log.clear();
    expect(log.count).toBe(0);
  });
});
