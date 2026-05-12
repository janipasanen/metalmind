import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ToolRegistry } from "../src/tool-registry.js";
import { allGitTools } from "../src/git/git-tools.js";
import { runShellTools } from "../src/shell/shell-tools.js";
import { allReadOnlyTools } from "../src/filesystem/readonly-tools.js";
import { allWriteTools } from "../src/filesystem/write-tools.js";
import { CommitMessageGenerator } from "../src/git/commit-generator.js";
import { AuditLog } from "../src/ui/audit-log.js";
import { RepoMap } from "../src/context/repo-map.js";

describe("Phase 3 integration — Git-native workflow", () => {
  const testDir = join(tmpdir(), `metalmind-phase3-${Date.now()}`);
  let registry: ToolRegistry;
  let auditLog: AuditLog;

  function initRepo() {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    execSync("git init -b main", { cwd: testDir });
    execSync('git config user.email "test@test.com"', { cwd: testDir });
    execSync('git config user.name "Test"', { cwd: testDir });
  }

  beforeEach(() => {
    initRepo();
    registry = new ToolRegistry();
    auditLog = new AuditLog();
    for (const tool of [...allReadOnlyTools, ...allWriteTools, ...allGitTools, ...runShellTools]) {
      registry.register(tool);
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const ctx = () => ({
    projectRoot: testDir,
    auditLog: (e: Parameters<typeof auditLog.log>[0]) => auditLog.log(e),
  });

  it("complete git workflow: create, stage, diff, commit", async () => {
    await registry.execute("createFile", { path: "index.ts", content: 'console.log("hello");' }, ctx());
    const status1 = await registry.execute("gitStatus", {}, ctx());
    expect(status1).toContain("?? index.ts");

    await registry.execute("gitAdd", { paths: ["index.ts"] }, ctx());

    const diff = await registry.execute("gitDiff", {}, ctx());

    const stagedDiff = await registry.execute("gitDiffFile", { path: "index.ts", staged: true }, ctx());
    expect(stagedDiff).toContain('+console.log("hello");');

    const msg = CommitMessageGenerator.generateFromRepo(testDir);
    await registry.execute("gitCommit", { message: msg.fullMessage }, ctx());

    const log = execSync("git log --oneline", { cwd: testDir, encoding: "utf-8" }).trim();
    expect(log).toContain(":");
  });

  it("repo map v1 generates project structure", () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    mkdirSync(join(testDir, "tests"), { recursive: true });
    writeFileSync(join(testDir, "src", "a.ts"), "1");
    writeFileSync(join(testDir, "src", "b.ts"), "2");
    writeFileSync(join(testDir, "tests", "a.test.ts"), "1");

    const map = new RepoMap(testDir);
    const entries = map.generate();
    const paths = entries.map((e) => e.path);

    expect(paths).toContain("src/");
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("tests/");
  });

  it("shell tool runs build command successfully", async () => {
    const result = await registry.execute("runBuild", { command: "echo 'build ok'" }, ctx());
    expect(result).toContain("build ok");
    expect(result).toContain("succeeded");
  });

  it("shell tool blocks dangerous commands", async () => {
    await expect(
      registry.execute("runCommand", { command: "rm -rf /tmp/test" }, ctx()),
    ).rejects.toThrow(/Dangerous/);
  });

  it("audit log tracks git operations", async () => {
    await registry.execute("createFile", { path: "x.ts", content: "1" }, ctx());
    await registry.execute("gitAdd", { paths: ["x.ts"] }, ctx());
    await registry.execute("gitCommit", { message: "chore: add x.ts" }, ctx());

    const entries = auditLog.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(auditLog.getEntriesByTool("gitCommit")).toHaveLength(1);
  });
});
