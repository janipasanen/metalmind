/**
 * Embedders for retrieval (#179). The default HashingEmbedder is deterministic
 * and dependency-free (works offline, makes tests reproducible); OllamaEmbedder
 * uses a real embedding model when one is available locally.
 */

export interface Embedder {
  /** Stable id so an index knows which embedder produced its vectors. */
  readonly id: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on", "with", "as", "at", "by"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function l2normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized, so dot product is cosine similarity
}

/** Deterministic bag-of-words hashing embedder — no model required. */
export class HashingEmbedder implements Embedder {
  readonly id = "hash-v1";
  readonly dim: number;
  constructor(dim = 512) {
    this.dim = dim;
  }
  async embed(text: string): Promise<number[]> {
    const v = new Array(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      v[djb2(tok) % this.dim] += 1;
    }
    return l2normalize(v);
  }
}

/** Real embeddings via a local Ollama embedding model (e.g. nomic-embed-text). */
export class OllamaEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  private model: string;
  private baseUrl: string;
  constructor(model = "nomic-embed-text", dim = 768, baseUrl = "http://127.0.0.1:11434") {
    this.model = model;
    this.dim = dim;
    this.baseUrl = baseUrl;
    // Include the host so switching the Ollama endpoint invalidates a stale index (#232).
    let host = baseUrl;
    try {
      host = new URL(baseUrl).host;
    } catch {
      /* keep raw */
    }
    this.id = `ollama:${model}@${host}`;
  }
  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`embeddings failed (${res.status})`);
    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) throw new Error("no embedding in response");
    return l2normalize(data.embedding);
  }
}

/** Pick the best available embedder: Ollama embedding model if reachable, else hashing. */
export async function selectEmbedder(baseUrl = "http://127.0.0.1:11434", model = "nomic-embed-text"): Promise<Embedder> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      if ((data.models ?? []).some((m) => m.name.startsWith(model))) {
        return new OllamaEmbedder(model, 768, baseUrl);
      }
    }
  } catch {
    // fall through to the offline hashing embedder
  }
  return new HashingEmbedder();
}
