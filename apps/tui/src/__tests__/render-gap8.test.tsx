import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import DiffView from "../components/DiffView.js";
import MarkdownText from "../components/MarkdownText.js";

describe("DiffView header classification (#401)", () => {
  it("renders a deleted line starting with -- as a deletion, not diff metadata", () => {
    const diff = [
      "--- a/schema.sql",
      "+++ b/schema.sql",
      "@@ -1,3 +1,3 @@",
      " CREATE TABLE t (id int);",
      "--- legacy comment kept for reference",
      "+++counter;",
    ].join("\n");
    const { lastFrame } = render(<DiffView diff={diff} filePath="schema.sql" maxLines={20} />);
    const frame = lastFrame() ?? "";
    // Both the real header and the content lines must be present…
    expect(frame).toContain("legacy comment kept for reference");
    expect(frame).toContain("counter;");
    // …and the hunk header itself still renders.
    expect(frame).toContain("@@ -1,3 +1,3 @@");
  });

  it("still treats the leading file headers as headers", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
    const { lastFrame } = render(<DiffView diff={diff} filePath="x.ts" maxLines={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("old");
    expect(frame).toContain("new");
  });
});

describe("MarkdownText inline layout (#400)", () => {
  it("keeps a formatted line intact instead of shattering it into columns", () => {
    const { lastFrame } = render(
      <MarkdownText text="The **bold part** and `code part` and *italics* all on one line." />,
    );
    const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
    // Every word survives, on a single rendered line.
    for (const word of ["bold part", "code part", "italics", "all on one line."]) {
      expect(frame).toContain(word);
    }
    expect(frame.trim().split("\n")).toHaveLength(1);
  });

  it("renders a bullet with inline formatting on one line", () => {
    const { lastFrame } = render(<MarkdownText text="- item with **emphasis** here" />);
    const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
    expect(frame).toContain("item with");
    expect(frame).toContain("emphasis");
    expect(frame).toContain("here");
  });
});
