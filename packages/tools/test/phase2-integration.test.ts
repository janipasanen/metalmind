import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PathValidator } from "../src/path-validator.js";
import { ToolRegistry, parseInput } from "../src/tool-registry.js";
import { allReadOnlyTools } from "../src/filesystem/readonly-tools.js";
import { allWriteTools } from "../src/filesystem/write-tools.js";
import { DiffGenerator } from "../src/ui/diff-generator.js";
import { AuditLog } from "../src/ui/audit-log.js";
import type { ToolAuditEntry } from "../src/types.js";

describe("Phase 2 integration — filesystem tool pipeline", () => {
  const testDir = join(tmpdir(), `metalmind-phase2-${Date.now()}`);
  let registry: ToolRegistry;
  let auditLog: AuditLog;
  let auditEntries: ToolAuditEntry[];

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    registry = new ToolRegistry();
    auditEntries = [];
    auditLog = new AuditLog();

    for (const tool of [...allReadOnlyTools, ...allWriteTools]) {
      registry.register(tool);
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const ctx = () => ({
    projectRoot: testDir,
    auditLog: (entry: ToolAuditEntry) => auditLog.log(entry),
  });

  it("full pipeline: create → read → list → edit → diff → delete", async () => {
    await registry.execute("createFile", { path: "app.ts", content: "const x = 1;\nconst y = 2;" }, ctx());
    expect(existsSync(join(testDir, "app.ts"))).toBe(true);

    const result1 = await registry.execute("readFile", { path: "app.ts" }, ctx());
    expect(result1).toContain("const x = 1;");

    const list = await registry.execute("listDirectory", { path: "." }, ctx());
    expect(list).toContain("app.ts");

    const diff = DiffGenerator.previewEdit("app.ts", testDir, "const x = 1;", "const x = 42;");
    expect(diff.patch).toContain("-const x = 1;");
    expect(diff.patch).toContain("+const x = 42;");

    await registry.execute("editFile", { path: "app.ts", oldString: "const x = 1;", newString: "const x = 42;" }, ctx());

    const result2 = await registry.execute("readFile", { path: "app.ts" }, ctx());
    expect(result2).toContain("const x = 42;");
    expect(result2).not.toContain("const x = 1;");

    await registry.execute("deleteFile", { path: "app.ts" }, ctx());
    expect(existsSync(join(testDir, "app.ts"))).toBe(false);
  });

  it("audit log records all operations", async () => {
    await registry.execute("createFile", { path: "temp.txt" }, ctx());
    await registry.execute("readFile", { path: "temp.txt" }, ctx());
    await registry.execute("deleteFile", { path: "temp.txt" }, ctx());

    const entries = auditLog.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(3);

    expect(auditLog.getEntriesByTool("createFile")).toHaveLength(1);
    expect(auditLog.getEntriesByTool("readFile")).toHaveLength(1);
    expect(auditLog.failureCount).toBe(0);
  });

  it("allows operations outside the project root (cross-project access)", async () => {
    // The PathValidator intentionally permits traversal/absolute paths so the
    // agent can work on any directory the user points it at. Only sensitive
    // patterns (.ssh/.aws/.env/keys) are blocked — see the test below.
    const outsideName = `metalmind-phase2-outside-${Date.now()}.txt`;
    const outsidePath = join(tmpdir(), outsideName);
    rmSync(outsidePath, { force: true });

    try {
      await registry.execute("writeFile", { path: `../${outsideName}`, content: "outside" }, ctx());
      expect(readFileSync(outsidePath, "utf-8")).toBe("outside");

      const read = await registry.execute("readFile", { path: `../${outsideName}` }, ctx());
      expect(read).toContain("outside");
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it("blocks access to secret directories", async () => {
    mkdirSync(join(testDir, ".ssh"), { recursive: true });
    writeFileSync(join(testDir, ".ssh", "config"), "secret");

    await expect(
      registry.execute("readFile", { path: ".ssh/config" }, ctx()),
    ).rejects.toThrow(/blocked path/);
  });

  it("editFile rejects when string not found", async () => {
    writeFileSync(join(testDir, "only.ts"), "hello");
    await expect(
      registry.execute("editFile", { path: "only.ts", oldString: "nonexistent", newString: "x" }, ctx()),
    ).rejects.toThrow(/String not found/);
  });

  it("audit log records failures", async () => {
    await expect(
      registry.execute("readFile", { path: "../../../etc/passwd" }, ctx()),
    ).rejects.toThrow();

    expect(auditLog.failureCount).toBeGreaterThanOrEqual(1);
    const failed = auditLog.getFailedEntries();
    expect(failed[0].success).toBe(false);
  });

  it("parseInput handles JSON and plain strings", () => {
    expect(parseInput('{"key":"value"}')).toEqual({ key: "value" });
    expect(parseInput("plain text")).toBe("plain text");
    expect(parseInput("123")).toBe(123);
  });
});
