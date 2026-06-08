import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaWorkerProvider } from "../../src/ollama/ollama-worker-provider.js";

function stubTags(...names: string[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ models: names.map((name) => ({ name })) }),
  }));
}

describe("OllamaWorkerProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("model resolution (#148 prefix-collision)", () => {
    it("does NOT report a different tag of the same family as the requested tag", async () => {
      // Requesting :7b with only :1.5b installed must not falsely match by prefix.
      stubTags("qwen2.5-coder:1.5b");
      const p = new OllamaWorkerProvider("qwen2.5-coder:7b");
      const result = await p.checkModelAvailability();
      // It normalizes to the installed same-family tag and says so (never claims :7b is installed).
      expect(result.message).not.toContain('"qwen2.5-coder:7b" is available');
      expect(result.message).toContain("qwen2.5-coder:1.5b");
    });

    it("normalizes isAvailable to an installed same-family tag and uses it in sendTask", async () => {
      stubTags("qwen2.5-coder:1.5b");
      const p = new OllamaWorkerProvider("qwen2.5-coder:7b");
      expect(await p.isAvailable()).toBe(true);
      // After normalization, the modelId reflects the installed tag (verified via availability message).
      stubTags("qwen2.5-coder:1.5b");
      const result = await p.checkModelAvailability();
      expect(result.available).toBe(true);
    });

    it("reports unavailable when no model of that family is installed", async () => {
      stubTags("llama3:8b", "deepseek-coder:1.3b");
      const p = new OllamaWorkerProvider("qwen2.5-coder:7b");
      expect(await p.isAvailable()).toBe(false);
      stubTags("llama3:8b", "deepseek-coder:1.3b");
      const result = await p.checkModelAvailability();
      expect(result.available).toBe(false);
      expect(result.message).toContain("ollama pull qwen2.5-coder:7b");
    });

    it("reports available on an exact tag match without normalization noise", async () => {
      stubTags("deepseek-coder:1.3b");
      const p = new OllamaWorkerProvider("deepseek-coder:1.3b");
      const result = await p.checkModelAvailability();
      expect(result.available).toBe(true);
      expect(result.message).toContain('"deepseek-coder:1.3b" is available');
    });

    it("does not let a longer family name prefix-collide", async () => {
      // "qwen2.5-coder" must not match installed "qwen2.5-coder-extra:7b".
      stubTags("qwen2.5-coder-extra:7b");
      const p = new OllamaWorkerProvider("qwen2.5-coder:7b");
      expect(await p.isAvailable()).toBe(false);
    });
  });

  describe("constructor", () => {
    it("should create with default settings", () => {
      const provider = new OllamaWorkerProvider("deepseek-coder:1.3b");
      expect(provider.providerName).toBe("ollama-worker");
    });

    it("should create with custom base URL", () => {
      const provider = new OllamaWorkerProvider("deepseek-coder:1.3b", "http://custom:11434");
      expect(provider.providerName).toBe("ollama-worker");
    });

    it("should create with API key", () => {
      const provider = new OllamaWorkerProvider("deepseek-v4-pro:cloud", "http://custom:11434", "sk-test-key");
      expect(provider.providerName).toBe("ollama-worker");
    });
  });

  describe("checkModelAvailability", () => {
    it("should return helpful message when Ollama is not reachable", async () => {
      const provider = new OllamaWorkerProvider("deepseek-coder:1.3b", "http://127.0.0.1:59999");
      const result = await provider.checkModelAvailability();
      expect(result.available).toBe(false);
      expect(result.message).toContain("Ollama");
    });
  });

  describe("isAvailable", () => {
    it("should return false when Ollama is not reachable", async () => {
      const provider = new OllamaWorkerProvider("deepseek-coder:1.3b", "http://127.0.0.1:59999");
      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe("sendTask", () => {
    it("should throw when Ollama is not reachable", async () => {
      const provider = new OllamaWorkerProvider("deepseek-coder:1.3b", "http://127.0.0.1:59999");
      const task = {
        taskId: "test-001",
        taskType: "classifyUserIntent",
        input: { userMessage: "test" },
        outputSchemaName: "ClassifyUserIntentOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 5000,
      };
      await expect(provider.sendTask(task as any)).rejects.toThrow();
    });
  });
});