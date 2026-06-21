import { ProviderError } from "./provider-error.js";

/** Default connection timeout (time-to-first-byte) for provider HTTP calls. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

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
