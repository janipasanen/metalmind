import { ProviderError } from "./provider-error.js";

/** Default connection timeout (time-to-first-byte) for provider HTTP calls. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

/** Connection timeout for a LOCAL model server.
 *
 *  Ollama and the MLX sidecar do not send response headers until the model is
 *  loaded and generation has started, so "time to first byte" includes loading
 *  the weights. A 12B model on a machine it barely fits can take minutes —
 *  which the 60s default aborted, then retried, queueing a second load behind
 *  the first and making it worse. A local endpoint is not a network hazard: if
 *  it is genuinely unreachable, connect fails immediately rather than hanging,
 *  so a generous budget costs nothing. */
export const LOCAL_CONNECT_TIMEOUT_MS = 15 * 60_000;

/** True for a loopback / on-machine endpoint. */
export function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Connect timeout appropriate for `url`: generous locally, strict remotely. */
export function connectTimeoutFor(url: string): number {
  return isLocalEndpoint(url) ? LOCAL_CONNECT_TIMEOUT_MS : DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * fetch() with a CONNECTION timeout: aborts if headers don't arrive within
 * `timeoutMs`, so an unreachable/hung provider fails fast instead of blocking
 * forever (#137). The timer is cleared once the response is received, so a
 * long streaming body is NOT subject to a hard total cap. The caller's
 * `userSignal` is composed in, so Esc-to-interrupt still cancels an in-flight
 * stream after the connection is established.
 *
 * The two signals are combined with AbortSignal.any rather than a manual
 * "abort" listener on userSignal: a manual listener would outlive each request
 * and accumulate on the long-lived per-turn userSignal across the ~10+ fetches
 * a turn makes (#245). The composite is held weakly by its sources, so it is
 * collected with the request and leaves nothing attached to userSignal.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  userSignal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ProviderError(`Connection timed out after ${timeoutMs}ms: ${url}`)),
    timeoutMs,
  );

  // controller fires the connect timeout (cleared after connect); userSignal
  // stays live for the whole stream so Esc still cancels it mid-body.
  const signal = userSignal ? AbortSignal.any([controller.signal, userSignal]) : controller.signal;

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    // Connection established (or failed) — stop the connect timer.
    clearTimeout(timer);
  }
}
