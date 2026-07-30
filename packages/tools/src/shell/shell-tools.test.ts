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

import { runFormatTool } from "./shell-tools.js";

describe("runFormatTool (#162)", () => {
  const testDir = join(tmpdir(), `metalmind-fmt-${Date.now()}`);
  beforeEach(() => { rmSync(testDir, { recursive: true, force: true }); mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("runs a configurable format command", async () => {
    // Use a harmless command standing in for prettier.
    const result = await runFormatTool.execute(
      { command: "echo formatted", timeout: 10000 },
      { projectRoot: testDir },
    );
    expect(result).toContain("formatted");
    expect(result).toContain("Format complete");
  });

  it("appends the path to the command when provided", async () => {
    const result = await runFormatTool.execute(
      { command: "echo", path: "src/x.ts", timeout: 10000 },
      { projectRoot: testDir },
    );
    expect(result).toContain("src/x.ts");
  });

  it("reports failure without throwing when the command exits non-zero", async () => {
    const result = await runFormatTool.execute(
      { command: "false", timeout: 10000 },
      { projectRoot: testDir },
    );
    expect(result).toContain("Format failed");
  });
});

describe("live output streaming (gap-5)", () => {
  it("forwards stdout chunks to ctx.onOutput as they arrive", async () => {
    const chunks: string[] = [];
    const result = await runCommandTool.execute(
      { command: "echo first; sleep 0.2; echo second" },
      { projectRoot: process.cwd(), onOutput: (c) => chunks.push(c) },
    );
    expect(result).toContain("first");
    expect(result).toContain("second");
    // Streaming delivered at least two separate chunks (not one final blob).
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("")).toContain("first");
    expect(chunks.join("")).toContain("second");
  });
});
