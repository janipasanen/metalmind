import { describe, it, expect } from "vitest";
import {
  ProviderError,
  isRetryableError,
  isAbortError,
  parseRetryAfter,
  providerErrorFromResponse,
} from "./provider-error.js";

describe("ProviderError.retryable", () => {
  it("treats 429 as retryable", () => {
    expect(new ProviderError("rate limited", { status: 429 }).retryable).toBe(true);
  });

  it("treats 5xx as retryable", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(new ProviderError("server error", { status }).retryable).toBe(true);
    }
  });

  it("treats network errors (no status) as retryable", () => {
    expect(new ProviderError("connection reset").retryable).toBe(true);
  });

  it("treats 4xx client errors as fatal", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(new ProviderError("client error", { status }).retryable).toBe(false);
    }
  });
});

describe("isRetryableError", () => {
  it("delegates to ProviderError.retryable", () => {
    expect(isRetryableError(new ProviderError("x", { status: 429 }))).toBe(true);
    expect(isRetryableError(new ProviderError("x", { status: 400 }))).toBe(false);
  });

  it("never retries a user abort", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isRetryableError(abort)).toBe(false);
  });

  it("treats a raw network error as retryable but a 4xx-looking message as fatal", () => {
    expect(isRetryableError(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 401 Unauthorized"))).toBe(false);
  });
});

describe("isAbortError", () => {
  it("detects AbortError by name and message", () => {
    const byName = new Error("x");
    byName.name = "AbortError";
    expect(isAbortError(byName)).toBe(true);
    expect(isAbortError(new Error("The user aborted a request"))).toBe(true);
    expect(isAbortError(new Error("normal failure"))).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const headers = (v: string | null) =>
    ({ get: (k: string) => (k === "retry-after" ? v : null) }) as unknown as Headers;

  it("parses a seconds value into ms", () => {
    expect(parseRetryAfter(headers("2"))).toBe(2000);
  });

  it("returns undefined when absent", () => {
    expect(parseRetryAfter(headers(null))).toBeUndefined();
  });

  it("is defensive against a missing headers object", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter({} as Headers)).toBeUndefined();
  });
});

describe("providerErrorFromResponse", () => {
  it("captures status, body, and Retry-After", async () => {
    const res = {
      status: 429,
      headers: { get: (k: string) => (k === "retry-after" ? "3" : null) },
      text: async () => "Too Many Requests",
    } as unknown as Response;
    const err = await providerErrorFromResponse(res, "ollama-cloud", "Ollama stream failed");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Ollama stream failed: 429");
    expect(err.message).toContain("Too Many Requests");
  });
});
