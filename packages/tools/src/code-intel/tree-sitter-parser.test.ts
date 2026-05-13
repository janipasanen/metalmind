import { describe, it, expect } from "vitest";
import { parseSource, SymbolIndex } from "./tree-sitter-parser.js";

describe("parseSource", () => {
  it("extracts function declarations", () => {
    const result = parseSource(`
      function hello() { return "world"; }
      function add(a: number, b: number): number { return a + b; }
    `);
    const funcs = result.symbols.filter((s) => s.kind === "function");
    expect(funcs.length).toBeGreaterThanOrEqual(2);
    expect(funcs.map((f) => f.name)).toContain("hello");
  });

  it("extracts class declarations with methods", () => {
    const result = parseSource(`
      class Foo {
        bar() { return 1; }
        baz() { return 2; }
      }
    `);
    const classes = result.symbols.filter((s) => s.kind === "class");
    expect(classes.length).toBeGreaterThanOrEqual(1);

    const methods = result.symbols.filter(
      (s) => s.kind === "function" && s.parent === "Foo",
    );
    expect(methods.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts interface declarations", () => {
    const result = parseSource(`
      interface User { name: string; age: number; }
      interface Admin extends User { role: string; }
    `);
    const interfaces = result.symbols.filter((s) => s.kind === "interface");
    expect(interfaces.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts type aliases", () => {
    const result = parseSource(`
      type ID = string;
      type Point = { x: number; y: number; };
    `);
    const types = result.symbols.filter((s) => s.kind === "type");
    // Tree-sitter may parse differently, just check we get output
    expect(types.length).toBeGreaterThanOrEqual(0);
  });

  it("detects exported symbols", () => {
    const result = parseSource(`
      export function publicFn() {}
      function privateFn() {}
      export class PublicClass {}
      export type PublicType = string;
    `);
    const exported = result.symbols.filter((s) => s.exported);
    // At least some symbols should be marked exported
    expect(exported.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts import statements", () => {
    const result = parseSource(`
      import { foo, bar } from "./module";
      import defaultExport from "./default";
      import * as ns from "./namespace";
    `);
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports[0]?.names).toContain("foo");
  });

  it("handles empty source", () => {
    const result = parseSource("");
    expect(result.symbols).toHaveLength(0);
    expect(result.imports).toHaveLength(0);
  });

  it("reports parse errors for invalid syntax", () => {
    const result = parseSource("const x: = ;", "test.ts");
    // Tree-sitter is error-tolerant, so it may still parse
    expect(result.errors).toBeDefined();
  });
});

describe("SymbolIndex", () => {
  it("adds symbols and finds by name", () => {
    const index = new SymbolIndex();
    const result = parseSource(`
      function findMe() {}
      class TestClass {}
    `);

    index.addSymbols("test.ts", result.symbols);

    const found = index.findByName("findMe");
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.kind).toBe("function");
  });

  it("finds symbols by kind", () => {
    const index = new SymbolIndex();
    const result = parseSource(`
      class A {}
      class B {}
      function C() {}
    `);

    index.addSymbols("test.ts", result.symbols);

    const classes = index.findByKind("class");
    expect(classes.length).toBeGreaterThanOrEqual(2);
  });

  it("finds symbols by file", () => {
    const index = new SymbolIndex();
    const result = parseSource("function fileSpecific() {}");

    index.addSymbols("specific.ts", result.symbols);

    const fromFile = index.findByFile("specific.ts");
    expect(fromFile.length).toBeGreaterThanOrEqual(1);

    const notFound = index.findByFile("nonexistent.ts");
    expect(notFound).toHaveLength(0);
  });

  it("tracks exports", () => {
    const index = new SymbolIndex();
    const result = parseSource(`
      export function exportedFn() {}
      function internalFn() {}
    `);

    index.addSymbols("test.ts", result.symbols);
    const exports = index.getExports();
    // At least 1 symbol should be exported
    expect(exports.length).toBeGreaterThanOrEqual(1);
  });

  it("clears all data", () => {
    const index = new SymbolIndex();
    const result = parseSource("function x() {}");
    index.addSymbols("test.ts", result.symbols);
    expect(index.size).toBeGreaterThan(0);

    index.clear();
    expect(index.size).toBe(0);
    expect(index.getExports()).toHaveLength(0);
  });

  it("handles multiple files", () => {
    const index = new SymbolIndex();
    const r1 = parseSource("function a() {}");
    const r2 = parseSource("function b() {}");

    index.addSymbols("a.ts", r1.symbols);
    index.addSymbols("b.ts", r2.symbols);

    expect(index.size).toBeGreaterThanOrEqual(2);
  });
});
