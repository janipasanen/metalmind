import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";

/**
 * Office (docx/pptx) and OpenDocument (odt) generation (#188/#189) via pandoc,
 * which produces real, valid files with no heavy npm dependencies. Falls back to
 * LibreOffice (`soffice`) for formats pandoc can't emit (odp). Every tool degrades
 * gracefully with an install hint when its converter is unavailable.
 */

let pandocPathCache: string | null | undefined;

export function pandocPath(): string | null {
  if (pandocPathCache === undefined) {
    const probe = spawnSync("pandoc", ["--version"], { stdio: "ignore" });
    pandocPathCache = probe.status === 0 ? "pandoc" : null;
  }
  return pandocPathCache;
}

export function sofficePath(): string | null {
  for (const bin of ["soffice", "libreoffice"]) {
    if (spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0) return bin;
  }
  return null;
}

/** Pandoc output format for a target extension, or null if pandoc can't emit it. */
export function pandocTargetFor(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case ".docx": return "docx";
    case ".odt": return "odt";
    case ".pptx": return "pptx";
    case ".rtf": return "rtf";
    case ".epub": return "epub";
    case ".pdf": return "pdf";
    default: return null;
  }
}

/** Run pandoc, converting `content` (in `from` format) to `outPath`. Returns an error string or null on success. */
export function runPandoc(content: string, from: string, outPath: string, to: string): string | null {
  if (!pandocPath()) {
    return "pandoc is not installed. Install it with `brew install pandoc` to generate this format.";
  }
  const tmp = join(tmpdir(), `mm-doc-${Date.now()}-${process.pid}.${from === "html" ? "html" : "md"}`);
  writeFileSync(tmp, content, "utf-8");
  try {
    const result = spawnSync(
      "pandoc",
      [tmp, "-f", from, "-t", to, "-o", outPath, ...(to === "pdf" ? [] : ["--standalone"])],
      { encoding: "utf-8", timeout: 60_000 },
    );
    if (result.status !== 0) {
      return `pandoc failed: ${(result.stderr || result.stdout || "unknown error").slice(-600)}`;
    }
    return null;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function resolveOut(ctx: ToolExecutionContext, path: string): string {
  const validator = new PathValidator(ctx.projectRoot, ctx.workspaceRoots);
  const safePath = validator.resolveSafePath(path);
  mkdirSync(dirname(safePath), { recursive: true });
  return safePath;
}

/** Convert a generated source file to another format with LibreOffice (for odp etc.). */
function sofficeConvert(srcPath: string, toFilter: string, outDir: string): string | null {
  const soffice = sofficePath();
  if (!soffice) {
    return "LibreOffice (soffice) is not installed — needed for this format. Install LibreOffice, or use .pptx instead.";
  }
  const result = spawnSync(soffice, ["--headless", "--convert-to", toFilter, "--outdir", outDir, srcPath], {
    encoding: "utf-8",
    timeout: 90_000,
  });
  return result.status === 0 ? null : `LibreOffice conversion failed: ${(result.stderr || result.stdout || "").slice(-400)}`;
}

const docSchema = z.object({
  path: z.string().min(1),
  title: z.string().default("Document"),
  content: z.string().describe("Document body as Markdown"),
  contentIsHtml: z.boolean().default(false),
});

function makeConvertTool(toolName: string, ext: string, label: string) {
  return createTool({
    toolName,
    description: `Create a ${label} file from Markdown content (via pandoc).`,
    inputSchema: docSchema,
    requiresConfirmation: true,
    async execute(input: z.output<typeof docSchema>, ctx: ToolExecutionContext): Promise<string> {
      const out = resolveOut(ctx, input.path.endsWith(ext) ? input.path : input.path + ext);
      const from = input.contentIsHtml ? "html" : "markdown";
      const body = input.contentIsHtml ? input.content : `# ${input.title}\n\n${input.content}`;
      const to = pandocTargetFor(ext)!;
      const err = runPandoc(body, from, out, to);
      return err ? `Could not create ${input.path}: ${err}` : `Created ${label} at ${input.path}.`;
    },
  });
}

export const createDocxTool: AgentTool<z.input<typeof docSchema>, string> = makeConvertTool("createDocx", ".docx", "Word document (.docx)");
export const createOdtTool: AgentTool<z.input<typeof docSchema>, string> = makeConvertTool("createOdt", ".odt", "OpenDocument text (.odt)");
export const createPptxTool: AgentTool<z.input<typeof docSchema>, string> = makeConvertTool("createPptx", ".pptx", "PowerPoint deck (.pptx)");

const odpSchema = docSchema;
export const createOdpTool: AgentTool<z.input<typeof odpSchema>, string> = createTool({
  toolName: "createOdp",
  description: "Create an OpenDocument presentation (.odp). Builds a .pptx via pandoc then converts with LibreOffice.",
  inputSchema: odpSchema,
  requiresConfirmation: true,
  async execute(input: z.output<typeof odpSchema>, ctx: ToolExecutionContext): Promise<string> {
    const out = resolveOut(ctx, input.path.endsWith(".odp") ? input.path : input.path + ".odp");
    const pptxTmp = join(tmpdir(), `mm-odp-${Date.now()}-${process.pid}.pptx`);
    const body = input.contentIsHtml ? input.content : `# ${input.title}\n\n${input.content}`;
    const perr = runPandoc(body, input.contentIsHtml ? "html" : "markdown", pptxTmp, "pptx");
    if (perr) return `Could not create ${input.path}: ${perr}`;
    try {
      const cerr = sofficeConvert(pptxTmp, "odp", dirname(out));
      return cerr ? `Built a .pptx but couldn't convert to .odp: ${cerr}` : `Created OpenDocument presentation at ${input.path}.`;
    } finally {
      if (existsSync(pptxTmp)) unlinkSync(pptxTmp);
    }
  },
});

export const allConvertTools = [createDocxTool, createOdtTool, createPptxTool, createOdpTool];
