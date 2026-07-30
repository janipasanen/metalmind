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

describe("re-indexing and scale (#398/#399)", () => {
  it("does not duplicate references when the same file is indexed repeatedly", () => {
    const index = new ReferenceIndex();
    const source = ["export function target() {}", "target();", "target();"].join("\n");
    const parsed = parseSource(source, "typescript");

    index.indexFile("/p/a.ts", parsed, source);
    const first = index.findSymbol("target").references.length;

    // Ten more saves of the same file must not multiply the reference count.
    for (let i = 0; i < 10; i++) index.indexFile("/p/a.ts", parsed, source);
    expect(index.findSymbol("target").references.length).toBe(first);
    expect(index.getFiles()).toEqual(["/p/a.ts"]);
  });

  it("drops entries for a file that no longer defines a symbol", () => {
    const index = new ReferenceIndex();
    const withSym = "export function gone() {}\ngone();";
    index.indexFile("/p/b.ts", parseSource(withSym, "typescript"), withSym);
    expect(index.findSymbol("gone").definitions).toHaveLength(1);

    const without = "export function other() {}";
    index.indexFile("/p/b.ts", parseSource(without, "typescript"), without);
    expect(index.findSymbol("gone").definitions).toHaveLength(0);
    expect(index.findSymbol("gone").references).toHaveLength(0);
  });

  it("builds the call graph in linear time over many functions", () => {
    const index = new ReferenceIndex();
    // 300 functions, each calling the next: the old O(functions^2) regex scan
    // made this pathological; it must now finish quickly.
    const src = Array.from({ length: 300 }, (_, i) => `function f${i}() { f${i + 1}(); }`).join("\n");
    const started = process.hrtime.bigint();
    index.indexFile("/p/big.ts", parseSource(src, "typescript"), src);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(index.findSymbol("f10").definitions).toHaveLength(1);
    expect(ms).toBeLessThan(3000);
  });
});
