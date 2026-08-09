import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, isLocalEndpoint, connectTimeoutFor, LOCAL_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS } from "./fetch-with-timeout.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchWithTimeout (#137)", () => {
  it("returns the response when the connection succeeds in time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const res = await fetchWithTimeout("http://x", { method: "GET" }, undefined, 1000);
    expect(res.status).toBe(200);
  });

  it("aborts when the connection exceeds the timeout", async () => {
    // fetch that never resolves until its signal aborts.
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
      }),
    ));
    await expect(fetchWithTimeout("http://hang", { method: "GET" }, undefined, 50)).rejects.toThrow(/timed out/i);
  });

  it("forwards a user abort so streaming can still be cancelled", async () => {
    const user = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("user aborted")));
      }),
    ));
    const p = fetchWithTimeout("http://x", { method: "GET" }, user.signal, 5000);
    user.abort(new Error("user aborted"));
    await expect(p).rejects.toThrow(/user aborted/);
  });

  it("does not abort a fast connection even with a short timeout (timer cleared)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201 }));
    const res = await fetchWithTimeout("http://x", { method: "GET" }, undefined, 10);
    // Wait beyond the timeout to ensure no late abort fires.
    await new Promise((r) => setTimeout(r, 30));
    expect(res.status).toBe(201);
  });
});

describe("local endpoints get a load-aware connect budget", () => {
  // Ollama and the MLX sidecar send no response headers until the model is
  // LOADED, so time-to-first-byte includes loading the weights. A 12B model on
  // a machine it barely fits took minutes and was aborted at 60s, then retried
  // — queueing a second load behind the first. A local endpoint that is truly
  // down fails connect immediately, so the long budget costs nothing.
  it("recognises loopback hosts", () => {
    for (const u of [
      "http://127.0.0.1:11434/api/chat",
      "http://localhost:11434/api/chat",
      "http://127.0.0.1:8742/chat",
    ]) {
      expect(isLocalEndpoint(u)).toBe(true);
      expect(connectTimeoutFor(u)).toBe(LOCAL_CONNECT_TIMEOUT_MS);
    }
  });

  it("keeps the strict default for remote providers", () => {
    for (const u of [
      "https://api.ollama.com/api/chat",
      "https://api.anthropic.com/v1/messages",
      "https://api.openai.com/v1/chat/completions",
    ]) {
      expect(isLocalEndpoint(u)).toBe(false);
      expect(connectTimeoutFor(u)).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    }
  });

  it("gives local models minutes, not seconds", () => {
    expect(LOCAL_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("treats an unparseable url as remote (fail fast, not hang)", () => {
    expect(isLocalEndpoint("not a url")).toBe(false);
    expect(connectTimeoutFor("not a url")).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });
});
