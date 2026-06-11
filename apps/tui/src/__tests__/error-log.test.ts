import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { logError, recentErrors, diagnosticsReport, errorLogPath } from "../error-log.js";

describe("error log (#217)", () => {
  // Snapshot/restore the real log so these tests are non-destructive.
  let backup: string | null = null;
  const path = errorLogPath();
  beforeEach(() => {
    backup = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (existsSync(path)) rmSync(path);
  });
  afterEach(() => {
    if (backup !== null) writeFileSync(path, backup);
    else if (existsSync(path)) rmSync(path);
  });

  it("appends an entry and reads it back", () => {
    logError("provider", new Error("rate limited (429)"));
    const recent = recentErrors();
    expect(recent.length).toBe(1);
    expect(recent[0]).toContain("[provider]");
    expect(recent[0]).toContain("rate limited (429)");
  });

  it("handles non-Error values", () => {
    logError("unhandledRejection", "plain string failure");
    expect(recentErrors()[0]).toContain("plain string failure");
  });

  it("keeps newest entries and bounds the file (rotation)", () => {
    for (let i = 0; i < 1200; i++) logError("loop", new Error(`err-${i}`));
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1000); // capped
    expect(lines.at(-1)).toContain("err-1199"); // newest retained
    expect(lines[0]).not.toContain("err-0"); // oldest dropped
  });

  it("diagnosticsReport says so when empty, and lists entries otherwise", () => {
    expect(diagnosticsReport()).toContain("No errors logged");
    logError("test", new Error("boom"));
    expect(diagnosticsReport()).toContain("boom");
  });
});
