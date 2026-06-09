import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFile, findSymbolTool, resetReferenceIndex, getReferenceIndex } from "./symbol-tools.js";

describe("symbol index population & refresh (#149)", () => {
  const dir = join(tmpdir(), `metalmind-sym-${Date.now()}`);
  const file = join(dir, "mod.ts");

  beforeEach(() => {
    resetReferenceIndex();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetReferenceIndex();
  });

  it("findSymbol returns results after a file is indexed", async () => {
    writeFileSync(file, "export function fooBar() { return 1; }\n");
    indexFile(file);

    const out = await findSymbolTool.execute({ name: "fooBar" }, { projectRoot: dir });
    expect(out).toContain("Definitions");
    expect(out).toContain("fooBar");
    expect(out).toContain("mod.ts");
  });

  it("re-indexing a changed file updates subsequent lookups", async () => {
    writeFileSync(file, "export function fooBar() {}\n");
    indexFile(file);
    expect(await findSymbolTool.execute({ name: "fooBar" }, { projectRoot: dir })).toContain("Definitions");

    // Rename the symbol and re-index — the old name is gone, the new one is found.
    writeFileSync(file, "export function bazQux() {}\n");
    indexFile(file);

    const oldLookup = await findSymbolTool.execute({ name: "fooBar" }, { projectRoot: dir });
    expect(oldLookup).toMatch(/No symbol "fooBar" found/);
    const newLookup = await findSymbolTool.execute({ name: "bazQux" }, { projectRoot: dir });
    expect(newLookup).toContain("Definitions");
  });

  it("shares one global index instance", () => {
    expect(getReferenceIndex()).toBe(getReferenceIndex());
  });
});

import { findReferencesTool, setLspClient } from "./symbol-tools.js";
import { writeFileSync as wfs, mkdirSync as mds, rmSync as rms } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir as tmp } from "node:os";

describe("findReferences LSP preference + fallback (#178)", () => {
  const dir = joinPath(tmp(), `mm-lsp-${Date.now()}`);
  const file = joinPath(dir, "m.ts");

  beforeEach(() => {
    resetReferenceIndex();
    setLspClient(null);
    rms(dir, { recursive: true, force: true });
    mds(dir, { recursive: true });
    wfs(file, "export function fooBar() {}\nfooBar();\n");
    indexFile(file);
  });

  afterEach(() => {
    setLspClient(null);
    rms(dir, { recursive: true, force: true });
  });

  it("prefers LSP references when a connected server is available", async () => {
    const fakeLsp = {
      isConnected: () => true,
      references: async () => [{ filePath: "/x/other.ts", line: 41, character: 2 }],
    };
    setLspClient(fakeLsp as never);
    const out = await findReferencesTool.execute({ name: "fooBar" }, { projectRoot: dir });
    expect(out).toContain("via LSP");
    expect(out).toContain("/x/other.ts:42"); // 0-based line + 1
  });

  it("falls back to the heuristic index when no LSP is connected", async () => {
    const out = await findReferencesTool.execute({ name: "fooBar" }, { projectRoot: dir });
    expect(out).not.toContain("via LSP");
    expect(out).toContain("References to \"fooBar\"");
  });
});
