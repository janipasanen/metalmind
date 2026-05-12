import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("returns defaults for empty input", () => {
    const cfg = loadConfig(null);
    expect(cfg.models).toEqual({});
  });

  it("returns defaults for invalid input", () => {
    const cfg = loadConfig({ models: "not-an-object" });
    expect(cfg.models).toEqual({});
  });

  it("parses valid config", () => {
    const cfg = loadConfig({
      models: { local: { provider: "ollama", model: "test" } },
    });
    expect(cfg.models.local?.provider).toBe("ollama");
  });
});
