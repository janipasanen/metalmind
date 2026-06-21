import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildImageUrl } from "../image-command.js";

describe("buildImageUrl (#177)", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("passes through an https URL", () => {
    expect(buildImageUrl("https://example.com/cat.png")).toEqual({ url: "https://example.com/cat.png" });
  });

  it("encodes a local png as a base64 data URL", () => {
    dir = mkdtempSync(join(tmpdir(), "mm-img-"));
    const p = join(dir, "pix.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    const { url, error } = buildImageUrl(p);
    expect(error).toBeUndefined();
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(url).toContain(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  });

  it("errors on a missing file", () => {
    expect(buildImageUrl("/no/such/file.png").error).toContain("not found");
  });

  it("errors on an unsupported extension", () => {
    dir = mkdtempSync(join(tmpdir(), "mm-img-"));
    const p = join(dir, "doc.bmp");
    writeFileSync(p, "x");
    expect(buildImageUrl(p).error).toContain("Unsupported");
  });

  it("errors on empty input", () => {
    expect(buildImageUrl("  ").error).toContain("Usage");
  });
});

describe("buildImageUrl blocks sensitive paths (#239)", () => {
  it("refuses to read a path in a blocked directory", () => {
    expect(buildImageUrl("/Users/me/.ssh/id_rsa").error).toMatch(/sensitive/i);
    expect(buildImageUrl("~/.aws/credentials.png").error).toMatch(/sensitive/i);
  });
});
