import { readFileSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { isBlockedPath } from "@metalmind/tools";

/**
 * @-file mentions (#167): when a message references `@path/to/file`, the file's
 * content is pulled into context for that turn. Parsing is pure; reading is
 * bounded and skips anything that isn't a regular file.
 */

const MAX_FILE_BYTES = 64 * 1024;

/** Extract @-mention paths from text.
 *  Two forms (#386):
 *    @path/to/file            — a whitespace-delimited token
 *    @"path with spaces.md"   — quoted, so real filenames with spaces work
 *  The autocomplete and the file tree insert the quoted form automatically when
 *  a path contains a space; unquoted space-containing paths were silently
 *  truncated at the space and reported as missing. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s@]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const quoted = m[1] ?? m[2];
    // Only strip trailing punctuation from the UNQUOTED form — inside quotes it
    // is part of the filename.
    const p = quoted ?? m[3].replace(/[.,;:]+$/, "");
    if (p) out.push(p);
  }
  return out;
}

/** Render a path as an @-mention, quoting it when it contains whitespace (#386). */
export function formatMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export interface ExpandedMentions {
  files: Array<{ path: string; content: string }>;
  missing: string[];
}

/** Read the files referenced by @-mentions, relative to projectRoot.
 *  `workspaceRoots` are the additional directories granted via /workspace: a
 *  mention resolving into one of them is legitimate (#411). Without them, every
 *  @-mention of a file in an added root silently resolved to nothing. */
export function expandMentions(text: string, projectRoot: string, workspaceRoots: string[] = []): ExpandedMentions {
  const files: Array<{ path: string; content: string }> = [];
  const missing: string[] = [];
  const roots = [projectRoot, ...workspaceRoots];
  const insideARoot = (abs: string): boolean =>
    roots.some((root) => {
      const r = relative(root, abs);
      return r !== "" && !r.startsWith("..") && !isAbsolute(r);
    });

  for (const rel of parseMentions(text)) {
    // Resolve against the project first, then any workspace root, so a bare
    // "notes.md" living in an added root is found too.
    let abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
    if (!isAbsolute(rel) && !existsSync(abs)) {
      const alt = workspaceRoots.map((root) => join(root, rel)).find((p) => existsSync(p));
      if (alt) abs = alt;
    }
    // Stay away from sensitive paths (#239). An ABSOLUTE path inside the project
    // (or inside an allowed workspace root) is fine — rejecting every absolute
    // path meant a pasted full path silently resolved to nothing (#386); what
    // actually matters is that the resolved target stays within a granted root.
    if (isBlockedPath(abs) || !insideARoot(abs)) {
      missing.push(rel);
      continue;
    }
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        let content = readFileSync(abs, "utf-8");
        if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES) + "\n…(truncated)";
        files.push({ path: rel, content });
      } else {
        missing.push(rel);
      }
    } catch {
      missing.push(rel);
    }
  }
  return { files, missing };
}

/** Build a context block for the mentioned files, or null if none resolved. */
export function mentionsContextBlock(text: string, projectRoot: string, workspaceRoots: string[] = []): string | null {
  const { files } = expandMentions(text, projectRoot, workspaceRoots);
  if (files.length === 0) return null;
  const blocks = files.map((f) => `--- ${f.path} ---\n${f.content}`);
  return `Files referenced with @ in the message:\n\n${blocks.join("\n\n")}`;
}
