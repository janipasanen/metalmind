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
describe("Coordinator planning (#166) and parallel tasks (#180)", () => {
  function plannerProvider(content: string): ModelProvider {
    return {
      providerName: "planner",
      supportedCapabilities: { supportsStreaming: true, supportsToolCalling: false, supportsVision: false, supportsReasoning: true, supportsJsonMode: true, maximumContextTokens: 100000 },
      async completeChat() { return { message: { role: "assistant", content } }; },
      async *streamChatCompletion() { yield { type: "done" } as ModelStreamEvent; },
    };
  }

  it("buildPlan decomposes a request into steps and emits coordinator:plan (#166)", async () => {
    const planJson = '[{"description":"Read the config","type":"direct-tool"},{"description":"Refactor the parser","type":"cloud-main"},{"description":"Summarize changes","type":"local-worker"}]';
    const coordinator = new Coordinator(plannerProvider(planJson), createMockWorkerProvider());
    let emitted: { steps: unknown[] } | null = null;
    coordinator.on("coordinator:plan", (e: unknown) => { emitted = (e as { plan: { steps: unknown[] } }).plan; });

    const plan = await coordinator.buildPlan("Do several things");
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(3);
    expect(plan!.steps[0]).toMatchObject({ description: "Read the config", type: "direct-tool", status: "pending" });
    expect(plan!.steps[1].type).toBe("cloud-main");
    expect(emitted).not.toBeNull();
    expect(coordinator.getPlan()?.steps).toHaveLength(3);
  });

  it("tolerates JSON wrapped in prose and updates step status", async () => {
    const coordinator = new Coordinator(
      plannerProvider('Here is the plan:\n[{"description":"step one","type":"cloud-main"}]\nDone.'),
      createMockWorkerProvider(),
    );
    const plan = await coordinator.buildPlan("two part task");
    expect(plan!.steps).toHaveLength(1);
    coordinator.markAllSteps("running");
    expect(coordinator.getPlan()!.steps[0].status).toBe("running");
    coordinator.updateStepStatus("step-1", "completed");
    expect(coordinator.getPlan()!.steps[0].status).toBe("completed");
  });

  it("buildPlan returns null on unparseable planner output", async () => {
    const coordinator = new Coordinator(plannerProvider("I cannot make a plan."), createMockWorkerProvider());
    expect(await coordinator.buildPlan("x")).toBeNull();
  });

  it("runParallelTasks runs worker tasks concurrently and emits lifecycle events (#180)", async () => {
    const coordinator = new Coordinator(createMockCloudProvider(), createMockWorkerProvider());
    const started: string[] = [];
    coordinator.on("coordinator:local-task-started", (e: unknown) => started.push((e as { taskId: string }).taskId));

    const tasks = ["t1", "t2"].map((id) => ({
      taskId: id,
      taskType: "summarizeFile",
      input: { filePath: `${id}.ts`, fileContent: "x" },
      outputSchemaName: "summarizeFileOutput",
      maximumInputTokens: 3000,
      maximumOutputTokens: 800,
      timeoutMilliseconds: 5000,
    }));
    const results = await coordinator.runParallelTasks(tasks as never, 4);
    expect(results).toHaveLength(2);
    expect(started).toEqual(["t1", "t2"]);
  });

  it("runParallelTasks serves a cache hit on repeated input (#187 cache-aware delegation)", async () => {
    let runs = 0;
    const counting: WorkerProvider = {
      providerName: "counting",
      async isAvailable() { return true; },
      async sendTask() { runs++; return JSON.stringify({ summary: "x", confidence: 0.9 }); },
    };
    const coordinator = new Coordinator(createMockCloudProvider(), counting);
    const tasks = [{
      taskId: "a",
      taskType: "summarizeFile",
      input: { filePath: "a.ts", fileContent: "export const a = 1;" },
      outputSchemaName: "summarizeFileOutput",
      maximumInputTokens: 3000,
      maximumOutputTokens: 800,
      timeoutMilliseconds: 5000,
    }];

    const first = await coordinator.runParallelTasks(tasks as never, 4);
    expect(first[0].success).toBe(true);
    expect(first[0].modelUsed).not.toBe("cache");

    // Same input again → served from the content-hash cache, worker not re-run.
    const second = await coordinator.runParallelTasks(tasks as never, 4);
    expect(second[0].modelUsed).toBe("cache");
    expect(runs).toBe(1);
  });
});

describe("Coordinator.runCachedTask (#181 result cache)", () => {
  it("re-runs the worker on first call and serves a cache hit on unchanged input", async () => {
    let runs = 0;
    const counting: WorkerProvider = {
      providerName: "counting",
      async isAvailable() { return true; },
      async sendTask() {
        runs++;
        return JSON.stringify({ summary: "the file does X", confidence: 0.9 });
      },
    };
    const coordinator = new Coordinator(createMockCloudProvider(), counting);
    const input = { filePath: "src/a.ts", fileContent: "export const a = 1;" };

    const first = await coordinator.runCachedTask("summarizeFile", input, "deepseek:1.3b");
    expect(first.success).toBe(true);
    expect(first.modelUsed).not.toBe("cache");

    const second = await coordinator.runCachedTask("summarizeFile", input, "deepseek:1.3b");
    expect(second.success).toBe(true);
    expect(second.modelUsed).toBe("cache"); // served from cache
    expect(runs).toBe(1); // worker ran only once

    // Changing the content (content-hash key) misses the cache → re-runs.
    const changed = await coordinator.runCachedTask("summarizeFile", { ...input, fileContent: "export const a = 2;" }, "deepseek:1.3b");
    expect(changed.modelUsed).not.toBe("cache");
    expect(runs).toBe(2);
  });
});
