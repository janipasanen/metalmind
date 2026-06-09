import { describe, it, expect } from "vitest";
import { roughTokenCount, roughTokenCountMessages } from "./token-estimate.js";

describe("roughTokenCount (#170)", () => {
  it("returns 0 for empty and a positive estimate for text", () => {
    expect(roughTokenCount("")).toBe(0);
    expect(roughTokenCount("hello world")).toBeGreaterThan(0);
  });
  it("scales with length (roughly chars/4)", () => {
    const long = "word ".repeat(100);
    expect(roughTokenCount(long)).toBeGreaterThan(roughTokenCount("word"));
  });
  it("sums across messages with overhead", () => {
    const n = roughTokenCountMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there friend" },
    ]);
    expect(n).toBeGreaterThan(0);
  });
});
