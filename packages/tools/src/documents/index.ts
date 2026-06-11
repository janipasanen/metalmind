import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";
import {
  buildHtmlDocument,
  buildLatexDocument,
  createHtmlTool,
  createLatexTool,
  createMarkdownTool,
} from "./markup.js";
import {
  allConvertTools,
  createOdpTool,
  pandocTargetFor,
  runPandoc,
} from "./convert.js";
import {
  allSpreadsheetTools,
  buildXlsx,
  buildOds,
  csvToRows,
} from "./spreadsheet.js";
import { writeFileSync as writeBin } from "node:fs";

/** Formats writeDocument can produce, grouped by how they're generated. */
const PANDOC_EXTS = new Set([".docx", ".odt", ".pptx", ".rtf", ".epub", ".pdf"]);
const PLAIN_EXTS = new Set([".md", ".markdown", ".txt"]);

const writeDocSchema = z.object({
  path: z.string().min(1).describe("Output path; the extension selects the format"),
  content: z.string().describe("Document body — Markdown unless contentIsHtml is set"),
  title: z.string().default("Document"),
  contentIsHtml: z.boolean().default(false),
});

/**
 * Generic document writer (#191): dispatches by file extension to the right
 * generator — Markdown/text written as-is, HTML and LaTeX built in-process,
 * Office/ODF/PDF via pandoc, and .odp via LibreOffice. Programming/source files
 * (any other extension) are written verbatim.
 */
export const writeDocumentTool: AgentTool<z.input<typeof writeDocSchema>, string> = createTool({
  toolName: "writeDocument",
  description:
    "Create a document, choosing the format from the file extension: .md/.txt, .html, .tex, .docx, .odt, " +
    ".pptx, .odp, .pdf (and any source-code extension). Office/ODF/PDF require pandoc (PDF also a TeX engine).",
  inputSchema: writeDocSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof writeDocSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);
    mkdirSync(dirname(safePath), { recursive: true });
    const ext = extname(safePath).toLowerCase();

    if (ext === ".html" || ext === ".htm") {
      writeFileSync(safePath, buildHtmlDocument(input.title, input.content, input.contentIsHtml), "utf-8");
      return `Created HTML document at ${input.path}.`;
    }
    if (ext === ".tex") {
      writeFileSync(safePath, buildLatexDocument(input.title, input.content), "utf-8");
      return `Created LaTeX document at ${input.path}.`;
    }
    if (ext === ".csv") {
      // Content may be CSV text already, or rows we re-serialize for consistent quoting.
      writeFileSync(safePath, input.content, "utf-8");
      return `Wrote CSV to ${input.path}.`;
    }
    if (ext === ".xlsx" || ext === ".ods") {
      // Interpret the content as CSV (or TSV if tabs dominate) and build the workbook.
      const delimiter = input.content.includes("\t") && !input.content.includes(",") ? "\t" : ",";
      const rows = csvToRows(input.content, delimiter);
      const data = ext === ".xlsx" ? buildXlsx([{ name: "Sheet1", rows }]) : buildOds([{ name: "Sheet1", rows }]);
      writeBin(safePath, data);
      return `Created ${ext.slice(1)} spreadsheet at ${input.path} (${rows.length} row(s)).`;
    }
    if (ext === ".odp") {
      return createOdpTool.execute(input, ctx);
    }
    if (PANDOC_EXTS.has(ext)) {
      const to = pandocTargetFor(ext)!;
      const from = input.contentIsHtml ? "html" : "markdown";
      const body = input.contentIsHtml ? input.content : `# ${input.title}\n\n${input.content}`;
      const err = runPandoc(body, from, safePath, to);
      return err ? `Could not create ${input.path}: ${err}` : `Created ${ext.slice(1)} document at ${input.path}.`;
    }
    // Markdown, text, and any source-code file: write verbatim.
    writeFileSync(safePath, input.content, "utf-8");
    const kind = PLAIN_EXTS.has(ext) ? "document" : "file";
    return `Wrote ${kind} to ${input.path} (${input.content.length} bytes).`;
  },
});

export const allDocumentTools: AgentTool<unknown, string>[] = [
  writeDocumentTool,
  createHtmlTool,
  createLatexTool,
  createMarkdownTool,
  ...allConvertTools,
  ...allSpreadsheetTools,
] as AgentTool<unknown, string>[];

export {
  buildXlsx,
  buildOds,
  rowsToCsv,
  csvToRows,
  columnLetter,
  createXlsxTool,
  createOdsTool,
  createCsvTool,
} from "./spreadsheet.js";
export { buildZip, crc32 } from "./zip.js";

export {
  buildHtmlDocument,
  buildLatexDocument,
  escapeHtml,
  escapeLatex,
  detectTexEngine,
} from "./markup.js";
export {
  pandocPath,
  sofficePath,
  pandocTargetFor,
  runPandoc,
  createDocxTool,
  createOdtTool,
  createPptxTool,
  createOdpTool,
} from "./convert.js";
export {
  createHtmlTool,
  createLatexTool,
  createMarkdownTool,
} from "./markup.js";
