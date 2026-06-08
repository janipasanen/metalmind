import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "./fetch-with-timeout.js";

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
