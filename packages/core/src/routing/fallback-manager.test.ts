import { describe, it, expect } from "vitest";
import { FallbackManager } from "./index.js";

describe("FallbackManager", () => {
  it("returns next provider in chain", () => {
    const fm = new FallbackManager();
    expect(fm.nextProvider("ollama")).toBe("openai");
    expect(fm.nextProvider("openai")).toBe("anthropic");
  });

  it("returns null for last provider", () => {
    const fm = new FallbackManager();
    expect(fm.nextProvider("anthropic")).toBeNull();
  });

  it("tracks failures and signals fallback", () => {
    const fm = new FallbackManager(["a", "b", "c"], 2);
    const r1 = fm.recordFailure("task1", "a");
    expect(r1.shouldFallback).toBe(true);
    expect(r1.nextProvider).toBe("b");
  });

  it("stops after max attempts", () => {
    const fm = new FallbackManager(["a", "b", "c"], 2);
    fm.recordFailure("task1", "a");
    const r2 = fm.recordFailure("task1", "b");
    expect(r2.shouldFallback).toBe(false);
    expect(r2.nextProvider).toBeNull();
  });

  it("resets task tracking", () => {
    const fm = new FallbackManager(["a", "b", "c"], 2);
    fm.recordFailure("task1", "a");
    fm.reset("task1");
    const r = fm.recordFailure("task1", "a");
    expect(r.shouldFallback).toBe(true);
  });
});
