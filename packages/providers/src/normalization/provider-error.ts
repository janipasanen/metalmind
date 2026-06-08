/**
 * Typed provider error with HTTP status awareness, so the agent loop can
 * distinguish transient failures (retry / fall back to another tier) from
 * fatal ones (surface immediately), and honor `Retry-After`.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly provider?: string;

  constructor(
    message: string,
    opts: { status?: number; retryAfterMs?: number; provider?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.provider = opts.provider;
  }

  /** Retryable: rate limits (429), server errors (5xx), and network failures (no status). */
  get retryable(): boolean {
    if (this.status === undefined) return true; // network/connection error
    if (this.status === 429) return true;
    if (this.status >= 500 && this.status <= 599) return true;
    return false; // 400/401/403/404/... are fatal
  }
}

/** True for transient errors worth retrying — typed ProviderError or a raw network error. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (isAbortError(err)) return false; // user cancel is never retried
  // Unknown/raw errors (e.g. fetch TypeError on connection reset) → treat as transient.
  return err instanceof Error && !/\b(4\d\d)\b/.test(err.message);
}

/** True when the error represents a user-triggered AbortController cancellation. */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /\baborted\b/i.test(err.message))
  );
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(headers: Headers | undefined | null): number | undefined {
  const raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    // Date.now() is intentionally avoided in some contexts; here it's fine.
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Build a ProviderError from a non-ok Response, reading status + Retry-After + body. */
export async function providerErrorFromResponse(
  res: Response,
  provider: string,
  label: string,
): Promise<ProviderError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return new ProviderError(`${label}: ${res.status} ${body}`, {
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers),
    provider,
  });
}
