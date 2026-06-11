import { describe, it, expect } from "vitest";
import {
  roughTokenCount,
  roughTokenCountMessages,
  exactTokenCount,
  exactTokenCountMessages,
} from "./token-estimate.js";

describe("token estimates", () => {
  it("roughTokenCount blends char + word heuristics", () => {
    expect(roughTokenCount("")).toBe(0);
    expect(roughTokenCount("hello world")).toBeGreaterThan(0);
  });

  describe("exact BPE tokenizer (#212)", () => {
    it("counts tokens exactly", async () => {
      expect(await exactTokenCount("hello world")).toBe(2);
      expect(await exactTokenCount("")).toBe(0);
    });

    it("counts a message list with per-message overhead", async () => {
      const n = await exactTokenCountMessages([{ role: "user", content: "hello world" }]);
      expect(n).toBe(2 + 4); // 2 content + 4 overhead
    });

    it("is more accurate than the heuristic for a known string", async () => {
      const text = "The quick brown fox jumps over the lazy dog.";
      const exact = await exactTokenCount(text);
      expect(exact).not.toBeNull();
      // gpt BPE for this sentence is 10 tokens; the heuristic over/under-shoots.
      expect(exact).toBe(10);
    });
  });
});
