import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readFileTool,
  listDirectoryTool,
  searchInFilesTool,
} from "./readonly-tools.js";

describe("readFileTool", () => {
  const testDir = join(tmpdir(), `metalmind-ro-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "test.txt"), "line1\nline2\nline3\nline4\nline5");
    writeFileSync(join(testDir, "empty.txt"), "");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads file contents", async () => {
    const result = await readFileTool.execute(
      { path: "test.txt" },
      { projectRoot: testDir },
    );
    expect(result).toContain("line1");
    expect(result).toContain("line5");
  });

  it("supports offset", async () => {
    const result = await readFileTool.execute(
      { path: "test.txt", offset: 2 },
      { projectRoot: testDir },
    );
    expect(result).toBe("line3\nline4\nline5");
  });

  it("supports offset + limit", async () => {
    const result = await readFileTool.execute(
      { path: "test.txt", offset: 1, limit: 2 },
      { projectRoot: testDir },
    );
    expect(result).toBe("line2\nline3");
  });

  it("reads empty files", async () => {
    const result = await readFileTool.execute(
      { path: "empty.txt" },
      { projectRoot: testDir },
    );
    expect(result).toBe("");
  });

  it("blocks access to sensitive files", async () => {
    // Traversal/absolute paths are allowed now; the security boundary is the
    // blocked-pattern list (.ssh/.aws/.env/keys).
    await expect(
      readFileTool.execute(
        { path: ".ssh/id_rsa" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/blocked path/);
  });

  it("rejects directories", async () => {
    mkdirSync(join(testDir, "subdir"));
    await expect(
      readFileTool.execute({ path: "subdir" }, { projectRoot: testDir }),
    ).rejects.toThrow(/Not a file/);
  });
});

describe("listDirectoryTool", () => {
  const testDir = join(tmpdir(), `metalmind-list-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "src"));
    mkdirSync(join(testDir, "tests"));
    writeFileSync(join(testDir, "src", "index.ts"), "");
    writeFileSync(join(testDir, "README.md"), "");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("lists directory contents", async () => {
    const result = await listDirectoryTool.execute(
      { path: "." },
      { projectRoot: testDir },
    );
    expect(result).toContain("src/");
    expect(result).toContain("tests/");
    expect(result).toContain("README.md");
  });

  it("lists subdirectory", async () => {
    const result = await listDirectoryTool.execute(
      { path: "src" },
      { projectRoot: testDir },
    );
    expect(result).toBe("index.ts");
  });

  it("rejects files", async () => {
    await expect(
      listDirectoryTool.execute(
        { path: "README.md" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/Not a directory/);
  });
});

describe("searchInFilesTool", () => {
  const testDir = join(tmpdir(), `metalmind-search-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "a.ts"), "const auth = 'secret';\nconst port = 3000;");
    writeFileSync(join(testDir, "b.ts"), "import { auth } from './a';\nexport default auth;");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("executes search command", async () => {
    const result = await searchInFilesTool.execute(
      { pattern: "auth", path: "." },
      { projectRoot: testDir },
    );
    expect(result).toContain("auth");
  });

  it("blocks access to sensitive directories", async () => {
    // Traversal is allowed; only blocked patterns (.ssh/.aws/.env/keys) throw.
    await expect(
      searchInFilesTool.execute(
        { pattern: "root", path: ".ssh" },
        { projectRoot: testDir },
      ),
    ).rejects.toThrow(/blocked path/);
  });
});

import { findFilesTool } from "./readonly-tools.js";

describe("findFilesTool (#163)", () => {
  const testDir = join(tmpdir(), `metalmind-ff-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, "src"), { recursive: true });
    mkdirSync(join(testDir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(testDir, "src", "index.ts"), "export const a = 1;");
    writeFileSync(join(testDir, "src", "util.ts"), "export const b = 2;");
    writeFileSync(join(testDir, "node_modules", "dep", "index.ts"), "module.exports = {};");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("finds matching files but excludes node_modules", async () => {
    const out = await findFilesTool.execute({ pattern: "*.ts", path: "." }, { projectRoot: testDir });
    const files = out.split("\n").filter(Boolean);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/util.ts");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("supports path-aware ** globs", async () => {
    const out = await findFilesTool.execute({ pattern: "src/**/*.ts", path: "." }, { projectRoot: testDir });
    expect(out).toContain("src/index.ts");
    expect(out.includes("node_modules")).toBe(false);
  });
});
