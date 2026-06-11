import { describe, it, expect } from "vitest";
import { mergeModels } from "../model-discovery.js";

describe("mergeModels (#214)", () => {
  it("puts live models first and de-duplicates against the static list", () => {
    expect(mergeModels(["gpt-4o", "o1-mini"], ["gpt-4o", "gpt-3.5-turbo"])).toEqual([
      "gpt-4o",
      "o1-mini",
      "gpt-3.5-turbo",
    ]);
  });

  it("falls back to the static list when discovery returns nothing", () => {
    expect(mergeModels([], ["gpt-4o"])).toEqual(["gpt-4o"]);
  });
});
