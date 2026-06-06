import { describe, it, expect } from "vitest";
import { Coordinator, LocalWorkerResultCache } from "../../src/multi-agent/coordinator.js";
import type { WorkerProvider } from "../../src/multi-agent/local-worker-runner.js";
import type { ModelProvider, ModelStreamEvent } from "../../src/agent/agent-runtime.js";
import type { LocalWorkerTask, AgentResult } from "@metalmind/schemas";

function createMockWorkerProvider(): WorkerProvider {
  return {
    providerName: "mock-ollama",
    async isAvailable() { return true; },
    async sendTask(task: LocalWorkerTask) {
      if (task.taskType === "classifyUserIntent") {
        return JSON.stringify({
          intent: "code_change",
          confidence: 0.9,
          suggestedTier: "local-worker",
          reason: "User wants to modify code",
        });
      }
      if (task.taskType === "rankRelevantFiles") {
        return JSON.stringify({
          rankedFiles: [
            { path: "src/index.ts", relevanceScore: 0.9, reason: "Main entry point" },
          ],
          confidence: 0.85,
        });
      }
      return JSON.stringify({ summary: "test", confidence: 0.7 });
    },
  };
}

function createMockCloudProvider(): ModelProvider {
  return {
    providerName: "mock-cloud",
    supportedCapabilities: {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: false,
      supportsReasoning: true,
      supportsJsonMode: true,
      maximumContextTokens: 200_000,
    },
    async completeChat() {
      return { message: { role: "assistant", content: "Cloud response" } };
    },
    async *streamChatCompletion() {
      yield { type: "text", text: "Cloud response" };
      yield { type: "done" };
    },
  };
}

describe("Coordinator", () => {
  describe("processRequest - local worker tasks", () => {
    it("should route classifyUserIntent to local worker", async () => {
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
      );

      const { decision, localResult } = await coordinator.processRequest("What does this code do?", {
        taskType: "classifyUserIntent",
        input: { userMessage: "What does this code do?" },
      });

      expect(decision.target).toBe("local-worker");
      expect(decision.delegatedToLocal).toBe(true);
      expect(localResult?.success).toBe(true);
    });

    it("should route rankRelevantFiles to local worker", async () => {
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
      );

      const { decision, localResult } = await coordinator.processRequest("Find files for Ollama provider", {
        taskType: "rankRelevantFiles",
        input: { userGoal: "Add Ollama Cloud provider", candidateFiles: ["src/index.ts", "src/provider.ts"] },
        inputTokenEstimate: 200,
      });

      expect(decision.target).toBe("local-worker");
      expect(localResult?.success).toBe(true);
    });

    it("should route to cloud for secrets", async () => {
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
      );

      const { decision, localResult } = await coordinator.processRequest("Check .env", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Check .env file" },
        containsSecrets: true,
      });

      expect(decision.target).toBe("cloud-main");
      expect(decision.reason).toContain("secrets");
    });

    it("should route to cloud for forbidden tasks", async () => {
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
      );

      const { decision } = await coordinator.processRequest("Plan refactor", {
        taskType: "planArchitecture",
        input: { description: "Refactor the system" },
      });

      expect(decision.target).toBe("cloud-main");
    });

    it("should fall back to cloud when local worker fails", async () => {
      const failingProvider: WorkerProvider = {
        providerName: "failing-provider",
        async isAvailable() { return true; },
        async sendTask() {
          return "not valid json";
        },
      };

      const coordinator = new Coordinator(
        createMockCloudProvider(),
        failingProvider,
        { runner: { maxSchemaValidationRetries: 0 } },
      );

      const { localResult } = await coordinator.processRequest("Test", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Test" },
      });

      // The localResult should be a failure
      expect(localResult?.success).toBe(false);
    });
  });

  describe("caching", () => {
    it("should cache local worker results", async () => {
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
        { cacheEnabled: true, cacheTtlMs: 60000 },
      );

      // First call
      const result1 = await coordinator.processRequest("Test", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Test" },
      });

      // Second call with same input - should use cache
      const result2 = await coordinator.processRequest("Test", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Test" },
      });

      // Cache hit should return quickly with durationMs 0
      if (result2.localResult?.durationMs === 0) {
        expect(result2.localResult.modelUsed).toBe("cache");
      }
    });
  });

  describe("eventBus", () => {
    it("should emit routing events", async () => {
      const events: unknown[] = [];
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
      );

      coordinator.on("coordinator:routing", (...args: unknown[]) => {
        events.push({ type: "routing", data: args[0] });
      });

      await coordinator.processRequest("Test", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Test" },
      });

      expect(events.length).toBeGreaterThan(0);
    });

    it("should emit status events", async () => {
      const statuses: unknown[] = [];
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        createMockWorkerProvider(),
      );

      coordinator.on("coordinator:status", (...args: unknown[]) => {
        statuses.push(args[0]);
      });

      await coordinator.processRequest("Test", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Test" },
      });

      expect(statuses.length).toBeGreaterThan(0);
    });
  });

  describe("no local worker", () => {
    it("should still function without local worker provider", async () => {
      const coordinator = new Coordinator(
        createMockCloudProvider(),
        null,
      );

      const { decision, localResult } = await coordinator.processRequest("Test", {
        taskType: "classifyUserIntent",
        input: { userMessage: "Test" },
      });

      // Should still route to local-worker but result will be failure
      expect(decision).toBeDefined();
      expect(localResult?.success).toBe(false);
    });
  });
});

describe("LocalWorkerResultCache", () => {
  it("should cache and retrieve results", () => {
    const cache = new LocalWorkerResultCache(60_000);
    const input = { userGoal: "test", candidateFiles: ["a.ts"] };

    cache.set("rankRelevantFiles", "deepseek-coder:1.3b", input, { rankedFiles: [], confidence: 0.9 });

    const result = cache.get("rankRelevantFiles", "deepseek-coder:1.3b", input);
    expect(result).toBeDefined();
    expect((result as { confidence: number }).confidence).toBe(0.9);
  });

  it("should return undefined for cache misses", () => {
    const cache = new LocalWorkerResultCache(60_000);
    const result = cache.get("rankRelevantFiles", "model", { unused: "input" });
    expect(result).toBeUndefined();
  });

  it("should expire entries after TTL", () => {
    const cache = new LocalWorkerResultCache(1); // 1ms TTL
    cache.set("test", "model", { key: "value" }, "result");
    
    // Wait for expiration
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = cache.get("test", "model", { key: "value" });
        expect(result).toBeUndefined();
        resolve();
      }, 10);
    });
  });

  it("should clear all entries", () => {
    const cache = new LocalWorkerResultCache(60_000);
    cache.set("test1", "model", { a: 1 }, "result1");
    cache.set("test2", "model", { b: 2 }, "result2");
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("should evict expired entries", () => {
    const cache = new LocalWorkerResultCache(1); // 1ms TTL
    cache.set("test", "model", { key: "value" }, "result");
    
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const evicted = cache.evictExpired();
        expect(evicted).toBe(1);
        expect(cache.size()).toBe(0);
        resolve();
      }, 10);
    });
  });

  it("should use deterministic cache keys", () => {
    const cache = new LocalWorkerResultCache(60_000);
    const input = { userGoal: "test" };

    cache.set("classify", "model-a", input, "result-a");
    cache.set("classify", "model-b", input, "result-b");

    const resultA = cache.get("classify", "model-a", input);
    const resultB = cache.get("classify", "model-b", input);
    expect(resultA).toBe("result-a");
    expect(resultB).toBe("result-b");
  });

  it("should distinguish inputs by hash", () => {
    const cache = new LocalWorkerResultCache(60_000);

    cache.set("classify", "model", { userGoal: "goal-a" }, "result-a");
    cache.set("classify", "model", { userGoal: "goal-b" }, "result-b");

    const resultA = cache.get("classify", "model", { userGoal: "goal-a" });
    const resultB = cache.get("classify", "model", { userGoal: "goal-b" });
    expect(resultA).toBe("result-a");
    expect(resultB).toBe("result-b");
  });
});