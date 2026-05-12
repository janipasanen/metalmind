import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoMap } from "./repo-map.js";

describe("RepoMap", () => {
  const testDir = join(tmpdir(), `metalmind-repomap-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "src"), { recursive: true });
    mkdirSync(join(testDir, "src/utils"), { recursive: true });
    mkdirSync(join(testDir, "tests"), { recursive: true });
    mkdirSync(join(testDir, "node_modules"), { recursive: true });

    writeFileSync(join(testDir, "src/index.ts"), "export default {};");
    writeFileSync(join(testDir, "src/utils/helper.ts"), "export const x = 1;");
    writeFileSync(join(testDir, "tests/index.test.ts"), "import {} from '../src';");
    writeFileSync(join(testDir, "package.json"), "{}");
    writeFileSync(join(testDir, "node_modules/.keep"), "");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("generates file and directory entries excluding node_modules", () => {
    const map = new RepoMap(testDir);
    const entries = map.generate();

    const paths = entries.map((e) => e.path);
    expect(paths).toContain("src/");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/utils/");
    expect(paths).toContain("src/utils/helper.ts");
    expect(paths).toContain("tests/");
    expect(paths).toContain("tests/index.test.ts");
    expect(paths).toContain("package.json");

    // node_modules should be excluded
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  it("respects maxFiles limit", () => {
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(testDir, `file-${i}.txt`), "x");
    }
    const map = new RepoMap(testDir, { maxFiles: 10 });
    const files = map.generate().filter((e) => e.type === "file");
    expect(files.length).toBeLessThanOrEqual(10);
  });

  it("generates tree string", () => {
    const map = new RepoMap(testDir);
    const tree = map.toTreeString();
    expect(tree).toContain("src");
    expect(tree).toContain("index.ts");
    expect(tree).toContain("helper.ts");
  });

  it("generates project summary", () => {
    const map = new RepoMap(testDir);
    const summary = map.getSummary();
    expect(summary).toContain("Files:");
    expect(summary).toContain("Directories:");
    expect(summary).toContain(".ts");
  });
});
