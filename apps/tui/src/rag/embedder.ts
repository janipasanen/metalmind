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
  /** Embed many texts in one round-trip where the backend supports it (#349). */
  embedBatch?(texts: string[]): Promise<number[][]>;
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
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
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
  /** Keep the embedding model loaded between calls: without this, ollama
   *  unloads it after its default idle window and a large indexing run pays the
   *  model reload over and over (#349). */
  private keepAlive = "10m";
  /** Newer ollama exposes a true batch endpoint (/api/embed with input[]);
   *  flip to the legacy per-text endpoint the first time it's missing. */
  private batchOk = true;

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    return v;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.batchOk) {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts, keep_alive: this.keepAlive }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { embeddings?: number[][] };
        if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
          return data.embeddings.map(l2normalize);
        }
        this.batchOk = false; // unexpected shape — use the legacy endpoint from now on
      } else if (res.status === 404 || res.status === 405) {
        this.batchOk = false; // older ollama without /api/embed
      } else {
        throw new Error(`embeddings failed (${res.status})`);
      }
    }
    const out: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text, keep_alive: this.keepAlive }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding)) throw new Error("no embedding in response");
      out.push(l2normalize(data.embedding));
    }
    return out;
  }
}

/** Pick the best available embedder: Ollama embedding model if reachable, else hashing. */
export async function selectEmbedder(baseUrl = "http://127.0.0.1:11434", model = "nomic-embed-text"): Promise<Embedder> {
  // Explicit override: force offline hashing (deterministic, no probe) or force
  // the ollama embedder, so behaviour doesn't silently depend on whether a local
  // ollama happens to be running (also keeps RAG tests hermetic).
  const forced = (process.env.METALMIND_EMBEDDER ?? "").toLowerCase();
  if (forced === "hashing" || forced === "hash" || forced === "offline") return new HashingEmbedder();
  if (forced === "ollama") return new OllamaEmbedder(model, 768, baseUrl);
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
