import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  gitStatusTool,
  gitDiffTool,
  gitAddTool,
  gitCommitTool,
  gitCurrentBranchTool,
  gitCreateBranchTool,
  gitRestoreTool,
  gitDiffFileTool,
} from "./git-tools.js";

describe("Git tools", () => {
  const testDir = join(tmpdir(), `metalmind-git-${Date.now()}`);
  const ctx = { projectRoot: testDir };

  function initRepo() {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    execSync("git init -b main", { cwd: testDir });
    execSync('git config user.email "test@test.com"', { cwd: testDir });
    execSync('git config user.name "Test"', { cwd: testDir });
  }

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("gitCurrentBranch", () => {
    it("returns current branch name", async () => {
      initRepo();
      const result = await gitCurrentBranchTool.execute({}, ctx);
      expect(result).toBe("main");
    });
  });

  describe("gitCreateBranch", () => {
    it("creates and switches to new branch", async () => {
      initRepo();
      execSync("git commit --allow-empty -m init", { cwd: testDir });
      await gitCreateBranchTool.execute({ name: "feature/foo" }, ctx);
      const branch = await gitCurrentBranchTool.execute({}, ctx);
      expect(branch).toBe("feature/foo");
    });
  });

  describe("gitStatus", () => {
    it("shows branch line on clean status", async () => {
      initRepo();
      execSync("git commit --allow-empty -m init", { cwd: testDir });
      const result = await gitStatusTool.execute({}, ctx);
      expect(result).toContain("## main");
    });

    it("shows untracked files", async () => {
      initRepo();
      writeFileSync(join(testDir, "new.ts"), "console.log('test');");
      const result = await gitStatusTool.execute({}, ctx);
      expect(result).toContain("?? new.ts");
    });
  });

  describe("gitAdd + gitCommit", () => {
    it("stages and commits a file", async () => {
      initRepo();
      writeFileSync(join(testDir, "test.txt"), "content");
      await gitAddTool.execute({ paths: ["test.txt"] }, ctx);
      await gitCommitTool.execute({ message: "add test.txt" }, ctx);

      const log = execSync("git log --oneline", {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(log).toContain("add test.txt");
    });
  });

  describe("gitDiff / gitDiffFile", () => {
    it("shows diff for unstaged changes", async () => {
      initRepo();
      writeFileSync(join(testDir, "file.ts"), "original");
      execSync("git add file.ts && git commit -m init", { cwd: testDir });
      writeFileSync(join(testDir, "file.ts"), "modified");

      const result = await gitDiffTool.execute({}, ctx);
      expect(result).toContain("-original");
      expect(result).toContain("+modified");
    });

    it("shows diff for specific file", async () => {
      initRepo();
      writeFileSync(join(testDir, "a.ts"), "v1");
      writeFileSync(join(testDir, "b.ts"), "v1");
      execSync("git add -A && git commit -m init", { cwd: testDir });
      writeFileSync(join(testDir, "a.ts"), "v2");
      writeFileSync(join(testDir, "b.ts"), "v2");

      const result = await gitDiffFileTool.execute({ path: "b.ts" }, ctx);
      expect(result).toContain("b.ts");
      expect(result).toContain("-v1");
      expect(result).not.toContain("a.ts");
    });
  });

  describe("gitRestore", () => {
    it("restores a modified file", async () => {
      initRepo();
      writeFileSync(join(testDir, "f.ts"), "original");
      execSync("git add f.ts && git commit -m init", { cwd: testDir });
      writeFileSync(join(testDir, "f.ts"), "changed");

      await gitRestoreTool.execute({ paths: ["f.ts"] }, ctx);

      const content = require("node:fs").readFileSync(
        join(testDir, "f.ts"),
        "utf-8",
      );
      expect(content).toBe("original");
    });
  });

  describe("shell-injection safety (#255)", () => {
    it("treats a commit message with $() as a literal string, not a shell command", async () => {
      initRepo();
      const sentinel = join(tmpdir(), `mm-git-inject-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      rmSync(sentinel, { force: true });
      writeFileSync(join(testDir, "f.ts"), "x");
      await gitAddTool.execute({ paths: ["f.ts"] }, ctx);

      const msg = `chore: $(touch ${sentinel}) \`touch ${sentinel}\``;
      await gitCommitTool.execute({ message: msg }, ctx);

      // The shell substitution must NOT have run...
      expect(existsSync(sentinel)).toBe(false);
      // ...and the message must be stored verbatim.
      const stored = execSync("git log -1 --pretty=%B", { cwd: testDir, encoding: "utf-8" }).trim();
      expect(stored).toBe(msg);
      rmSync(sentinel, { force: true });
    });
  });
});
