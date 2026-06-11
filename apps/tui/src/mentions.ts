import { readFileSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

/**
 * @-file mentions (#167): when a message references `@path/to/file`, the file's
 * content is pulled into context for that turn. Parsing is pure; reading is
 * bounded and skips anything that isn't a regular file.
 */

const MAX_FILE_BYTES = 64 * 1024;

/** Extract @-mention paths from text (tokens after @ that look like paths). */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/[.,;:]+$/, ""); // strip trailing punctuation
    if (p) out.push(p);
  }
  return out;
}

export interface ExpandedMentions {
  files: Array<{ path: string; content: string }>;
  missing: string[];
}

/** Read the files referenced by @-mentions, relative to projectRoot. */
export function expandMentions(text: string, projectRoot: string): ExpandedMentions {
  const files: Array<{ path: string; content: string }> = [];
  const missing: string[] = [];
  for (const rel of parseMentions(text)) {
    const abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
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
export function mentionsContextBlock(text: string, projectRoot: string): string | null {
  const { files } = expandMentions(text, projectRoot);
  if (files.length === 0) return null;
  const blocks = files.map((f) => `--- ${f.path} ---\n${f.content}`);
  return `Files referenced with @ in the message:\n\n${blocks.join("\n\n")}`;
}
