import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Simulate a machine without ripgrep: every spawnSync("rg", …) reports ENOENT,
// so both findFiles and searchInFiles must fall back to their hand-rolled walk
// rather than one degrading and the other throwing (#246).
vi.mock("node:child_process", () => ({
  spawnSync: () => ({ error: new Error("spawn rg ENOENT"), status: null, stdout: "", stderr: "" }),
}));

import { searchInFilesTool, findFilesTool } from "./readonly-tools.js";

describe("searchInFiles fallback when ripgrep is absent (#246)", () => {
  const testDir = join(tmpdir(), `metalmind-search-fb-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "a.ts"), "const auth = 'secret';\nconst port = 3000;");
    writeFileSync(join(testDir, "src", "b.ts"), "import { auth } from '../a';\nexport default auth;");
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it("returns matches via the walk fallback instead of throwing", async () => {
    const result = await searchInFilesTool.execute({ pattern: "auth", path: "." }, { projectRoot: testDir });
    // rg --heading style: a path heading followed by `lineno:line` rows.
    expect(result).toContain("a.ts");
    expect(result).toMatch(/\d+:const auth/);
    expect(result).toContain("b.ts");
  });

  it("honours the include glob in the fallback", async () => {
    const result = await searchInFilesTool.execute(
      { pattern: "auth", path: ".", include: "a.ts" },
      { projectRoot: testDir },
    );
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.ts");
  });

  it("returns empty (not an error) when nothing matches", async () => {
    const result = await searchInFilesTool.execute({ pattern: "no_such_token_xyz", path: "." }, { projectRoot: testDir });
    expect(result).toBe("");
  });

  it("findFiles still falls back too, so both behave the same without rg", async () => {
    const result = await findFilesTool.execute({ pattern: "*.ts", path: "." }, { projectRoot: testDir });
    expect(result).toContain("a.ts");
  });
});
