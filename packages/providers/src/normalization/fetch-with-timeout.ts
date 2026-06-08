import { ProviderError } from "./provider-error.js";

/** Default connection timeout (time-to-first-byte) for provider HTTP calls. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

/**
 * fetch() with a CONNECTION timeout: aborts if headers don't arrive within
 * `timeoutMs`, so an unreachable/hung provider fails fast instead of blocking
 * forever (#137). The timer is cleared once the response is received, so a
 * long streaming body is NOT subject to a hard total cap. The caller's
 * `userSignal` is forwarded to the underlying request, so Esc-to-interrupt
 * still cancels an in-flight stream after the connection is established.
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

  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort(userSignal.reason);
    } else {
      userSignal.addEventListener("abort", () => controller.abort(userSignal.reason), { once: true });
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    // Connection established (or failed) — stop the connect timer. The
    // controller stays linked to userSignal so streaming can still be aborted.
    clearTimeout(timer);
  }
}
