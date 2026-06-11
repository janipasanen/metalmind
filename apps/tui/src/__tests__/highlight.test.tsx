import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { highlightLine } from "../highlight.js";
import MarkdownText from "../components/MarkdownText.js";

describe("highlightLine (#171)", () => {
  const colorOf = (spans: ReturnType<typeof highlightLine>, text: string) =>
    spans.find((s) => s.text === text)?.color;

  it("colors keywords, strings, numbers, and comments for TypeScript", () => {
    const spans = highlightLine('const x = "hi"; // note', "ts");
    expect(colorOf(spans, "const")).toBe("blueBright");
    expect(colorOf(spans, '"hi"')).toBe("yellow");
    // the comment is a single trailing span
    expect(spans.some((s) => s.text.startsWith("//") && s.color === "gray")).toBe(true);
    const numSpans = highlightLine("let n = 42", "ts");
    expect(colorOf(numSpans, "42")).toBe("magenta");
  });

  it("uses # comments and python keywords for python", () => {
    const spans = highlightLine("def f(): # doc", "python");
    expect(colorOf(spans, "def")).toBe("blueBright");
    expect(spans.some((s) => s.text.startsWith("#") && s.color === "gray")).toBe(true);
  });

  it("reconstructs the original line exactly from spans", () => {
    const line = "for (let i = 0; i < n; i++) {";
    expect(highlightLine(line, "ts").map((s) => s.text).join("")).toBe(line);
  });
});

describe("MarkdownText highlights fenced code (#171)", () => {
  it("renders a code block (smoke: no crash, content present)", () => {
    const md = "Here:\n```ts\nconst x = 1;\n```\ndone";
    const { lastFrame } = render(<MarkdownText text={md} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("done");
  });
});
