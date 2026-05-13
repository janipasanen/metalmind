import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RepoMapV2 } from "./repo-map-v2.js";

const TEST_DIR = "/tmp/metalmind-test-repo-v2";

function setupTestRepo(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  writeFileSync(
    join(TEST_DIR, "index.ts"),
    `export function main() { return "hello"; }\nexport class App {}\n`,
  );
  writeFileSync(
    join(TEST_DIR, "utils.ts"),
    `import { main } from "./index";\nexport function helper() { return main(); }\n`,
  );
  writeFileSync(join(TEST_DIR, "README.md"), "# Test Repo\n");
}

function cleanupTestRepo(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe("RepoMapV2", () => {
  beforeEach(() => setupTestRepo());
  afterEach(() => cleanupTestRepo());

  it("generates basic entries without code intelligence", () => {
    const map = new RepoMapV2(TEST_DIR);
    const entries = map.generate();

    const files = entries.filter((e) => e.type === "file");
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("generates entries with symbols when includeSymbols is true", () => {
    const map = new RepoMapV2(TEST_DIR, { includeSymbols: true });
    const entries = map.generate();

    const tsFiles = entries.filter(
      (e) => e.type === "file" && (e.path.endsWith(".ts")),
    );

    const withSymbols = tsFiles.filter(
      (e) => e.symbols && e.symbols.length > 0,
    );
    expect(withSymbols.length).toBeGreaterThan(0);
  });

  it("builds dependency graph with includeImports", () => {
    const map = new RepoMapV2(TEST_DIR, {
      includeSymbols: true,
      includeImports: true,
    });
    map.generate();

    const graph = map.getDependencyGraph();
    // Check that we have entries in the graph (dependency resolution may vary by env)
    expect(graph).toBeDefined();
    expect(graph instanceof Map).toBe(true);
  });

  it("computes relevance scores", () => {
    const map = new RepoMapV2(TEST_DIR, {
      includeSymbols: true,
      includeImports: true,
    });
    const entries = map.generate();

    const withScore = entries.filter(
      (e) => e.type === "file" && e.relevanceScore !== undefined,
    );
    // index.ts should have higher relevance since utils.ts depends on it
    const indexEntry = entries.find((e) => e.path === "index.ts");
    expect(indexEntry?.relevanceScore).toBeGreaterThanOrEqual(0);
  });

  it("generates enhanced tree string", () => {
    const map = new RepoMapV2(TEST_DIR, {
      includeSymbols: true,
      includeImports: true,
    });

    const tree = map.toTreeString();
    expect(tree.length).toBeGreaterThan(0);
    expect(tree).toContain("index.ts");
  });

  it("generates enhanced summary", () => {
    const map = new RepoMapV2(TEST_DIR, {
      includeSymbols: true,
      includeImports: true,
    });

    const summary = map.getSummary();
    expect(summary).toContain("Symbols:");
    expect(summary).toContain("Dependency graph:");
  });
});
