import { describe, it, expect, beforeEach } from "vitest";
import { parseSource } from "./tree-sitter-parser.js";
import { ReferenceIndex } from "./reference-index.js";

describe("ReferenceIndex", () => {
  let index: ReferenceIndex;

  beforeEach(() => {
    index = new ReferenceIndex();
  });

  it("finds symbol definitions across files", () => {
    const result = parseSource("function hello() { return 1; }");
    index.indexFile("test.ts", result, "function hello() { return 1; }");

    const found = index.findSymbol("hello");
    expect(found.definitions.length).toBeGreaterThanOrEqual(1);
    expect(found.definitions[0]?.symbol.kind).toBe("function");
  });

  it("finds references to a symbol", () => {
    const source = `
      function hello() { return 1; }
      const x = hello();
      hello();
    `;
    const result = parseSource(source);
    index.indexFile("test.ts", result, source);

    const refs = index.findReferences("hello");
    // Should find at least the two calls: hello() and hello()
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it("builds call graph for functions", () => {
    const source = `
      function a() { b(); c(); }
      function b() { c(); }
      function c() {}
    `;
    const result = parseSource(source);
    index.indexFile("test.ts", result, source);

    const callees = index.getCallees("a");
    expect(callees).toContain("b");
    expect(callees).toContain("c");

    const callers = index.getCallers("c");
    expect(callers).toContain("a");
    expect(callers).toContain("b");
  });

  it("getCallGraph returns full graph", () => {
    const source = `
      function f1() { f2(); }
      function f2() { f3(); }
      function f3() {}
    `;
    const result = parseSource(source);
    index.indexFile("test.ts", result, source);

    const graph = index.getCallGraph();
    expect(Object.keys(graph).length).toBeGreaterThanOrEqual(2);
  });

  it("findSymbol returns empty when symbol not found", () => {
    const found = index.findSymbol("nonexistent");
    expect(found.definitions).toHaveLength(0);
    expect(found.references).toHaveLength(0);
  });

  it("clears all data", () => {
    const result = parseSource("function x() {}");
    index.indexFile("test.ts", result, "function x() {}");
    expect(index.getFiles().length).toBeGreaterThan(0);

    index.clear();
    expect(index.getFiles()).toHaveLength(0);
    expect(index.findSymbol("x").definitions).toHaveLength(0);
  });

  it("handles multiple files", () => {
    const r1 = parseSource("function a() {}");
    const r2 = parseSource("function b() { a(); }");

    index.indexFile("a.ts", r1, "function a() {}");
    index.indexFile("b.ts", r2, "function b() { a(); }");

    expect(index.getFiles().length).toBe(2);
    expect(index.getCallees("b")).toContain("a");
  });

  it("does not count definition site as reference", () => {
    const source = "function unique() {}";
    const result = parseSource(source);
    index.indexFile("test.ts", result, source);

    const refs = index.findReferences("unique");
    // Definition itself should not be a reference
    // But there may be none if unique is only defined
    expect(refs.length).toBe(0);
  });
});
