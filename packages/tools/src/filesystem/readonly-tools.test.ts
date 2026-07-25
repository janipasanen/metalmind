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

  it("supports offset (line-numbered output, #281)", async () => {
    const result = await readFileTool.execute(
      { path: "test.txt", offset: 2 },
      { projectRoot: testDir },
    );
    // cat -n style: real line numbers survive the offset.
    expect(result).toContain("3→line3");
    expect(result).toContain("5→line5");
    expect(result).not.toContain("line1");
  });

  it("supports offset + limit with a range footer (#281)", async () => {
    const result = await readFileTool.execute(
      { path: "test.txt", offset: 1, limit: 2 },
      { projectRoot: testDir },
    );
    expect(result).toContain("2→line2");
    expect(result).toContain("3→line3");
    expect(result).not.toContain("line4");
    expect(result).toMatch(/lines 2-3 of 5/);
  });

  it("reads empty files", async () => {
    const result = await readFileTool.execute(
      { path: "empty.txt" },
      { projectRoot: testDir },
    );
    // single empty line, numbered
    expect(result).toBe("1→");
  });

  it("guards binary files instead of dumping bytes (#281)", async () => {
    writeFileSync(join(testDir, "bin.dat"), Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x00, 0x47]));
    const result = await readFileTool.execute(
      { path: "bin.dat" },
      { projectRoot: testDir },
    );
    expect(result).toMatch(/binary file/i);
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

  it("lists subdirectory (with sizes, #294)", async () => {
    const result = await listDirectoryTool.execute(
      { path: "src" },
      { projectRoot: testDir },
    );
    expect(result).toMatch(/^index\.ts \(0B\)$/);
  });

  it("recurses with depth and indents the tree (#294)", async () => {
    const result = await listDirectoryTool.execute(
      { path: ".", depth: 2 },
      { projectRoot: testDir },
    );
    expect(result).toContain("src/");
    expect(result).toContain("  index.ts"); // indented child
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

  it("supports filesOnly, ignoreCase, and literal modes (#280)", async () => {
    const files = await searchInFilesTool.execute(
      { pattern: "AUTH", path: ".", ignoreCase: true, filesOnly: true },
      { projectRoot: testDir },
    );
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");
    expect(files).not.toMatch(/:\d/); // no line numbers in filesOnly

    const literal = await searchInFilesTool.execute(
      { pattern: "auth = 'secret'", path: ".", literal: true },
      { projectRoot: testDir },
    );
    expect(literal).toContain("a.ts");
  });

  it("shows context lines with contextLines (#280)", async () => {
    const result = await searchInFilesTool.execute(
      { pattern: "port", path: ".", contextLines: 1 },
      { projectRoot: testDir },
    );
    // the line before the match appears as context
    expect(result).toContain("auth");
    expect(result).toContain("port");
  });

  it("caps output at headLimit with an explicit truncation marker (#280)", async () => {
    writeFileSync(join(testDir, "many.txt"), Array.from({ length: 50 }, (_, i) => `hit ${i}`).join("\n"));
    const result = await searchInFilesTool.execute(
      { pattern: "hit", path: ".", headLimit: 10 },
      { projectRoot: testDir },
    );
    expect(result.split("\n").filter((l) => l.includes("hit")).length).toBeLessThanOrEqual(11);
    expect(result).toMatch(/truncated/);
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

describe("audit-4 fixes", () => {
  const testDir = join(tmpdir(), `metalmind-a4-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, "src", "deep"), { recursive: true });
    writeFileSync(join(testDir, "src", "deep", "x.ts"), "content");
    writeFileSync(join(testDir, "c++thing.h"), "content");
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it("findFiles does not crash on regex metachars in the pattern", async () => {
    const result = await findFilesTool.execute({ pattern: "c++*.h", path: "." }, { projectRoot: testDir });
    expect(result).toContain("c++thing.h");
  });

  it("readFile clamp reports the ACTUAL shown range on line boundaries", async () => {
    // 3000 lines x ~30 chars ≈ 90KB numbered — exceeds the 48KB clamp.
    const big = Array.from({ length: 3000 }, (_, i) => `line-${i}-abcdefghijklmnopqrst`).join("\n");
    writeFileSync(join(testDir, "big.txt"), big);
    const result = await readFileTool.execute({ path: "big.txt" }, { projectRoot: testDir });
    const m = /\(lines 1-(\d+) of 3000 — clamped at 48KB/.exec(result);
    expect(m).not.toBeNull();
    const shownEnd = Number(m![1]);
    expect(shownEnd).toBeLessThan(2000); // clamped before the line cap
    // The last numbered line in the body matches the reported range exactly.
    const bodyLines = result.split("\n");
    const lastNumbered = bodyLines[bodyLines.length - 2]; // before the footer
    expect(lastNumbered).toContain(`${shownEnd}→`);
  });
});
