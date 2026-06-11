import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMentions, expandMentions, mentionsContextBlock } from "../mentions.js";

describe("parseMentions (#167)", () => {
  it("extracts @-paths and strips trailing punctuation", () => {
    expect(parseMentions("look at @src/a.ts and @docs/readme.md.")).toEqual(["src/a.ts", "docs/readme.md"]);
  });
  it("ignores text without mentions", () => {
    expect(parseMentions("no mentions here")).toEqual([]);
  });
});

describe("expandMentions + context block (#167)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mm-mention-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads referenced files and reports missing ones", () => {
    const { files, missing } = expandMentions("check @src/a.ts and @src/missing.ts", root);
    expect(files).toEqual([{ path: "src/a.ts", content: "export const a = 1;" }]);
    expect(missing).toEqual(["src/missing.ts"]);
  });

  it("builds a context block for resolved files, null when none", () => {
    const block = mentionsContextBlock("see @src/a.ts", root);
    expect(block).toContain("--- src/a.ts ---");
    expect(block).toContain("export const a = 1;");
    expect(mentionsContextBlock("no mentions", root)).toBeNull();
    expect(mentionsContextBlock("@src/missing.ts", root)).toBeNull();
  });
});
