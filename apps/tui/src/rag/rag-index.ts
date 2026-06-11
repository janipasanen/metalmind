import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cosine, type Embedder } from "./embedder.js";

/**
 * A small on-disk retrieval index (#179/#200): files are chunked, each chunk is
 * embedded, and queries return the top-k most similar chunks by cosine
 * similarity. Vectors are tagged with the embedder id so a stale index (built
 * with a different embedder) can be detected.
 */

export interface Chunk {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  vector: number[];
}

interface IndexFile {
  embedderId: string;
  chunks: Chunk[];
}

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 8;

/** Split text into overlapping line-based chunks. */
export function chunkText(text: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.split("\n");
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const body = slice.join("\n").trim();
    if (body.length === 0) continue;
    chunks.push({ startLine: i + 1, endLine: Math.min(i + CHUNK_LINES, lines.length), text: slice.join("\n") });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

export class RagIndex {
  private chunks: Chunk[] = [];
  constructor(
    private embedder: Embedder,
    private path?: string,
  ) {}

  get embedderId(): string {
    return this.embedder.id;
  }

  /** Index a file's content, replacing any existing chunks for that file. */
  async addFile(file: string, content: string): Promise<number> {
    this.chunks = this.chunks.filter((c) => c.file !== file);
    const pieces = chunkText(content);
    let n = 0;
    for (const p of pieces) {
      const vector = await this.embedder.embed(p.text);
      this.chunks.push({
        id: `${file}:${p.startLine}`,
        file,
        startLine: p.startLine,
        endLine: p.endLine,
        text: p.text,
        vector,
      });
      n++;
    }
    return n;
  }

  /** Top-k chunks most similar to the query. */
  async search(query: string, k = 4): Promise<Array<{ chunk: Chunk; score: number }>> {
    if (this.chunks.length === 0) return [];
    const qv = await this.embedder.embed(query);
    return this.chunks
      .map((chunk) => ({ chunk, score: cosine(qv, chunk.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((r) => r.score > 0);
  }

  status(): { files: number; chunks: number; embedder: string } {
    return {
      files: new Set(this.chunks.map((c) => c.file)).size,
      chunks: this.chunks.length,
      embedder: this.embedder.id,
    };
  }

  clear(): void {
    this.chunks = [];
    this.persist();
  }

  persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const data: IndexFile = { embedderId: this.embedder.id, chunks: this.chunks };
    writeFileSync(this.path, JSON.stringify(data), "utf-8");
  }

  /** Load persisted chunks if the file exists and was built with the same embedder. */
  load(): boolean {
    if (!this.path || !existsSync(this.path)) return false;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf-8")) as IndexFile;
      if (data.embedderId !== this.embedder.id) return false; // stale — different embedder
      this.chunks = Array.isArray(data.chunks) ? data.chunks : [];
      return true;
    } catch {
      return false;
    }
  }

  get size(): number {
    return this.chunks.length;
  }
}
