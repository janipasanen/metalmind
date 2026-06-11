import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";

/**
 * Markup document tools (#190): HTML and LaTeX authoring with no external
 * dependencies. LaTeX can optionally be compiled to PDF when a TeX engine
 * (tectonic / pdflatex) is on PATH.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal, dependency-free Markdown → HTML for headings, paragraphs, and inline code/emphasis. */
function miniMarkdownToHtml(md: string): string {
  const blocks = md.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const heading = block.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${inline(heading[2])}</h${level}>`;
      }
      if (/^\s*[-*]\s+/.test(block)) {
        const items = block
          .split(/\n/)
          .filter((l) => /^\s*[-*]\s+/.test(l))
          .map((l) => `  <li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`)
          .join("\n");
        return `<ul>\n${items}\n</ul>`;
      }
      return `<p>${inline(block.trim()).replace(/\n/g, "<br>\n")}</p>`;
    })
    .join("\n");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function buildHtmlDocument(title: string, body: string, bodyIsHtml = false): string {
  const inner = bodyIsHtml ? body : miniMarkdownToHtml(body);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; line-height: 1.6; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
    code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  </style>
</head>
<body>
${inner}
</body>
</html>
`;
}

const LATEX_SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function escapeLatex(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => LATEX_SPECIALS[c] ?? c);
}

export function buildLatexDocument(title: string, body: string): string {
  // Treat blank-line-separated blocks as paragraphs; leading # lines as sections.
  const content = body
    .split(/\n{2,}/)
    .map((block) => {
      const h = block.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const cmd = h[1].length === 1 ? "section" : h[1].length === 2 ? "subsection" : "subsubsection";
        return `\\${cmd}{${escapeLatex(h[2])}}`;
      }
      return escapeLatex(block.trim());
    })
    .join("\n\n");
  return `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{hyperref}
\\title{${escapeLatex(title)}}
\\date{}
\\begin{document}
\\maketitle
${content}
\\end{document}
`;
}

/** Detect an available LaTeX→PDF engine. */
export function detectTexEngine(): string | null {
  for (const engine of ["tectonic", "pdflatex"]) {
    const probe = spawnSync(engine, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return engine;
  }
  return null;
}

function writeSafe(ctx: ToolExecutionContext, path: string, content: string): string {
  const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
  const safePath = validator.resolveSafePath(path);
  mkdirSync(dirname(safePath), { recursive: true });
  writeFileSync(safePath, content, "utf-8");
  return safePath;
}

const htmlSchema = z.object({
  path: z.string().min(1).describe("Output .html path"),
  title: z.string().default("Document"),
  body: z.string().describe("Body content — Markdown by default, or raw HTML if bodyIsHtml=true"),
  bodyIsHtml: z.boolean().default(false),
});

export const createHtmlTool: AgentTool<z.input<typeof htmlSchema>, string> = createTool({
  toolName: "createHtml",
  description: "Create a standalone, styled HTML document from Markdown (or raw HTML) body content.",
  inputSchema: htmlSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof htmlSchema>, ctx: ToolExecutionContext): Promise<string> {
    const html = buildHtmlDocument(input.title, input.body, input.bodyIsHtml);
    writeSafe(ctx, input.path, html);
    return `Wrote HTML document to ${input.path} (${html.length} bytes)`;
  },
});

const latexSchema = z.object({
  path: z.string().min(1).describe("Output .tex path"),
  title: z.string().default("Document"),
  body: z.string().describe("Body content (lightweight Markdown headings + paragraphs)"),
  compile: z.boolean().default(false).describe("Also compile to PDF if a TeX engine is installed"),
});

export const createLatexTool: AgentTool<z.input<typeof latexSchema>, string> = createTool({
  toolName: "createLatex",
  description: "Create a LaTeX (.tex) document, optionally compiling it to PDF (needs tectonic or pdflatex).",
  inputSchema: latexSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof latexSchema>, ctx: ToolExecutionContext): Promise<string> {
    const tex = buildLatexDocument(input.title, input.body);
    const safePath = writeSafe(ctx, input.path, tex);
    if (!input.compile) return `Wrote LaTeX document to ${input.path} (${tex.length} bytes)`;

    const engine = detectTexEngine();
    if (!engine) {
      return `Wrote ${input.path}, but no TeX engine (tectonic/pdflatex) is installed — skipped PDF. Install one to compile.`;
    }
    const args = engine === "tectonic" ? [safePath] : ["-interaction=nonstopmode", "-output-directory", dirname(safePath), safePath];
    const result = spawnSync(engine, args, { encoding: "utf-8", timeout: 60_000 });
    if (result.status !== 0) {
      return `Wrote ${input.path}; PDF compilation with ${engine} failed:\n${(result.stderr || result.stdout || "").slice(-600)}`;
    }
    return `Wrote ${input.path} and compiled a PDF with ${engine}.`;
  },
});

const markdownSchema = z.object({
  path: z.string().min(1).describe("Output .md path"),
  content: z.string(),
});

export const createMarkdownTool: AgentTool<z.input<typeof markdownSchema>, string> = createTool({
  toolName: "createMarkdown",
  description: "Create a Markdown (.md) document.",
  inputSchema: markdownSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof markdownSchema>, ctx: ToolExecutionContext): Promise<string> {
    writeSafe(ctx, input.path, input.content);
    return `Wrote Markdown document to ${input.path} (${input.content.length} bytes)`;
  },
});
