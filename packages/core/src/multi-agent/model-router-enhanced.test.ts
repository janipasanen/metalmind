import { describe, it, expect } from "vitest";
import { MultiAgentRouter } from "../../src/multi-agent/model-router-enhanced.js";

describe("MultiAgentRouter", () => {
  const router = new MultiAgentRouter({
    localWorkerModel: "deepseek-coder:1.3b",
    localWorkerProvider: "ollama",
    cloudMainModel: "claude-sonnet-latest",
    cloudMainProvider: "anthropic",
  });

  describe("classifyUserIntent", () => {
    it("should route to local worker", () => {
      const decision = router.route({
        taskType: "classifyUserIntent",
        input: { userMessage: "What does this file do?" },
      });
      expect(decision.target).toBe("local-worker");
      expect(decision.delegatedToLocal).toBe(true);
    });
  });

  describe("rankRelevantFiles", () => {
    it("should route to local worker for small candidate lists", () => {
      const decision = router.route({
        taskType: "rankRelevantFiles",
        input: { userGoal: "Add provider", candidateFiles: ["a.ts", "b.ts", "c.ts"] },
      });
      expect(decision.target).toBe("local-worker");
    });

    it("should route to cloud for large candidate lists", () => {
      const decision = router.route({
        taskType: "rankRelevantFiles",
        input: { userGoal: "Refactor", candidateFiles: Array(50).fill("file.ts") },
      });
      expect(decision.target).toBe("cloud-main");
    });
  });

  describe("summarizeFile", () => {
    it("should route to local worker when input is within budget", () => {
      const decision = router.route({
        taskType: "summarizeFile",
        input: { filePath: "src/index.ts", fileContent: "export const x = 1;" },
        inputTokenEstimate: 100,
      });
      expect(decision.target).toBe("local-worker");
    });

    it("should route to cloud when input exceeds budget", () => {
      const decision = router.route({
        taskType: "summarizeFile",
        input: { filePath: "big.ts", fileContent: "x" },
        inputTokenEstimate: 5000,
      });
      expect(decision.target).toBe("cloud-main");
    });
  });

  describe("forbidden tasks", () => {
    it("should route forbidden tasks to cloud", () => {
      const decision = router.route({
        taskType: "executeShellCommand",
        input: { command: "rm -rf /" },
      });
      expect(decision.target).toBe("cloud-main");
      expect(decision.delegatedToLocal).toBe(false);
    });

    it("should route architecture tasks to cloud", () => {
      const decision = router.route({
        taskType: "planArchitecture",
        input: { description: "Design new system" },
      });
      expect(decision.target).toBe("cloud-main");
    });
  });

  describe("secret context", () => {
    it("should route to cloud-main when context contains secrets", () => {
      const decision = router.route({
        taskType: "classifyUserIntent",
        input: { userMessage: "Check my .env file" },
        containsSecrets: true,
      });
      expect(decision.target).toBe("cloud-main");
      expect(decision.reason).toContain("secrets");
    });
  });

  describe("final code changes", () => {
    it("should route to cloud-main when task requires final code changes", () => {
      const decision = router.route({
        taskType: "suggestSimpleEdit",
        input: { fileContent: "code", instruction: "Fix bug" },
        requiresFinalCodeChanges: true,
      });
      expect(decision.target).toBe("cloud-main");
      expect(decision.reason).toContain("code changes");
    });
  });

  describe("generateCommitMessageDraft", () => {
    it("should route to local worker", () => {
      const decision = router.route({
        taskType: "generateCommitMessageDraft",
        input: { diff: "++ new line", changedFiles: ["a.ts"] },
      });
      expect(decision.target).toBe("local-worker");
    });
  });

  describe("extractSymbols", () => {
    it("should route to local worker for small inputs", () => {
      const decision = router.route({
        taskType: "extractSymbols",
        input: { fileContent: "const x = 1;" },
        inputTokenEstimate: 50,
      });
      expect(decision.target).toBe("local-worker");
    });

    it("should route to cloud for large inputs", () => {
      const decision = router.route({
        taskType: "extractSymbols",
        input: { fileContent: "big file" },
        inputTokenEstimate: 5000,
      });
      expect(decision.target).toBe("cloud-main");
    });
  });

  describe("unknown task types", () => {
    it("should route unknown task types to cloud", () => {
      const decision = router.route({
        taskType: "completelyUnknownTask",
        input: {},
      });
      expect(decision.target).toBe("cloud-main");
    });
  });

  describe("shouldRouteDirect", () => {
    it("should identify direct-tool tasks", () => {
      expect(router.shouldRouteDirect("readFile")).toBe(true);
      expect(router.shouldRouteDirect("listDirectory")).toBe(true);
      expect(router.shouldRouteDirect("gitStatus")).toBe(true);
      expect(router.shouldRouteDirect("runTests")).toBe(true);
    });

    it("should not identify write tasks as direct", () => {
      expect(router.shouldRouteDirect("writeFile")).toBe(false);
      expect(router.shouldRouteDirect("editFile")).toBe(false);
      expect(router.shouldRouteDirect("runCommand")).toBe(false);
    });
  });
});