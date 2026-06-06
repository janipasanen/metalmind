import { describe, it, expect, vi, afterEach } from "vitest";
import { createProvider, DEFAULT_MLX_BASE_URL, DEFAULT_OLLAMA_CLOUD_URL } from "../src/provider-factory.js";
import { OllamaProvider } from "../src/ollama/ollama-provider.js";
import { MlxProvider } from "../src/mlx/mlx-provider.js";

describe("createProvider", () => {
  it("creates an OllamaProvider", () => {
    const p = createProvider("ollama", "deepseek-coder:1.3b");
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerName).toBe("ollama");
  });

  it("creates an OllamaProvider for ollama-cloud with default URL and apiKey", () => {
    const p = createProvider("ollama-cloud", "deepseek-v4-pro:cloud", { apiKey: "sk-test-key" });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerName).toBe("ollama");
  });

  it("creates an OllamaProvider for ollama-cloud with custom baseUrl", () => {
    const p = createProvider("ollama-cloud", "gemini-3-flash-preview:cloud", {
      apiKey: "sk-test-key",
      baseUrl: "https://custom-ollama.example.com",
    });
    expect(p).toBeInstanceOf(OllamaProvider);
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

  it("exposes the default Ollama Cloud base URL", () => {
    expect(DEFAULT_OLLAMA_CLOUD_URL).toBe("https://api.ollama.com");
  });
});

describe("createProvider baseUrl forwarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureFetchUrl(responseBody: unknown): { url: () => string } {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => responseBody,
        };
      }),
    );
    return { url: () => capturedUrl };
  }

  it("forwards a custom baseUrl to the OpenAI provider", async () => {
    const cap = captureFetchUrl({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    const p = createProvider("openai", "gpt-4", {
      apiKey: "sk-test",
      baseUrl: "https://gateway.example.com/v1",
    });
    await p.completeChat({ messages: [{ role: "user", content: "hi" }] });
    expect(cap.url()).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("forwards a custom baseUrl to the Anthropic provider", async () => {
    const cap = captureFetchUrl({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    const p = createProvider("anthropic", "claude-sonnet", {
      apiKey: "sk-test",
      baseUrl: "https://proxy.example.com",
    });
    await p.completeChat({ messages: [{ role: "user", content: "hi" }] });
    expect(cap.url()).toBe("https://proxy.example.com/v1/messages");
  });

  it("OpenAI provider falls back to the default base URL when none is given", async () => {
    const cap = captureFetchUrl({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    const p = createProvider("openai", "gpt-4", { apiKey: "sk-test" });
    await p.completeChat({ messages: [{ role: "user", content: "hi" }] });
    expect(cap.url()).toBe("https://api.openai.com/v1/chat/completions");
  });
});
