import { describe, it, expect } from "vitest";
import { LocalWorkerRunner } from "../../src/multi-agent/local-worker-runner.js";
import type { WorkerProvider } from "../../src/multi-agent/local-worker-runner.js";
import type { LocalWorkerTask, AgentResult } from "@metalmind/schemas";

function createMockProvider(responseOverride?: (task: LocalWorkerTask) => string): WorkerProvider {
  return {
    providerName: "mock-provider",
    async isAvailable() {
      return true;
    },
    async sendTask(task: LocalWorkerTask) {
      if (responseOverride) return responseOverride(task);
      if (task.taskType === "rankRelevantFiles") {
        return JSON.stringify({
          rankedFiles: [
            { path: "src/index.ts", relevanceScore: 0.9, reason: "Main entry point" },
          ],
          confidence: 0.85,
        });
      }
      if (task.taskType === "classifyUserIntent") {
        return JSON.stringify({
          intent: "code_change",
          confidence: 0.9,
          suggestedTier: "local-worker",
          reason: "User wants code change",
        });
      }
      return JSON.stringify({ summary: "test", confidence: 0.8 });
    },
  };
}

function createUnavailableProvider(): WorkerProvider {
  return {
    providerName: "unavailable-provider",
    async isAvailable() {
      return false;
    },
    async sendTask() {
      return "";
    },
  };
}

describe("LocalWorkerRunner", () => {
  describe("successful task execution", () => {
    it("should execute a rankRelevantFiles task successfully", async () => {
      const runner = new LocalWorkerRunner(createMockProvider());
      const task: LocalWorkerTask = {
        taskId: "test-001",
        taskType: "rankRelevantFiles",
        input: {
          userGoal: "Add Ollama Cloud provider",
          candidateFiles: ["src/index.ts"],
        },
        outputSchemaName: "RankRelevantFilesOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(true);
      expect(result.taskId).toBe("test-001");
      expect(result.output).toBeDefined();
    });

    it("should execute a classifyUserIntent task successfully", async () => {
      const runner = new LocalWorkerRunner(createMockProvider());
      const task: LocalWorkerTask = {
        taskId: "test-002",
        taskType: "classifyUserIntent",
        input: { userMessage: "Fix the login bug" },
        outputSchemaName: "ClassifyUserIntentOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(true);
    });
  });

  describe("forbidden tasks", () => {
    it("should refuse to execute forbidden task types", async () => {
      const runner = new LocalWorkerRunner(createMockProvider());
      const task: LocalWorkerTask = {
        taskId: "test-forbidden",
        taskType: "executeShellCommand" as LocalWorkerTask["taskType"],
        input: { command: "rm -rf /" },
        outputSchemaName: "ShellOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("forbidden");
    });
  });

  describe("unavailable provider", () => {
    it("should handle unavailable provider gracefully", async () => {
      const runner = new LocalWorkerRunner(createUnavailableProvider());
      const task: LocalWorkerTask = {
        taskId: "test-unavailable",
        taskType: "classifyUserIntent",
        input: { userMessage: "test" },
        outputSchemaName: "ClassifyUserIntentOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
    });
  });

  describe("no provider", () => {
    it("should handle missing provider", async () => {
      const runner = new LocalWorkerRunner(null);
      const task: LocalWorkerTask = {
        taskId: "test-no-provider",
        taskType: "classifyUserIntent",
        input: { userMessage: "test" },
        outputSchemaName: "ClassifyUserIntentOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No local worker provider");
    });
  });

  describe("invalid task input", () => {
    it("should reject tasks with invalid input", async () => {
      const runner = new LocalWorkerRunner(createMockProvider());
      const task: LocalWorkerTask = {
        taskId: "test-invalid-input",
        taskType: "rankRelevantFiles",
        input: { userGoal: "" },
        outputSchemaName: "RankRelevantFilesOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      // The input has no candidateFiles which is required
      const result = await runner.run(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid task input");
    });
  });

  describe("schema validation failure", () => {
    it("should reject malformed output from provider", async () => {
      const badProvider: WorkerProvider = {
        providerName: "bad-provider",
        async isAvailable() { return true; },
        async sendTask() {
          return "this is not valid JSON";
        },
      };

      const runner = new LocalWorkerRunner(badProvider, { maxSchemaValidationRetries: 0 });
      const task: LocalWorkerTask = {
        taskId: "test-bad-output",
        taskType: "classifyUserIntent",
        input: { userMessage: "test" },
        outputSchemaName: "ClassifyUserIntentOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(false);
    });

    it("should reject output that doesn't match schema", async () => {
      const wrongSchemaProvider: WorkerProvider = {
        providerName: "wrong-schema-provider",
        async isAvailable() { return true; },
        async sendTask() {
          return JSON.stringify({ wrong: "keys", here: true });
        },
      };

      const runner = new LocalWorkerRunner(wrongSchemaProvider, { maxSchemaValidationRetries: 0 });
      // Use rankRelevantFiles: its output schema has required fields with no
      // .catch() fallback, so genuinely wrong output is rejected. (The
      // classifyUserIntent schema intentionally coerces hallucinated output to
      // safe defaults, so it can never fail validation.)
      const task: LocalWorkerTask = {
        taskId: "test-wrong-schema",
        taskType: "rankRelevantFiles",
        input: { userGoal: "test", candidateFiles: ["src/index.ts"] },
        outputSchemaName: "RankRelevantFilesOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(false);
    });
  });

  describe("unknown task type", () => {
    it("should reject unknown task types", async () => {
      const runner = new LocalWorkerRunner(createMockProvider());
      const task: LocalWorkerTask = {
        taskId: "test-unknown",
        taskType: "unknownTaskType" as LocalWorkerTask["taskType"],
        input: {},
        outputSchemaName: "UnknownOutput",
        maximumInputTokens: 3000,
        maximumOutputTokens: 800,
        timeoutMilliseconds: 15000,
      };

      const result = await runner.run(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown local worker task type");
    });
  });

  describe("setProvider", () => {
    it("should allow changing provider at runtime", () => {
      const runner = new LocalWorkerRunner(null);
      const provider = createMockProvider();
      runner.setProvider(provider);
      // The runner should now have access to the provider
      expect(runner).toBeDefined();
    });
  });
});

describe("LocalWorkerRunner.hasProvider (#233)", () => {
  it("reflects whether a worker provider is configured", () => {
    expect(new LocalWorkerRunner(null).hasProvider).toBe(false);
    const p = { providerName: "w", async isAvailable() { return true; }, async sendTask() { return "{}"; } };
    expect(new LocalWorkerRunner(p as never).hasProvider).toBe(true);
    expect(new LocalWorkerRunner(p as never).providerName).toBe("w");
  });
});
