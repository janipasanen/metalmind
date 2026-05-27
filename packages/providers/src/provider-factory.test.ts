import { describe, it, expect } from "vitest";
import { createProvider, DEFAULT_MLX_BASE_URL } from "../src/provider-factory.js";
import { OllamaProvider } from "../src/ollama/ollama-provider.js";
import { MlxProvider } from "../src/mlx/mlx-provider.js";

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

  it("creates an MlxProvider with default sidecar base URL", () => {
    const p = createProvider("mlx", "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit");
    expect(p).toBeInstanceOf(MlxProvider);
    expect(p.providerName).toBe("mlx");
  });

  it("creates an MlxProvider with a custom base URL", () => {
    const p = createProvider("mlx", "some-model", { baseUrl: "http://127.0.0.1:9000" });
    expect(p).toBeInstanceOf(MlxProvider);
  });

  it("does not require an apiKey for mlx", () => {
    expect(() => createProvider("mlx", "some-model")).not.toThrow();
  });

  it("exposes the default MLX sidecar base URL", () => {
    expect(DEFAULT_MLX_BASE_URL).toBe("http://127.0.0.1:8742");
  });
});
