import { z } from "zod";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentTool, ToolExecutionContext } from "../types.js";
import { PathValidator } from "../path-validator.js";
import { createTool } from "../types.js";

export const readFileSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

type ReadFileInput = z.infer<typeof readFileSchema>;

/** Default/maximum lines returned when the model doesn't ask for a range (#281). */
const READ_DEFAULT_LIMIT = 2000;

export const readFileTool: AgentTool<ReadFileInput, string> = createTool({
  toolName: "readFile",
  description:
    "Read a file, returned as line-numbered text (N→content). Use offset (0-based line) and limit to read a " +
    `specific range; without them the first ${READ_DEFAULT_LIMIT} lines are returned. A footer reports the ` +
    "range shown and the file's total lines so you know whether to page further.",
  inputSchema: readFileSchema,
  requiresConfirmation: false,
  async execute(input: ReadFileInput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);

    if (!statSync(safePath).isFile()) {
      throw new Error(`Not a file: ${input.path}`);
    }

    // Binary guard: don't dump NUL-laden bytes into model context (#281).
    const buf = readFileSync(safePath);
    if (buf.subarray(0, 8192).includes(0)) {
      return `(binary file — ${buf.length} bytes; not shown. Use a dedicated tool if you need its contents.)`;
    }

    const content = buf.toString("utf-8");
    const lines = content.split("\n");
    const start = input.offset ?? 0;
    const limit = input.limit ?? READ_DEFAULT_LIMIT;
    const end = Math.min(start + limit, lines.length);
    const sliced = lines.slice(start, end);

    // cat -n style line numbers so the model can cite/edit precisely (#281).
    // Char clamp on LINE boundaries: a mid-line cut with a footer claiming the
    // full range made the model page past lines it never saw. Accumulate whole
    // lines until the budget, and report the range that was ACTUALLY shown so
    // offset-based paging resumes exactly where output stopped (#290 fix).
    const CHAR_CAP = 48_000;
    const width = String(end).length;
    const numbered: string[] = [];
    let chars = 0;
    let shownEnd = start; // last line number actually included (1-based = shownEnd)
    for (let i = 0; i < sliced.length; i++) {
      const line = `${String(start + i + 1).padStart(width)}→${sliced[i]}`;
      if (chars + line.length + 1 > CHAR_CAP && numbered.length > 0) break;
      numbered.push(line);
      chars += line.length + 1;
      shownEnd = start + i + 1;
    }
    const clamped = shownEnd < end ? " — clamped at 48KB" : "";
    const footer =
      start > 0 || shownEnd < lines.length || clamped
        ? `\n(lines ${start + 1}-${shownEnd} of ${lines.length}${clamped} — use offset/limit to read more)`
        : "";
    return numbered.join("\n") + footer;
  },
});

export const listDirectorySchema = z.object({
  path: z.string().default("."),
  /** Recurse this many levels (1 = just the directory itself) (#294). */
  depth: z.number().int().min(1).max(5).default(1),
});
type ListDirectoryOutput = z.output<typeof listDirectorySchema>;

const LIST_ENTRY_CAP = 500;
const LIST_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "target", ".venv", "__pycache__"]);

export const listDirectoryTool: AgentTool<z.input<typeof listDirectorySchema>, string> = createTool({
  toolName: "listDirectory",
  description:
    "List a directory as an indented tree. Directories end with '/', files show their size. " +
    "Set depth (1-5) to recurse; vendored/build dirs are skipped and output is capped.",
  inputSchema: listDirectorySchema,
  requiresConfirmation: false,
  async execute(input: ListDirectoryOutput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);

    if (!statSync(safePath).isDirectory()) {
      throw new Error(`Not a directory: ${input.path}`);
    }

    const out: string[] = [];
    let truncated = false;
    const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)}KB` : `${n}B`);

    const walk = (dir: string, level: number) => {
      if (out.length >= LIST_ENTRY_CAP) { truncated = true; return; }
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const e of entries) {
        if (out.length >= LIST_ENTRY_CAP) { truncated = true; return; }
        const indent = "  ".repeat(level);
        if (e.isDirectory()) {
          out.push(`${indent}${e.name}/`);
          if (level + 1 < input.depth && !LIST_IGNORE_DIRS.has(e.name)) walk(join(dir, e.name), level + 1);
        } else {
          let size = "";
          try { size = ` (${kb(statSync(join(dir, e.name)).size)})`; } catch { /* unreadable */ }
          out.push(`${indent}${e.name}${size}`);
        }
      }
    };
    walk(safePath, 0);

    return out.join("\n") + (truncated ? `\n…(truncated at ${LIST_ENTRY_CAP} entries — list a subdirectory or lower depth)` : "");
  },
});

function globMatch(name: string, pattern: string): boolean {
  // Escape ALL regex metachars first (a pattern like "c++*.h" used to build an
  // invalid regex and throw), then translate glob wildcards: ** crosses path
  // separators, * stays within one segment, ? is a single char.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const translated = escaped
    .split("**").join(String.fromCharCode(0))
    .replace(/\*/g, "[^/]*")
    .split(String.fromCharCode(0)).join(".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${translated}$`).test(name);
  } catch {
    return name === pattern; // unparseable pattern → literal comparison
  }
}

const WALK_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "dist-tsc", "build", ".next", "out", "coverage", ".turbo", "target", ".venv", "__pycache__", ".DS_Store"]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Fallback-walk ignores: skip vendored/build/VCS dirs so we don't walk
        // (and then truncate) node_modules on large repos. Dot-directories are
        // NOT skipped wholesale (#406) — .github/.claude/.vscode are ordinary
        // project content; only the genuinely uninteresting ones are listed.
        if (WALK_IGNORE_DIRS.has(entry.name)) continue;
        results.push(...walkDir(join(dir, entry.name)));
      } else {
        results.push(join(dir, entry.name));
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return results;
}

export const findFilesSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
});
type FindFilesOutput = z.output<typeof findFilesSchema>;

const FIND_FILES_LIMIT = 200;

export const findFilesTool: AgentTool<z.input<typeof findFilesSchema>, string> = createTool({
  toolName: "findFiles",
  description:
    "Find files matching a glob pattern within the project. Respects .gitignore and excludes node_modules/.git/build output. Supports path-aware globs including **.",
  inputSchema: findFilesSchema,
  requiresConfirmation: false,
  async execute(input: FindFilesOutput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const searchDir = validator.resolveSafePath(input.path);

    if (!existsSync(searchDir)) return "";

    const isFile = statSync(searchDir).isFile();
    if (isFile && globMatch(searchDir.split(sep).pop()!, input.pattern)) {
      return relative(context.projectRoot, searchDir);
    }
    if (isFile) return "";

    // Prefer ripgrep: it lists files respecting ignore files, never descends
    // into node_modules/.git, and is bounded — instead of walking the whole tree
    // and truncating after the fact. A bare pattern (no "/") matches at any depth.
    const glob = input.pattern.includes("/") ? input.pattern : `**/${input.pattern}`;
    // Run with cwd=searchDir (no path arg) so path-aware globs like "src/**/*.ts"
    // match relative paths; output is relative to searchDir.
    const rg = spawnSync(
      "rg",
      // --hidden so dot-directories (.github, .claude, .vscode) are findable —
      // rg hides them by default, so `findFiles("*.yml")` silently missed every
      // workflow file (#406). .git stays excluded.
      ["--files", "--hidden", "--glob", glob, "--glob", "!**/node_modules/**", "--glob", "!**/.git/**"],
      { cwd: searchDir, encoding: "utf-8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );

    // Newest-first + explicit truncation marker so a capped result is visibly
    // capped and biased toward recently-touched (usually relevant) files (#293).
    const finish = (absFiles: string[]): string => {
      const withM = absFiles.map((abs) => {
        let m = 0;
        try { m = statSync(abs).mtimeMs; } catch { /* keep 0 */ }
        return { abs, m };
      });
      withM.sort((a, b) => b.m - a.m);
      const rels = withM.map((f) => relative(context.projectRoot, f.abs));
      if (rels.length <= FIND_FILES_LIMIT) return rels.join("\n");
      return (
        rels.slice(0, FIND_FILES_LIMIT).join("\n") +
        `\n…(truncated: showing ${FIND_FILES_LIMIT} of ${rels.length} matches, newest first — narrow the pattern or path)`
      );
    };

    if (!rg.error && (rg.status === 0 || rg.status === 1)) {
      const files = (rg.stdout ?? "")
        .split("\n")
        .filter(Boolean)
        .map((f) => resolve(searchDir, f));
      return finish(files);
    }

    // Fallback (ripgrep not installed): ignore-aware hand-rolled walk. A pattern
    // containing "/" matches the searchDir-RELATIVE path (as rg does) — basename
    // matching made every advertised path-aware glob return nothing without rg.
    const wantsPath = input.pattern.includes("/");
    return finish(
      walkDir(searchDir).filter((f) =>
        wantsPath ? globMatch(relative(searchDir, f), input.pattern) : globMatch(f.split(sep).pop()!, input.pattern),
      ),
    );
  },
});

export /** Per-file match cap handed to ripgrep. Surfaced in the output when hit (#407):
 *  silently stopping at 100 matches in a file let the model conclude it had seen
 *  every occurrence of a symbol it was about to rename. */
const PER_FILE_MATCH_CAP = 500;

const searchInFilesSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  include: z.string().optional(),
  /** Lines of surrounding context per match (rg -C) (#280). */
  contextLines: z.number().int().min(0).max(10).default(0),
  ignoreCase: z.boolean().default(false),
  /** Treat pattern as a literal string, not a regex. */
  literal: z.boolean().default(false),
  /** Return only the list of files with matches. */
  filesOnly: z.boolean().default(false),
  /** Max match lines returned (global cap, not per-file). */
  headLimit: z.number().int().min(1).max(1000).default(200),
});
type SearchInFilesOutput = z.output<typeof searchInFilesSchema>;

/** Global char budget so one broad search can't flood the model context (#280). */
const SEARCH_CHAR_BUDGET = 20_000;

/** Cap search output by line count and char budget, with an explicit marker (#280). */
function capSearchOutput(text: string, headLimit: number): string {
  if (!text) return text;
  const lines = text.split("\n");
  let kept = lines;
  let note = "";
  if (lines.length > headLimit) {
    kept = lines.slice(0, headLimit);
    note = `\n…(truncated: showing ${headLimit} of ${lines.length} lines — narrow with include/path, filesOnly:true, or a more specific pattern)`;
  }
  let out = kept.join("\n");
  if (out.length > SEARCH_CHAR_BUDGET) {
    out = out.slice(0, SEARCH_CHAR_BUDGET);
    note = `\n…(truncated at ${SEARCH_CHAR_BUDGET} chars — narrow with include/path, filesOnly:true, or a more specific pattern)`;
  }
  return out + note;
}

export const searchInFilesTool: AgentTool<z.input<typeof searchInFilesSchema>, string> = createTool({
  toolName: "searchInFiles",
  description:
    "Search file contents with ripgrep. pattern is a regex (set literal:true for exact strings); " +
    "ignoreCase for case-insensitive; contextLines (0-10) shows surrounding lines; filesOnly lists just " +
    "matching files; include filters by glob (e.g. *.ts). Output is capped (headLimit, default 200 lines) " +
    "with an explicit truncation marker — narrow the search rather than paging.",
  inputSchema: searchInFilesSchema,
  requiresConfirmation: false,
  async execute(input: SearchInFilesOutput, context: ToolExecutionContext): Promise<string> {
    const validator = new PathValidator(context.projectRoot, context.workspaceRoots);
    const safePath = validator.resolveSafePath(input.path);

    // --hidden makes dot-directories searchable (#406): .github, .claude,
    // .vscode, .metalmind are ordinary project content, and rg skips them by
    // default — a search for a workflow or a rule file returned NOTHING with no
    // indication why. .git stays excluded explicitly (it is not source).
    // --max-count is applied per file, so it is raised and reported (#407).
    const args: string[] = [
      "--color=never",
      "--hidden",
      "--glob", "!**/.git/**",
      "--max-count", String(PER_FILE_MATCH_CAP),
    ];
    if (input.filesOnly) args.push("-l");
    else args.push("--heading", "--line-number");
    if (input.ignoreCase) args.push("-i");
    if (input.literal) args.push("-F");
    if (input.contextLines > 0 && !input.filesOnly) args.push("-C", String(input.contextLines));
    if (input.include) args.push("--glob", input.include);
    // Explicit "." path: with a piped stdin and no path arg, rg would search
    // stdin instead of the directory. cwd = search dir → relative headings
    // (token-cheap, consistent with findFiles); re-relativized below (#280).
    args.push("-e", input.pattern, ".");
    const result = spawnSync("rg", args, {
      cwd: safePath,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      // ripgrep not installed — degrade to an ignore-aware walk + per-line regex,
      // mirroring findFiles' fallback so both tools behave the same without rg.
      const fb = searchFallback(safePath, context.projectRoot, input.literal ? escapeRegex(input.pattern) : input.pattern, input.include, input.ignoreCase, input.filesOnly);
      return capSearchOutput(fb, input.headLimit);
    }
    if (result.status === 1) return "";
    if (result.status !== 0) {
      throw new Error(`Search failed: ${result.stderr}`);
    }

    // Re-relativize headings/file lines from searchDir-relative to project-relative
    // (rg emits "./x" with an explicit "." path — strip that first).
    const rel = relative(context.projectRoot, safePath);
    const prefix = rel && rel !== "." ? rel + sep : "";
    const out = result.stdout
      .trim()
      .split("\n")
      .map((l) => {
        const isPathLine = l && !/^\d+[-:]/.test(l) && !l.startsWith("--");
        if (!isPathLine) return l;
        const cleaned = l.startsWith("./") ? l.slice(2) : l;
        return prefix + cleaned;
      })
      .join("\n");

    // Warn when any single file hit the per-file cap (#407): rg stops counting
    // there, so the model must not treat the result as exhaustive.
    const perFileHits = new Map<string, number>();
    let currentFile = "";
    for (const l of out.split("\n")) {
      if (l && !/^\d+[-:]/.test(l) && !l.startsWith("--")) currentFile = l;
      else if (/^\d+:/.test(l)) perFileHits.set(currentFile, (perFileHits.get(currentFile) ?? 0) + 1);
    }
    const saturated = [...perFileHits.entries()].filter(([, n]) => n >= PER_FILE_MATCH_CAP).map(([f]) => f);
    const capNote = saturated.length
      ? `\n…(per-file cap of ${PER_FILE_MATCH_CAP} matches reached in ${saturated.length} file(s) — results are NOT exhaustive there: ${saturated.slice(0, 5).join(", ")})`
      : "";

    return capSearchOutput(out, input.headLimit) + capNote;
  },
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEARCH_FALLBACK_FILE_LIMIT = 1000;
const SEARCH_FALLBACK_MATCHES_PER_FILE = 100;

/** rg-less search: walk, read each file, match the pattern per line, render in
 *  ripgrep's --heading --line-number style (path heading, then `lineno:line`).
 *  Mirrors ignoreCase/filesOnly so behaviour matches the rg path (#280). */
function searchFallback(
  safePath: string,
  projectRoot: string,
  pattern: string,
  include?: string,
  ignoreCase = false,
  filesOnly = false,
): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    throw new Error(`Search failed: invalid regex pattern: ${pattern}`);
  }
  const files = (statSync(safePath).isFile() ? [safePath] : walkDir(safePath)).slice(0, SEARCH_FALLBACK_FILE_LIMIT);
  const blocks: string[] = [];
  for (const file of files) {
    if (include && !globMatch(file.split(sep).pop()!, include)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue; // unreadable/binary
    }
    if (content.includes(String.fromCharCode(0))) continue; // skip binary files, like rg
    const hits: string[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && hits.length < SEARCH_FALLBACK_MATCHES_PER_FILE; i++) {
      if (re.test(lines[i])) hits.push(`${i + 1}:${lines[i]}`);
    }
    if (hits.length > 0) {
      blocks.push(filesOnly ? relative(projectRoot, file) : `${relative(projectRoot, file)}\n${hits.join("\n")}`);
    }
  }
  return blocks.join(filesOnly ? "\n" : "\n\n");
}

export const allReadOnlyTools = [
  readFileTool,
  listDirectoryTool,
  findFilesTool,
  searchInFilesTool,
];
