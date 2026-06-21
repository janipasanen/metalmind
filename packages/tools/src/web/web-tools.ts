import { z } from "zod";
import type { AgentTool } from "../types.js";
import { createTool } from "../types.js";

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "MetalMind/1.0 (+https://github.com/janipasanen/metalmind)";

/** True for a literal IPv4 in a loopback/private/link-local/CGNAT range (#256). */
function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = o;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

/** Block internal/private hosts to prevent SSRF to localhost, the LAN, or cloud
 *  metadata endpoints (#256). IPv6 checks are gated on a literal so real domains
 *  (e.g. "fcbarcelona.com") aren't affected. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80")) return true; // link-local
    const first = h.split(":")[0];
    if (/^f[cd]/.test(first)) return true; // fc00::/7 unique-local
    const mapped = h.startsWith("::ffff:") ? h.slice(7) : "";
    if (mapped && isPrivateIPv4(mapped)) return true;
    return false;
  }
  return isPrivateIPv4(h);
}

/** Validate scheme + host, throwing on a disallowed/internal target (#256). */
export function assertPublicUrl(urlStr: string): URL {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked URL scheme "${u.protocol}" — only http/https are allowed`);
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error(`Refusing to fetch a private/internal host: ${u.hostname}`);
  }
  return u;
}

/** fetch() that validates the target and re-validates every redirect hop, so a
 *  public URL can't 30x-redirect into a private/metadata host (#256). */
async function safeFetch(urlStr: string, init: RequestInit): Promise<Response> {
  let current = assertPublicUrl(urlStr).toString();
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    current = assertPublicUrl(new URL(loc, current).toString()).toString();
  }
  throw new Error("Too many redirects");
}

/** Strip HTML to readable plain text (best-effort, dependency-free). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const webFetchSchema = z.object({
  url: z.string().url(),
  maxChars: z.number().int().positive().max(200_000).default(20_000),
});

export const webFetchTool: AgentTool<z.input<typeof webFetchSchema>, string> = createTool({
  toolName: "webFetch",
  description:
    "Fetch a URL and return its readable text content (HTML is stripped to text). Use for docs, changelogs, package READMEs, and error explanations. Has a timeout and size cap.",
  inputSchema: webFetchSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof webFetchSchema>): Promise<string> {
    let res: Response;
    try {
      res = await safeFetch(input.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" },
      });
    } catch (err) {
      return `Error fetching ${input.url}: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!res.ok) return `Error: ${res.status} ${res.statusText} for ${input.url}`;

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = /html/i.test(contentType) ? htmlToText(raw) : raw.trim();
    if (!text) return "(empty response)";
    return text.length > input.maxChars
      ? `${text.slice(0, input.maxChars)}\n…(truncated; ${text.length} chars total)`
      : text;
  },
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Decode a DuckDuckGo redirect href (//duckduckgo.com/l/?uddg=<encoded>) to the real URL. */
export function decodeDuckUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** Parse DuckDuckGo HTML search results into ranked entries. */
export function parseDuckResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < max) {
    results.push({ url: decodeDuckUrl(m[1]), title: htmlToText(m[2]), snippet: "" });
  }
  // Best-effort snippet association (positional).
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let s: RegExpExecArray | null;
  let i = 0;
  while ((s = snippetRe.exec(html)) !== null && i < results.length) {
    results[i].snippet = htmlToText(s[1]);
    i++;
  }
  return results;
}

const webSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).default(5),
});

export const webSearchTool: AgentTool<z.input<typeof webSearchSchema>, string> = createTool({
  toolName: "webSearch",
  description:
    "Search the web and return ranked results (title, URL, snippet) for a query. Use to find docs, issues, and references before fetching a specific page with webFetch.",
  inputSchema: webSearchSchema,
  requiresConfirmation: false,
  async execute(input: z.output<typeof webSearchSchema>): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MetalMind/1.0)" },
      });
    } catch (err) {
      return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!res.ok) return `Error: web search returned ${res.status} ${res.statusText}`;

    const html = await res.text();
    const results = parseDuckResults(html, input.maxResults);
    if (results.length === 0) return `No results found for "${input.query}".`;

    return results
      .map((r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n");
  },
});

export const allWebTools = [webFetchTool, webSearchTool];
