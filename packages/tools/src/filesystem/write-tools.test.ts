import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeFileTool,
  createFileTool,
  editFileTool,
  deleteFileTool,
  moveFileTool,
  createDirectoryTool,
} from "./write-tools.js";

describe("writeFileTool", () => {
  const testDir = join(tmpdir(), `metalmind-w-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes content to a new file", async () => {
    const result = await writeFileTool.execute(
      { path: "output.txt", content: "hello world" },
      { projectRoot: testDir },
    );
    expect(result).toContain("11 bytes");
    expect(existsSync(join(testDir, "output.txt"))).toBe(true);
  });

  it("overwrites existing file", async () => {
    writeFileSync(join(testDir, "existing.txt"), "old");
    await writeFileTool.execute(
      { path: "existing.txt", content: "new content" },
      { projectRoot: testDir },
    );
    expect(readFileSync(join(testDir, "existing.txt"), "utf-8")).toBe("new content");
  });

  it("creates parent directories", async () => {
    await writeFileTool.execute(
      { path: "deep/nested/file.txt", content: "nested" },
      { projectRoot: testDir },
    );
    expect(existsSync(join(testDir, "deep/nested/file.txt"))).toBe(true);
  });
});

describe("createFileTool", () => {
  const testDir = join(tmpdir(), `metalmind-cf-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates an empty file", async () => {
    await createFileTool.execute(
      { path: "new.txt" },
      { projectRoot: testDir },
    );
    expect(existsSync(join(testDir, "new.txt"))).toBe(true);
  });

  it("fails if file exists", async () => {
    writeFileSync(join(testDir, "exists.txt"), "hi");
    await expect(
      createFileTool.execute(
        { path: "exists.txt" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/already exists/);
  });
});

describe("editFileTool", () => {
  const testDir = join(tmpdir(), `metalmind-ed-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "sample.ts"), "const port = 3000;\nconst host = 'localhost';\n");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("replaces a single occurrence", async () => {
    await editFileTool.execute(
      { path: "sample.ts", oldString: "3000", newString: "8080" },
      { projectRoot: testDir },
    );
    expect(readFileSync(join(testDir, "sample.ts"), "utf-8")).toContain("8080");
    expect(readFileSync(join(testDir, "sample.ts"), "utf-8")).not.toContain("3000");
  });

  it("replaces all with replaceAll flag", async () => {
    writeFileSync(join(testDir, "dups.ts"), "dup dup dup");
    await editFileTool.execute(
      { path: "dups.ts", oldString: "dup", newString: "fix", replaceAll: true },
      { projectRoot: testDir },
    );
    expect(readFileSync(join(testDir, "dups.ts"), "utf-8")).toBe("fix fix fix");
  });

  it("throws when string not found", async () => {
    await expect(
      editFileTool.execute(
        { path: "sample.ts", oldString: "nonexistent", newString: "x" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/String not found/);
  });

  it("fails if multiple occurrences without replaceAll", async () => {
    writeFileSync(join(testDir, "multi.ts"), "x x x");
    await expect(
      editFileTool.execute(
        { path: "multi.ts", oldString: "x", newString: "y" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/Found 3 occurrences/);
  });
});

describe("deleteFileTool", () => {
  const testDir = join(tmpdir(), `metalmind-df-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "todelete.txt"), "bye");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("deletes a file", async () => {
    await deleteFileTool.execute(
      { path: "todelete.txt" },
      { projectRoot: testDir },
    );
    expect(existsSync(join(testDir, "todelete.txt"))).toBe(false);
  });

  it("throws for nonexistent file", async () => {
    await expect(
      deleteFileTool.execute(
        { path: "nope.txt" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/File not found/);
  });
});

describe("moveFileTool", () => {
  const testDir = join(tmpdir(), `metalmind-mv-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "old.ts"), "source");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("renames a file", async () => {
    await moveFileTool.execute(
      { source: "old.ts", destination: "new.ts" },
      { projectRoot: testDir },
    );
    expect(existsSync(join(testDir, "old.ts"))).toBe(false);
    expect(existsSync(join(testDir, "new.ts"))).toBe(true);
  });
});

describe("createDirectoryTool", () => {
  const testDir = join(tmpdir(), `metalmind-cd-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a directory", async () => {
    await createDirectoryTool.execute(
      { path: "newdir" },
      { projectRoot: testDir },
    );
    expect(existsSync(join(testDir, "newdir"))).toBe(true);
  });

  it("fails if already exists", async () => {
    mkdirSync(join(testDir, "exists"));
    await expect(
      createDirectoryTool.execute(
        { path: "exists" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/already exists/);
  });
});
