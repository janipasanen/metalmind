import { describe, it, expect } from "vitest";
import {
  parseBracketedPaste,
  endsWithContinuation,
  applyContinuation,
  insertPaste,
  previewBuffer,
} from "../multiline.js";

describe("bracketed paste (#160)", () => {
  it("strips paste markers and flags multiline", () => {
    expect(parseBracketedPaste("[200~line1\nline2[201~")).toEqual({ text: "line1\nline2", isMultiline: true });
  });
  it("flags plain multi-line input without markers", () => {
    expect(parseBracketedPaste("a\nb")).toEqual({ text: "a\nb", isMultiline: true });
  });
  it("passes single-line input through", () => {
    expect(parseBracketedPaste("hello")).toEqual({ text: "hello", isMultiline: false });
  });
});

describe("line continuation (#160)", () => {
  it("detects a single trailing backslash but not an escaped one", () => {
    expect(endsWithContinuation("foo\\")).toBe(true);
    expect(endsWithContinuation("foo\\\\")).toBe(false); // escaped backslash, not a continuation
    expect(endsWithContinuation("foo")).toBe(false);
  });
  it("replaces the trailing backslash with a newline", () => {
    expect(applyContinuation("line one\\")).toBe("line one\n");
  });
});

describe("paste insertion + preview (#160)", () => {
  it("inserts pasted text at the cursor", () => {
    expect(insertPaste("abef", 2, "cd")).toBe("abcdef");
  });
  it("previews a multiline buffer with a line-count hint", () => {
    expect(previewBuffer("a\nb\nc")).toBe("…(+2 lines) c");
    expect(previewBuffer("single")).toBe("single");
  });
});
