/**
 * Scrubs known secret values (API keys, bearer tokens) from text before it is
 * sent to a model, shown to the user, or logged (#168). Prevents secrets read
 * from a config file or echoed in an error from leaking into model context or
 * terminal scrollback.
 */
export class Redactor {
  private secrets: string[];

  constructor(secrets: Iterable<string | undefined | null>) {
    // Only redact non-trivial values (>= 8 chars) to avoid false positives on
    // short/empty config values; longest-first so we don't partially replace.
    this.secrets = [...new Set([...secrets].filter((s): s is string => typeof s === "string" && s.length >= 8))].sort(
      (a, b) => b.length - a.length,
    );
  }

  get count(): number {
    return this.secrets.length;
  }

  redact(text: string): string {
    if (!text || this.secrets.length === 0) return text;
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
    }
    return out;
  }
}

/** Collect candidate secret values from XDG config api keys + MCP server headers. */
export function collectSecrets(
  apiKeys: Record<string, string> | undefined,
  extra: Array<string | undefined>,
  mcpServers?: Record<string, { headers?: Record<string, string> }>,
): string[] {
  const out: string[] = [];
  for (const v of Object.values(apiKeys ?? {})) out.push(v);
  for (const v of extra) if (v) out.push(v);
  for (const srv of Object.values(mcpServers ?? {})) {
    for (const h of Object.values(srv.headers ?? {})) {
      // A header like "Bearer sk-..." — capture both the whole value and the token.
      out.push(h);
      const m = /\b(?:Bearer|Token)\s+(\S+)/i.exec(h);
      if (m) out.push(m[1]);
    }
  }
  return out;
}
