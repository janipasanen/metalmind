import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HashingEmbedder, OllamaEmbedder, tokenize, l2normalize, cosine } from "../rag/embedder.js";
import { RagIndex, chunkText } from "../rag/rag-index.js";
import { handleRagCommand, retrieveContext, loadRagIndex } from "../rag/manager.js";

describe("embedder (#179)", () => {
  it("tokenizes, dropping stopwords and short tokens", () => {
    expect(tokenize("The login token is valid")).toEqual(["login", "token", "valid"]);
  });

  it("HashingEmbedder is deterministic and L2-normalized", async () => {
    const e = new HashingEmbedder(64);
    const a = await e.embed("authentication login");
    const b = await e.embed("authentication login");
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("cosine of identical normalized vectors is ~1, orthogonal is ~0", () => {
    expect(cosine(l2normalize([1, 0, 0]), l2normalize([1, 0, 0]))).toBeCloseTo(1, 5);
    expect(cosine(l2normalize([1, 0, 0]), l2normalize([0, 1, 0]))).toBeCloseTo(0, 5);
  });
});

describe("chunkText + RagIndex (#179)", () => {
  it("splits into overlapping line-based chunks", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    // overlap: second chunk starts before the first ends
    expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
  });

  it("retrieves the topically-relevant document", async () => {
    const index = new RagIndex(new HashingEmbedder());
    await index.addFile("auth.md", "authentication login password jwt token session cookie oauth");
    await index.addFile("render.md", "rendering canvas pixels graphics shader viewport raster");
    const hits = await index.search("how does the login session token work", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.file).toBe("auth.md");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("persists and reloads with a matching embedder, and rejects a stale one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-rag-"));
    try {
      const path = join(dir, "idx.json");
      const idx = new RagIndex(new HashingEmbedder(), path);
      await idx.addFile("a.txt", "alpha beta gamma delta epsilon zeta");
      idx.persist();

      const reload = new RagIndex(new HashingEmbedder(), path);
      expect(reload.load()).toBe(true);
      expect(reload.size).toBe(idx.size);

      const stale = new RagIndex(new OllamaEmbedder("nomic-embed-text"), path);
      expect(stale.load()).toBe(false); // different embedder id
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/rag command + auto-retrieval (#200)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mm-ragcmd-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "auth.md"), "# Auth\nLogin uses a JWT token stored in a session cookie.");
    writeFileSync(join(root, "docs", "ui.md"), "# UI\nThe canvas renders pixels via a shader pipeline.");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("adds a directory, reports status, and auto-retrieves relevant context", async () => {
    const added = await handleRagCommand("add docs", root);
    expect(added).toContain("Indexed");

    const status = await handleRagCommand("status", root);
    expect(status).toContain("2 file(s)");

    const search = await handleRagCommand("search jwt token login", root);
    expect(search).toContain("auth.md");

    const ctx = await retrieveContext(root, "explain the jwt login flow", 2);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("auth.md");
    expect(ctx).toContain("JWT token");
  });

  it("clears the index", async () => {
    await handleRagCommand("add docs", root);
    expect(await handleRagCommand("clear", root)).toContain("cleared");
    expect(loadRagIndex(root)).toBeNull();
    expect(await retrieveContext(root, "anything")).toBeNull();
  });
});
