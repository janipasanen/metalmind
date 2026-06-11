import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHtmlDocument,
  buildLatexDocument,
  escapeLatex,
  writeDocumentTool,
  createHtmlTool,
  createLatexTool,
  createMarkdownTool,
  createDocxTool,
  createPptxTool,
  pandocPath,
} from "./index.js";
import type { ToolExecutionContext } from "../types.js";

const havePandoc = pandocPath() !== null;

describe("markup generators (#190)", () => {
  it("builds a standalone HTML document with an escaped title and headings", () => {
    const html = buildHtmlDocument("A & B <test>", "# Hello\n\nworld");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>A &amp; B &lt;test&gt;</title>");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>world</p>");
  });

  it("escapes LaTeX special characters and renders sections", () => {
    expect(escapeLatex("50% & $100 #1 _x")).toBe("50\\% \\& \\$100 \\#1 \\_x");
    const tex = buildLatexDocument("My Doc", "# Intro\n\nBody text.");
    expect(tex).toContain("\\documentclass{article}");
    expect(tex).toContain("\\section{Intro}");
    expect(tex).toContain("Body text.");
  });
});

describe("document tools — filesystem (#190/#191)", () => {
  let dir: string;
  let ctx: ToolExecutionContext;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mm-docs-"));
    ctx = { projectRoot: dir, workspaceRoots: [dir] } as ToolExecutionContext;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("createHtml writes a valid .html file", async () => {
    await createHtmlTool.execute({ path: "out.html", title: "T", body: "# Hi", bodyIsHtml: false }, ctx);
    const out = join(dir, "out.html");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf-8")).toContain("<h1>Hi</h1>");
  });

  it("createLatex writes a .tex file (no compile)", async () => {
    const msg = await createLatexTool.execute({ path: "out.tex", title: "T", body: "Body", compile: false }, ctx);
    expect(existsSync(join(dir, "out.tex"))).toBe(true);
    expect(msg).toContain("Wrote LaTeX");
  });

  it("createMarkdown writes a .md file verbatim", async () => {
    await createMarkdownTool.execute({ path: "notes.md", content: "# Title\n\n- a\n- b" }, ctx);
    expect(readFileSync(join(dir, "notes.md"), "utf-8")).toBe("# Title\n\n- a\n- b");
  });

  it("writeDocument routes by extension: html, tex, and verbatim code", async () => {
    await writeDocumentTool.execute({ path: "a.html", content: "# H", title: "X", contentIsHtml: false }, ctx);
    await writeDocumentTool.execute({ path: "b.tex", content: "para", title: "X", contentIsHtml: false }, ctx);
    await writeDocumentTool.execute({ path: "c.py", content: "print('hi')", title: "X", contentIsHtml: false }, ctx);
    expect(readFileSync(join(dir, "a.html"), "utf-8")).toContain("<!DOCTYPE html>");
    expect(readFileSync(join(dir, "b.tex"), "utf-8")).toContain("\\documentclass");
    expect(readFileSync(join(dir, "c.py"), "utf-8")).toBe("print('hi')");
  });

  it.skipIf(!havePandoc)("createDocx produces a valid .docx (zip) via pandoc", async () => {
    const msg = await createDocxTool.execute({ path: "report.docx", title: "Report", content: "## Section\n\nText.", contentIsHtml: false }, ctx);
    const out = join(dir, "report.docx");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).subarray(0, 2).toString("latin1")).toBe("PK"); // OOXML = zip
    expect(msg).toContain("Created");
  });

  it.skipIf(!havePandoc)("createPptx produces a valid .pptx via pandoc", async () => {
    await createPptxTool.execute({ path: "deck.pptx", title: "Deck", content: "# Slide 1\n\nPoint.", contentIsHtml: false }, ctx);
    const out = join(dir, "deck.pptx");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it.skipIf(havePandoc)("createDocx fails gracefully when pandoc is absent", async () => {
    const msg = await createDocxTool.execute({ path: "report.docx", title: "R", content: "x", contentIsHtml: false }, ctx);
    expect(msg.toLowerCase()).toContain("pandoc");
  });
});
