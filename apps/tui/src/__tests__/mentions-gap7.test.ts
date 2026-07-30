import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMentions, formatMention, expandMentions } from "../mentions.js";

describe("@-mention paths with spaces and absolute forms (#386)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mm-mentions-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "design notes.md"), "SPACED CONTENT");
    writeFileSync(join(root, "plain.ts"), "PLAIN CONTENT");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("parses quoted mentions whole and keeps the unquoted form working", () => {
    expect(parseMentions('look at @"docs/design notes.md" please')).toEqual(["docs/design notes.md"]);
    expect(parseMentions("see @plain.ts, thanks")).toEqual(["plain.ts"]);
    expect(parseMentions("@'docs/design notes.md'")).toEqual(["docs/design notes.md"]);
    // Both forms in one message.
    expect(parseMentions('@plain.ts and @"docs/design notes.md"')).toEqual([
      "plain.ts",
      "docs/design notes.md",
    ]);
  });

  it("formatMention quotes only when needed", () => {
    expect(formatMention("src/a.ts")).toBe("@src/a.ts");
    expect(formatMention("docs/design notes.md")).toBe('@"docs/design notes.md"');
  });

  it("reads a spaced path that previously resolved to nothing", () => {
    const { files, missing } = expandMentions('review @"docs/design notes.md"', root);
    expect(missing).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("SPACED CONTENT");
  });

  it("accepts an absolute path inside the project, still rejects outside/blocked ones", () => {
    const inside = expandMentions(`check @${join(root, "plain.ts")}`, root);
    expect(inside.files).toHaveLength(1);
    expect(inside.files[0].content).toBe("PLAIN CONTENT");

    const outside = expandMentions("check @/etc/hosts", root);
    expect(outside.files).toEqual([]);
    expect(outside.missing).toEqual(["/etc/hosts"]);

    const blocked = expandMentions('check @"~/.ssh/id_rsa"', root);
    expect(blocked.files).toEqual([]);
  });
});
