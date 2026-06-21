import { describe, it, expect } from "vitest";

function parseDiff(raw: string): Array<{ text: string; type: string }> {
  const lines: Array<{ text: string; type: string }> = [];
  const rawLines = raw.length === 0 ? [] : raw.split("\n");
  for (const line of rawLines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      lines.push({ text: line, type: "header" });
    } else if (line.startsWith("@@")) {
      lines.push({ text: line, type: "info" });
    } else if (line.startsWith("-")) {
      lines.push({ text: line, type: "remove" });
    } else if (line.startsWith("+")) {
      lines.push({ text: line, type: "add" });
    } else if (line.startsWith(" ")) {
      lines.push({ text: line, type: "context" });
    } else {
      lines.push({ text: line, type: "info" });
    }
  }
  return lines;
}

describe("DiffView parsing", () => {
  it("parses header lines", () => {
    const parsed = parseDiff("--- a/file.ts\n+++ b/file.ts");
    expect(parsed[0].type).toBe("header");
    expect(parsed[1].type).toBe("header");
  });

  it("parses added and removed lines", () => {
    const parsed = parseDiff("-old\n+new");
    expect(parsed[0].type).toBe("remove");
    expect(parsed[1].type).toBe("add");
  });

  it("parses context lines", () => {
    const parsed = parseDiff(" unchanged");
    expect(parsed[0].type).toBe("context");
  });

  it("parses hunk headers", () => {
    const parsed = parseDiff("@@ -1,3 +1,4 @@");
    expect(parsed[0].type).toBe("info");
  });

  it("handles empty string gracefully", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
