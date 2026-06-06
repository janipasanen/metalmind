import { describe, it, expect } from "vitest";
import { OllamaWorkerProvider } from "../../src/ollama/ollama-worker-provider.js";

describe("OllamaWorkerProvider", () => {
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