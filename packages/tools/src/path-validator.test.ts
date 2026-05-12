import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PathValidator } from "./path-validator.js";

describe("PathValidator", () => {
  const testDir = join(tmpdir(), `metalmind-path-${Date.now()}`);
  let validator: PathValidator;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "index.ts"), "console.log('ok');");
    writeFileSync(join(testDir, ".env"), "SECRET=xxx");
    validator = new PathValidator(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("resolveSafePath", () => {
    it("resolves a relative path within root", () => {
      const resolved = validator.resolveSafePath("src/index.ts");
      expect(resolved).toBe(join(testDir, "src/index.ts"));
    });

    it("resolves a child path", () => {
      const resolved = validator.resolveSafePath("src");
      expect(resolved).toBe(join(testDir, "src"));
    });

    it("blocks parent directory traversal", () => {
      expect(() => validator.resolveSafePath("../../../etc/passwd")).toThrow(
        /outside project root/,
      );
    });

    it("blocks parent traversal with .. prefix", () => {
      expect(() => validator.resolveSafePath("../outside")).toThrow(
        /outside project root/,
      );
    });

    it("blocks path starting with /", () => {
      expect(() => validator.resolveSafePath("/etc/passwd")).toThrow(
        /outside project root/,
      );
    });

    it("blocks .ssh directory access", () => {
      mkdirSync(join(testDir, ".ssh"), { recursive: true });
      expect(() => validator.resolveSafePath(".ssh/config")).toThrow(
        /blocked path/,
      );
    });

    it("blocks .aws directory access", () => {
      mkdirSync(join(testDir, ".aws"), { recursive: true });
      expect(() => validator.resolveSafePath(".aws/credentials")).toThrow(
        /blocked path/,
      );
    });

    it("blocks .gnupg access", () => {
      expect(() => validator.resolveSafePath(".gnupg/pubring.kbx")).toThrow(
        /blocked path/,
      );
    });

    it("blocks .kube access", () => {
      expect(() => validator.resolveSafePath(".kube/config")).toThrow(
        /blocked path/,
      );
    });

    it("blocks access to .git-credentials", () => {
      writeFileSync(join(testDir, ".git-credentials"), "creds");
      expect(() => validator.resolveSafePath(".git-credentials")).toThrow(
        /blocked path/,
      );
    });

    it("blocks id_rsa files", () => {
      expect(() => validator.resolveSafePath("id_rsa")).toThrow(
        /blocked path/,
      );
    });

    it("handles . in path", () => {
      const resolved = validator.resolveSafePath("./src/../src/index.ts");
      expect(resolved).toBe(join(testDir, "src/index.ts"));
    });
  });

  describe("toRelative", () => {
    it("returns path relative to project root", () => {
      const abs = join(testDir, "src/index.ts");
      expect(validator.toRelative(abs)).toBe("src/index.ts");
    });
  });

  describe("isValidPath", () => {
    it("returns true for safe paths", () => {
      expect(validator.isValidPath("src/index.ts")).toBe(true);
    });

    it("returns false for traversal paths", () => {
      expect(validator.isValidPath("../../../etc/passwd")).toBe(false);
    });
  });

  describe("fileExists", () => {
    it("returns true for existing files", () => {
      expect(validator.fileExists("src/index.ts")).toBe(true);
    });

    it("returns false for nonexistent files", () => {
      expect(validator.fileExists("src/nope.ts")).toBe(false);
    });

    it("returns false for blocked paths", () => {
      expect(validator.fileExists("../../etc/passwd")).toBe(false);
    });

    it("returns false for directories", () => {
      expect(validator.fileExists("src")).toBe(false);
    });
  });

  describe("directoryExists", () => {
    it("returns true for existing directories", () => {
      expect(validator.directoryExists("src")).toBe(true);
    });

    it("returns false for files", () => {
      expect(validator.directoryExists("src/index.ts")).toBe(false);
    });

    it("returns false for nonexistent", () => {
      expect(validator.directoryExists("nonexistent")).toBe(false);
    });
  });
});
