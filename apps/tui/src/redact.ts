/**
 * Scrubs known secret values (API keys, bearer tokens) from text before it is
 * sent to a model, shown to the user, or logged (#168). Prevents secrets read
 * from a config file or echoed in an error from leaking into model context or
 * terminal scrollback.
 */
export class Redactor {
  private secrets: string[];
  private maxLen: number;

  constructor(secrets: Iterable<string | undefined | null>) {
    // Only redact non-trivial values (>= 8 chars) to avoid false positives on
    // short/empty config values; longest-first so we don't partially replace.
    this.secrets = [...new Set([...secrets].filter((s): s is string => typeof s === "string" && s.length >= 8))].sort(
      (a, b) => b.length - a.length,
    );
    this.maxLen = this.secrets.reduce((m, s) => Math.max(m, s.length), 0);
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

  /**
   * Streaming-safe redaction. Given the accumulated un-emitted buffer, returns
   * the prefix that is safe to emit now (redacted) and the tail to keep. The tail
   * is the longest suffix of the buffer that is also a *prefix* of some secret —
   * it might be the first fragment of a secret that completes in a later chunk,
   * so it must be withheld until the secret can be matched whole (#168 stream fix).
   */
  redactStreamChunk(buffer: string): { emit: string; keep: string } {
    if (this.secrets.length === 0 || buffer.length === 0) return { emit: buffer, keep: "" };
    let hold = 0;
    const maxSuffix = Math.min(this.maxLen - 1, buffer.length);
    for (let k = maxSuffix; k >= 1; k--) {
      const suffix = buffer.slice(buffer.length - k);
      if (this.secrets.some((s) => s.length > k && s.startsWith(suffix))) {
        hold = k;
        break;
      }
    }
    const cut = buffer.length - hold;
    return { emit: this.redact(buffer.slice(0, cut)), keep: buffer.slice(cut) };
  }
}

/**
 * Stateful wrapper around a Redactor for streamed text: push each chunk, emit the
 * safe (fully-redacted) portion, and flush the held tail when the stream ends.
 * Guarantees a secret split across chunk boundaries is still scrubbed (#168).
 */
export class StreamRedactor {
  private buffer = "";
  constructor(private readonly redactor: Redactor) {}

  push(chunk: string): string {
    this.buffer += chunk;
    const { emit, keep } = this.redactor.redactStreamChunk(this.buffer);
    this.buffer = keep;
    return emit;
  }

  flush(): string {
    const out = this.redactor.redact(this.buffer);
    this.buffer = "";
    return out;
  }
}

/** Values in an MCP server's env/args that look like credentials (#397).
 *  Header tokens were scrubbed but these were not, so a stdio server configured
 *  with `env: { GITHUB_TOKEN: "ghp_…" }` leaked its token to the cloud model the
 *  moment it appeared in tool output or an error, while the api key sitting next
 *  to it in the same file was masked. */
const CREDENTIAL_KEY = /(token|key|secret|password|passwd|credential|auth|bearer|api[_-]?key)/i;
/** A bare argv value that looks like a credential even without a telling name. */
const SECRETISH_VALUE = /^(?:sk-|ghp_|gho_|github_pat_|xox[abposr]-|AKIA|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.)/;

/** Collect candidate secret values from XDG config api keys, MCP server
 *  headers/env/args, and stored OAuth tokens. */
export function collectSecrets(
  apiKeys: Record<string, string> | undefined,
  extra: Array<string | undefined>,
  mcpServers?: Record<
    string,
    { headers?: Record<string, string>; env?: Record<string, string>; args?: string[] }
  >,
  mcpTokens?: Record<string, { accessToken?: string; refreshToken?: string }>,
): string[] {
  const out: string[] = [];
  const pushToken = (v: string | undefined) => {
    if (!v) return;
    out.push(v);
    // "Bearer sk-…" / "Token abc" — capture the bare token too.
    const m = /\b(?:Bearer|Token)\s+(\S+)/i.exec(v);
    if (m) out.push(m[1]);
  };

  for (const v of Object.values(apiKeys ?? {})) out.push(v);
  for (const v of extra) if (v) out.push(v);
  for (const srv of Object.values(mcpServers ?? {})) {
    for (const h of Object.values(srv.headers ?? {})) pushToken(h);
    // env values whose NAME looks credential-ish (#397).
    for (const [name, value] of Object.entries(srv.env ?? {})) {
      if (CREDENTIAL_KEY.test(name)) pushToken(value);
    }
    // argv: either `--token=<v>` / `--token <v>`, or a value that looks like a
    // well-known credential format on its own.
    const args = srv.args ?? [];
    args.forEach((arg, i) => {
      const eq = /^--?([A-Za-z0-9_-]+)=(.+)$/.exec(arg);
      if (eq && CREDENTIAL_KEY.test(eq[1])) pushToken(eq[2]);
      else if (/^--?[A-Za-z0-9_-]+$/.test(arg) && CREDENTIAL_KEY.test(arg) && args[i + 1]) pushToken(args[i + 1]);
      else if (SECRETISH_VALUE.test(arg)) pushToken(arg);
    });
  }
  // OAuth access/refresh tokens obtained via /mcp auth (#397).
  for (const t of Object.values(mcpTokens ?? {})) {
    pushToken(t?.accessToken);
    pushToken(t?.refreshToken);
  }
  return out;
}
