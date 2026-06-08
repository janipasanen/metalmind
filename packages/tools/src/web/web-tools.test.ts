import { describe, it, expect, vi, afterEach } from "vitest";
import { webFetchTool, webSearchTool, htmlToText, decodeDuckUrl, parseDuckResults } from "./web-tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("htmlToText", () => {
  it("strips tags and scripts and decodes entities", () => {
    const out = htmlToText(
      `<html><head><style>x{}</style><script>bad()</script></head><body><h1>Title</h1><p>a &amp; b</p></body></html>`,
    );
    // Real markup is gone (no <h1>/<p>/<script> tags remain).
    expect(out).not.toMatch(/<\/?(h1|p|script|style|body|html)\b/i);
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("x{}");
    expect(out).toContain("Title");
    expect(out).toContain("a & b");
  });
});

describe("decodeDuckUrl", () => {
  it("decodes a uddg redirect", () => {
    expect(decodeDuckUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=x")).toBe(
      "https://example.com/docs",
    );
  });
  it("prefixes protocol-relative urls", () => {
    expect(decodeDuckUrl("//example.com/x")).toBe("https://example.com/x");
  });
});

describe("parseDuckResults", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com">First Result</a>
      <a class="result__snippet">Snippet one</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com">Second Result</a>
      <a class="result__snippet">Snippet two</a>
    </div>`;

  it("extracts ranked title/url/snippet up to the cap", () => {
    const results = parseDuckResults(html, 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: "First Result", url: "https://a.com", snippet: "Snippet one" });
    expect(results[1].url).toBe("https://b.com");
  });

  it("respects maxResults", () => {
    expect(parseDuckResults(html, 1)).toHaveLength(1);
  });
});

describe("webFetchTool", () => {
  it("returns readable text for an HTML page within the cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (k: string) => (k === "content-type" ? "text/html" : null) },
      text: async () => "<p>Hello <b>world</b></p>",
    }));
    const out = await webFetchTool.execute({ url: "https://example.com", maxChars: 1000 }, { projectRoot: "/" } as never);
    expect(out).toContain("Hello world");
  });

  it("returns a clear error on a non-2xx response (no crash)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      text: async () => "",
    }));
    const out = await webFetchTool.execute({ url: "https://example.com/missing", maxChars: 1000 }, { projectRoot: "/" } as never);
    expect(out).toMatch(/^Error: 404/);
  });

  it("returns a clear error on a network failure (no crash)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const out = await webFetchTool.execute({ url: "https://example.com", maxChars: 1000 }, { projectRoot: "/" } as never);
    expect(out).toMatch(/Error fetching/);
  });
});

describe("webSearchTool", () => {
  it("returns ranked results from the search backend", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com">Docs</a>`,
    }));
    const out = await webSearchTool.execute({ query: "metalmind", maxResults: 5 }, { projectRoot: "/" } as never);
    expect(out).toContain("1. Docs");
    expect(out).toContain("https://docs.example.com");
  });

  it("handles no results gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html>nothing</html>",
    }));
    const out = await webSearchTool.execute({ query: "zzz", maxResults: 5 }, { projectRoot: "/" } as never);
    expect(out).toMatch(/No results/);
  });
});
