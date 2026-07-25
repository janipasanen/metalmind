import { describe, it, expect } from "vitest";
import { DiffGenerator } from "./diff-generator.js";

describe("DiffGenerator", () => {
  describe("previewEdit", () => {
    it("generates patch for a file in the project", () => {
      const projectRoot = process.cwd();
      const preview = DiffGenerator.previewEdit(
        "package.json",
        projectRoot,
        "metalmind",
        "test-replacement",
        false,
      );
      expect(preview.path).toBe("package.json");
      expect(preview.original).toContain("metalmind");
    });
  });

  describe("generatePatch", () => {
    it("creates unified diff header", () => {
      const patch = DiffGenerator.generatePatch(
        "file.ts",
        "line1\nline2",
        "line1\nmodified",
      );
      expect(patch).toContain("--- a/file.ts");
      expect(patch).toContain("+++ b/file.ts");
    });

    it("shows added and removed lines", () => {
      const patch = DiffGenerator.generatePatch(
        "test.ts",
        "old line",
        "new line",
      );
      expect(patch).toContain("-old line");
      expect(patch).toContain("+new line");
    });

    it("handles empty original", () => {
      const patch = DiffGenerator.generatePatch("new.ts", "", "content");
      expect(patch).toContain("+content");
    });

    it("handles empty modified", () => {
      const patch = DiffGenerator.generatePatch("del.ts", "content", "");
      expect(patch).toContain("-content");
    });

    it("preserves unchanged context lines", () => {
      const original = "a\nb\nCHANGE\nc\nd";
      const modified = "a\nb\nFIXED\nc\nd";
      const patch = DiffGenerator.generatePatch("ctx.ts", original, modified);
      expect(patch).toContain(" a");
      expect(patch).toContain(" b");
      expect(patch).toContain("-CHANGE");
      expect(patch).toContain("+FIXED");
    });

    it("handles multiple changes", () => {
      const original = "a\nb\nc";
      const modified = "x\nb\ny";
      const patch = DiffGenerator.generatePatch("multi.ts", original, modified);
      expect(patch).toContain("-a");
      expect(patch).toContain("+x");
      expect(patch).toContain("-c");
      expect(patch).toContain("+y");
    });
  });

  describe("LCS alignment (#278)", () => {
    it("a one-line insertion does not cascade into the rest of the file", () => {
      const original = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const lines = original.split("\n");
      lines.splice(5, 0, "INSERTED LINE");
      const patch = DiffGenerator.generatePatch("big.ts", original, lines.join("\n"));

      const adds = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      const dels = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
      expect(adds).toEqual(["+INSERTED LINE"]); // exactly one +, no churn
      expect(dels).toEqual([]);
      // and the patch is small (one hunk + context), not the whole file
      expect(patch.split("\n").length).toBeLessThan(15);
    });

    it("emits proper @@ hunk headers with line numbers", () => {
      const original = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
      const modified = "a\nb\nc\nd\nE\nf\ng\nh\ni\nj";
      const patch = DiffGenerator.generatePatch("h.ts", original, modified);
      expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
      expect(patch).toContain("-e");
      expect(patch).toContain("+E");
    });

    it("distant changes produce separate hunks", () => {
      const lines = Array.from({ length: 60 }, (_, i) => `l${i}`);
      const mod = [...lines];
      mod[2] = "CHANGED-TOP";
      mod[55] = "CHANGED-BOTTOM";
      const patch = DiffGenerator.generatePatch("two.ts", lines.join("\n"), mod.join("\n"));
      const hunks = patch.split("\n").filter((l) => l.startsWith("@@"));
      expect(hunks.length).toBe(2);
    });
  });

  describe("previewMultiEdit (#279)", () => {
    it("previews per-file diffs for a multi-edit batch", () => {
      const dir = mkdtempSync(join(tmpdir(), "mm-medit-"));
      writeFileSync(join(dir, "one.ts"), "const a = 1;\nconst b = 2;");
      writeFileSync(join(dir, "two.ts"), "export function f() { return 0; }");
      const diff = DiffGenerator.previewMultiEdit(
        [
          { path: "one.ts", oldString: "const a = 1;", newString: "const a = 100;" },
          { path: "two.ts", oldString: "return 0;", newString: "return 42;" },
        ],
        dir,
      );
      expect(diff).toContain("--- a/one.ts");
      expect(diff).toContain("+const a = 100;");
      expect(diff).toContain("--- a/two.ts");
      expect(diff).toContain("+export function f() { return 42; }");
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
