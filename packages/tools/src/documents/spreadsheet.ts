import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";
import { buildZip } from "./zip.js";

/**
 * Spreadsheet generation (#188 xlsx, #189 ods, + csv) with no dependencies:
 * .xlsx is Office Open XML SpreadsheetML and .ods is OpenDocument — both ZIP
 * containers of XML assembled by {@link buildZip}.
 */

export type Cell = string | number;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isNumber(v: Cell): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 0-based column index → spreadsheet column letters (0→A, 26→AA). */
export function columnLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------- XLSX (Office Open XML) ----------

function xlsxCell(value: Cell, rowIdx: number, colIdx: number): string {
  const ref = `${columnLetter(colIdx)}${rowIdx + 1}`;
  if (isNumber(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function xlsxSheet(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => xlsxCell(v, r, c)).join("")}</row>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const list = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }];
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list
    .map(
      (_s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("")}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      (_s, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("")}</Relationships>`;

  const entries = [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xlsxSheet(s.rows) })),
  ];
  return buildZip(entries);
}

// ---------- ODS (OpenDocument) ----------

function odsCell(value: Cell): string {
  if (isNumber(value)) {
    return `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`;
  }
  return `<table:table-cell office:value-type="string"><text:p>${escapeXml(String(value))}</text:p></table:table-cell>`;
}

export function buildOds(sheets: Sheet[]): Buffer {
  const list = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }];
  const tables = list
    .map((s) => {
      const rows = s.rows
        .map((row) => `<table:table-row>${row.map(odsCell).join("")}</table:table-row>`)
        .join("");
      return `<table:table table:name="${escapeXml(s.name)}">${rows}</table:table>`;
    })
    .join("");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;

  // The mimetype entry must come first (OpenDocument requirement).
  const entries = [
    { name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet" },
    { name: "META-INF/manifest.xml", data: manifest },
    { name: "content.xml", data: content },
  ];
  return buildZip(entries);
}

// ---------- CSV ----------

export function rowsToCsv(rows: Cell[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}

/** Parse CSV/TSV text into rows, coercing numeric-looking cells to numbers. */
export function csvToRows(text: string, delimiter = ","): Cell[][] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
    .map((line) =>
      line.split(delimiter).map((field) => {
        const trimmed = field.trim();
        return trimmed !== "" && !Number.isNaN(Number(trimmed)) ? Number(trimmed) : field;
      }),
    );
}

// ---------- Tools ----------

const sheetSchema = z.object({
  path: z.string().min(1),
  sheets: z
    .array(
      z.object({
        name: z.string().default("Sheet1"),
        rows: z.array(z.array(z.union([z.string(), z.number()]))),
      }),
    )
    .optional(),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
  sheetName: z.string().default("Sheet1"),
});

function resolveSheets(input: z.output<typeof sheetSchema>): Sheet[] {
  if (input.sheets && input.sheets.length > 0) return input.sheets;
  return [{ name: input.sheetName, rows: input.rows ?? [] }];
}

function writeBinary(ctx: ToolExecutionContext, path: string, ext: string, data: Buffer): string {
  const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
  const target = path.endsWith(ext) ? path : path + ext;
  const safePath = validator.resolveSafePath(target);
  mkdirSync(dirname(safePath), { recursive: true });
  writeFileSync(safePath, data);
  return target;
}

export const createXlsxTool: AgentTool<z.input<typeof sheetSchema>, string> = createTool({
  toolName: "createXlsx",
  description:
    "Create an Excel (.xlsx) workbook. Provide `sheets:[{name,rows}]` for multiple sheets, or `rows` for a single sheet. Cells may be strings or numbers.",
  inputSchema: sheetSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof sheetSchema>, ctx: ToolExecutionContext): Promise<string> {
    const sheets = resolveSheets(input);
    const out = writeBinary(ctx, input.path, ".xlsx", buildXlsx(sheets));
    return `Created Excel workbook at ${out} (${sheets.length} sheet(s)).`;
  },
});

export const createOdsTool: AgentTool<z.input<typeof sheetSchema>, string> = createTool({
  toolName: "createOds",
  description: "Create an OpenDocument spreadsheet (.ods). Same input shape as createXlsx.",
  inputSchema: sheetSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof sheetSchema>, ctx: ToolExecutionContext): Promise<string> {
    const sheets = resolveSheets(input);
    const out = writeBinary(ctx, input.path, ".ods", buildOds(sheets));
    return `Created OpenDocument spreadsheet at ${out} (${sheets.length} sheet(s)).`;
  },
});

const csvSchema = z.object({
  path: z.string().min(1),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
});

export const createCsvTool: AgentTool<z.input<typeof csvSchema>, string> = createTool({
  toolName: "createCsv",
  description: "Create a CSV file from rows of string/number cells.",
  inputSchema: csvSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof csvSchema>, ctx: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
    const target = input.path.endsWith(".csv") ? input.path : input.path + ".csv";
    const safePath = validator.resolveSafePath(target);
    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, rowsToCsv(input.rows), "utf-8");
    return `Created CSV at ${target} (${input.rows.length} row(s)).`;
  },
});

export const allSpreadsheetTools = [createXlsxTool, createOdsTool, createCsvTool];
