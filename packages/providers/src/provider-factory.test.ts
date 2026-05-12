import { describe, it, expect } from "vitest";
import { createProvider } from "../src/provider-factory.js";
import { OllamaProvider } from "../src/ollama/ollama-provider.js";

describe("createProvider", () => {
  it("creates an OllamaProvider", () => {
    const p = createProvider("ollama", "deepseek-coder:1.3b");
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerName).toBe("ollama");
  });

  it("throws for unknown provider", () => {
    expect(() => createProvider("unknown", "model")).toThrow(/Unknown provider/);
  });

  it("throws for openai without apiKey", () => {
    expect(() => createProvider("openai", "gpt-4")).toThrow(/apiKey/);
  });

  it("creates openai provider with apiKey", () => {
    const p = createProvider("openai", "gpt-4", { apiKey: "sk-test" });
    expect(p.providerName).toBe("openai");
  });

  it("throws for anthropic without apiKey", () => {
    expect(() => createProvider("anthropic", "claude")).toThrow(/apiKey/);
  });
});
