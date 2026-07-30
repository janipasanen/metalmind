import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, extname, relative, isAbsolute } from "node:path";
import { isBlockedPath } from "@metalmind/tools";
import { RagIndex } from "./rag-index.js";
import { HashingEmbedder, OllamaEmbedder, selectEmbedder, type Embedder } from "./embedder.js";

/**
 * Glue for the retrieval index (#200): resolve the right embedder, build/load the
 * on-disk index, drive the /rag command, and produce retrieval context for a turn.
 */

const INDEXABLE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".swift",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".md", ".txt", ".json", ".yaml", ".yml", ".html", ".css",
]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "target", ".venv", "__pycache__", ".metalmind"]);
const BLOCKED_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube"]);
const MAX_FILES = 300;

export function ragIndexPath(projectRoot: string): string {
  return join(projectRoot, ".metalmind", "rag-index.json");
}

/** Reconstruct the embedder an existing index was built with, from its id. */
export function embedderFromId(id: string): Embedder {
  if (id.startsWith("ollama:")) {
    // Parse "ollama:<model>@<host>" (host optional for older indexes) (#232).
    const rest = id.slice("ollama:".length);
    const at = rest.lastIndexOf("@");
    const model = at >= 0 ? rest.slice(0, at) : rest;
    const host = at >= 0 ? rest.slice(at + 1) : "";
    return new OllamaEmbedder(model, 768, host ? `http://${host}` : undefined);
  }
  return new HashingEmbedder();
}

/** Load the persisted index (matching its embedder); null if absent or empty. */
export function loadRagIndex(projectRoot: string): RagIndex | null {
  const path = ragIndexPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const id = (JSON.parse(readFileSync(path, "utf-8")) as { embedderId?: string }).embedderId ?? "hash-v1";
    const index = new RagIndex(embedderFromId(id), path);
    if (!index.load() || index.size === 0) return null;
    return index;
  } catch {
    return null;
  }
}

function walk(root: string, acc: string[]): void {
  if (acc.length >= MAX_FILES) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true }) as never;
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    if (BLOCKED_DIRS.has(e.name)) continue; // never index secret dirs (#239)
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, acc);
    } else if (e.isFile() && INDEXABLE.has(extname(e.name).toLowerCase()) && !isBlockedPath(full)) {
      acc.push(full);
    }
  }
}

/** Build retrieval context (top-k chunks) for a query, or null if no index/matches. */
export async function retrieveContext(projectRoot: string, query: string, k = 4): Promise<string | null> {
  const index = loadRagIndex(projectRoot);
  if (!index) return null;
  const hits = await index.search(query, k);
  if (hits.length === 0) return null;
  const blocks = hits.map((h) => {
    const rel = relative(projectRoot, h.chunk.file) || h.chunk.file;
    return `--- ${rel}:${h.chunk.startLine}-${h.chunk.endLine} (score ${h.score.toFixed(2)}) ---\n${h.chunk.text}`;
  });
  return `Relevant context retrieved from the indexed documents:\n\n${blocks.join("\n\n")}`;
}

export async function handleRagCommand(rawArgs: string, projectRoot: string, onProgress?: (msg: string) => void): Promise<string> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "status").toLowerCase();
  const rest = parts.slice(1).join(" ");
  const path = ragIndexPath(projectRoot);

  if (sub === "add") {
    if (!rest) return "Usage: /rag add <file-or-directory>";
    const target = join(projectRoot, rest);
    // Keep indexing inside the project and away from sensitive paths (#239).
    if (isAbsolute(rest) || relative(projectRoot, target).startsWith("..") || isBlockedPath(target)) {
      return `Refusing to index a path outside the project or a sensitive path: ${rest}`;
    }
    if (!existsSync(target)) return `Path not found: ${rest}`;

    // Reuse the existing index's embedder so vectors stay compatible; else pick one.
    const existing = existsSync(path)
      ? embedderFromId((JSON.parse(readFileSync(path, "utf-8")) as { embedderId?: string }).embedderId ?? "hash-v1")
      : await selectEmbedder();
    const index = new RagIndex(existing, path);
    index.load();

    const files = statSync(target).isDirectory() ? (() => { const a: string[] = []; walk(target, a); return a; })() : [target];
    let chunks = 0;
    for (let i = 0; i < files.length; i++) {
      // Per-file progress (#343): a directory index with a real embedding model
      // can take minutes — show what's being embedded instead of a blank spinner.
      onProgress?.(`[${i + 1}/${files.length}] ${relative(projectRoot, files[i])}  (${chunks} chunks so far)`);
      try {
        chunks += await index.addFile(files[i], readFileSync(files[i], "utf-8"));
      } catch {
        // skip unreadable files
      }
    }
    index.persist();
    const s = index.status();
    return `Indexed ${files.length} file(s) → ${chunks} new chunk(s). Index now: ${s.files} files / ${s.chunks} chunks (${s.embedder}).`;
  }

  if (sub === "search") {
    if (!rest) return "Usage: /rag search <query>";
    const index = loadRagIndex(projectRoot);
    if (!index) return "RAG index is empty. Add documents with `/rag add <path>`.";
    const hits = await index.search(rest, 5);
    if (hits.length === 0) return `No matches for "${rest}".`;
    return [`Top matches for "${rest}":`, ...hits.map((h) => `  ${relative(projectRoot, h.chunk.file)}:${h.chunk.startLine}  (${h.score.toFixed(2)})`)].join("\n");
  }

  if (sub === "clear") {
    const index = loadRagIndex(projectRoot);
    if (index) index.clear();
    return "RAG index cleared.";
  }

  // status
  const index = loadRagIndex(projectRoot);
  if (!index) return "RAG index is empty. Add documents with `/rag add <path>` (then queries auto-retrieve from them).";
  const s = index.status();
  return `RAG index: ${s.files} file(s), ${s.chunks} chunk(s), embedder ${s.embedder}.`;
}
