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
});
