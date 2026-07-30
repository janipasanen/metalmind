import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PathValidator, isBlockedPath } from "./path-validator.js";

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

    // Traversal and absolute paths are intentionally allowed — the AI needs to
    // work on any directory the user points it at. Only sensitive patterns
    // (.ssh/.aws/.env/keys) are blocked (see tests below).
    it("allows parent directory traversal (cross-project access)", () => {
      expect(validator.resolveSafePath("../../../etc/passwd")).toBe(
        resolve(testDir, "../../../etc/passwd"),
      );
    });

    it("allows parent traversal with .. prefix (cross-project access)", () => {
      expect(validator.resolveSafePath("../outside")).toBe(
        resolve(testDir, "../outside"),
      );
    });

    it("allows absolute paths outside the project root", () => {
      expect(validator.resolveSafePath("/etc/passwd")).toBe("/etc/passwd");
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

    it("returns true for traversal paths (cross-project access allowed)", () => {
      expect(validator.isValidPath("../../../etc/passwd")).toBe(true);
    });

    it("returns false for blocked sensitive paths", () => {
      expect(validator.isValidPath(".ssh/id_rsa")).toBe(false);
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

  describe("dotted secret-file variants (#262)", () => {
    it("blocks .env.local / .env.production / id_rsa.pub, not just exact names", () => {
      for (const p of [".env.local", ".env.production", "config/.env.development", "keys/id_rsa.pub", "id_ed25519.pub"]) {
        expect(validator.isValidPath(p)).toBe(false);
        expect(() => validator.resolveSafePath(p)).toThrow(/blocked path/i);
      }
    });
    it("still allows ordinary files that merely start similarly", () => {
      expect(validator.isValidPath("environment.ts")).toBe(true);
      expect(validator.isValidPath("src/envelope.ts")).toBe(true);
    });
  });
});

describe("isBlockedPath dotted variants (#262)", () => {
  it("blocks .env.* and id_rsa.* anywhere in the path", () => {
    expect(isBlockedPath("/home/u/.env.local")).toBe(true);
    expect(isBlockedPath("project/.env.production")).toBe(true);
    expect(isBlockedPath("/home/u/.ssh/id_rsa.pub")).toBe(true);
  });
  it("does not block lookalikes", () => {
    expect(isBlockedPath("src/environment.ts")).toBe(false);
    expect(isBlockedPath("docs/env.md")).toBe(false);
  });
});

describe("case-insensitive blocking + symlink resolution (#359)", () => {
  it("blocks capitalized variants of sensitive segments (macOS is case-insensitive)", () => {
    for (const p of ["~/.SSH/id_rsa", "/Users/x/.Env", "/Users/x/.AWS/credentials", "/Users/x/ID_RSA", "/x/.NpmRc"]) {
      expect(isBlockedPath(p)).toBe(true);
    }
  });

  it("still allows ordinary paths that merely resemble a blocked name", () => {
    expect(isBlockedPath("/Users/x/project/environment.ts")).toBe(false);
    expect(isBlockedPath("/Users/x/project/sshconfig.md")).toBe(false);
  });

  it("resolveSafePath rejects a capitalized blocked segment", () => {
    const v = new PathValidator("/tmp/project");
    expect(() => v.resolveSafePath("/Users/x/.SSH/config")).toThrow(/blocked path/i);
  });

  it("follows symlinks so a link to a blocked dir is still blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "mm-symlink-"));
    const secretDir = join(root, ".ssh");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "id_rsa"), "PRIVATE KEY");
    const link = join(root, "keys");
    symlinkSync(secretDir, link);

    // Lexically "keys/id_rsa" looks innocent; the real path is .ssh/id_rsa.
    expect(isBlockedPath(join(link, "id_rsa"))).toBe(true);
    const v = new PathValidator(root);
    expect(() => v.resolveSafePath(join(link, "id_rsa"))).toThrow(/blocked path/i);
    rmSync(root, { recursive: true, force: true });
  });
});
