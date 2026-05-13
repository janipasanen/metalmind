import { describe, it, expect } from "vitest";
import { ContextBudgetOptimizer } from "./context-budget.js";
import type { EnhancedEntry } from "./repo-map-v2.js";

function makeEntry(overrides: Partial<EnhancedEntry> = {}): EnhancedEntry {
  return {
    path: overrides.path ?? "src/file.ts",
    type: "file",
    size: overrides.size ?? 1000,
    lastModified: new Date(),
    symbols: overrides.symbols ?? [],
    exportedSymbols: overrides.exportedSymbols ?? 0,
    relevanceScore: overrides.relevanceScore ?? 0,
    dependencies: overrides.dependencies,
    importCount: overrides.importCount ?? 0,
  };
}

describe("ContextBudgetOptimizer", () => {
  it("allocates budget across files", () => {
    const optimizer = new ContextBudgetOptimizer();
    const entries: EnhancedEntry[] = [
      makeEntry({ path: "critical.ts", relevanceScore: 30, exportedSymbols: 5 }),
      makeEntry({ path: "high.ts", relevanceScore: 10, exportedSymbols: 3 }),
      makeEntry({ path: "medium.ts", relevanceScore: 3 }),
      makeEntry({ path: "low.ts", relevanceScore: 0 }),
    ];

    const result = optimizer.allocate(entries, 32000);
    expect(result.allocated).toBeGreaterThan(0);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
    expect(result.allocations.length).toBeGreaterThan(0);
  });

  it("respects model context limit", () => {
    const optimizer = new ContextBudgetOptimizer();
    const entries: EnhancedEntry[] = [
      makeEntry({ path: "big.ts", size: 100000, relevanceScore: 100 }),
    ];

    const result = optimizer.allocate(entries, 8000);
    expect(result.allocated).toBeLessThanOrEqual(8000);
  });

  it("prioritizes critical files", () => {
    const optimizer = new ContextBudgetOptimizer();
    const entries: EnhancedEntry[] = [
      makeEntry({ path: "critical.ts", relevanceScore: 50 }),
      makeEntry({ path: "low.ts", relevanceScore: 0.5 }),
    ];

    const result = optimizer.allocate(entries, 32000);
    const criticalAllocs = result.allocations.filter(
      (a) => a.priority === "critical",
    );
    expect(criticalAllocs.length).toBeGreaterThan(0);
  });

  it("estimates tokens from content", () => {
    const optimizer = new ContextBudgetOptimizer();
    const contents = new Map([
      ["a.ts", "function hello() { return 1; }"],
      ["b.ts", "export const x = 42;"],
    ]);
    const tokens = optimizer.estimateTokens(contents);
    expect(tokens).toBeGreaterThan(5); // ~52 chars / 4 = ~13 tokens
  });

  it("checks if content fits budget", () => {
    const optimizer = new ContextBudgetOptimizer();
    const content = "short content";
    expect(optimizer.fitsBudget(content, 100)).toBe(true);
    expect(optimizer.fitsBudget(content, 1)).toBe(false);
  });

  it("formats a readable report", () => {
    const optimizer = new ContextBudgetOptimizer();
    const entries: EnhancedEntry[] = [
      makeEntry({ path: "main.ts", relevanceScore: 25, exportedSymbols: 3 }),
    ];

    const result = optimizer.allocate(entries, 16000);
    const report = optimizer.formatReport(result);
    expect(report).toContain("Context Budget Report");
    expect(report).toContain("main.ts");
  });
});
