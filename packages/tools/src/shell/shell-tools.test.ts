import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  runCommandTool,
  runTestsTool,
  runBuildTool,
  runLintTool,
} from "./shell-tools.js";

describe("runCommandTool", () => {
  const testDir = join(tmpdir(), `metalmind-shell-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("executes a simple command", async () => {
    const result = await runCommandTool.execute(
      { command: "echo hello" },
      { projectRoot: testDir },
    );
    expect(result).toContain("hello");
    expect(result).toContain("Exit: 0");
  });

  it("returns stderr for failing commands", async () => {
    const result = await runCommandTool.execute(
      { command: "ls nonexistentdir 2>&1 || true" },
      { projectRoot: testDir },
    );
    expect(result).toContain("Exit:");
  });

  it("blocks dangerous commands", async () => {
    await expect(
      runCommandTool.execute(
        { command: "rm -rf /" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/Dangerous command blocked/);
  });

  it("blocks sudo commands", async () => {
    await expect(
      runCommandTool.execute(
        { command: "sudo npm install" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/Dangerous command blocked/);
  });
});

describe("runBuildTool / runLintTool", () => {
  const testDir = join(tmpdir(), `metalmind-tool-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("runs build via default command", async () => {
    const result = await runBuildTool.execute(
      {},
      { projectRoot: testDir },
    );
    expect(result).toMatch(/Build (succeeded|FAILED)/);
  });

  it("runs lint with custom command", async () => {
    const result = await runLintTool.execute(
      { command: "echo 'lint ok'" },
      { projectRoot: testDir },
    );
    expect(result).toContain("lint ok");
  });
});
