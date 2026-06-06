import { describe, it, expect } from "vitest";
import {
  AgentRoleType,
  AgentTaskStatus,
  AgentTaskSchema,
  LocalWorkerTaskType,
  LocalWorkerTaskSchema,
  AgentResultSchema,
  RoutingTarget,
  ModelRoutingDecisionSchema,
  FORBIDDEN_LOCAL_WORKER_TASKS,
} from "@metalmind/schemas";

describe("AgentRoleType", () => {
  it("should accept valid agent roles", () => {
    expect(AgentRoleType.parse("cloud-main")).toBe("cloud-main");
    expect(AgentRoleType.parse("local-worker")).toBe("local-worker");
    expect(AgentRoleType.parse("coordinator")).toBe("coordinator");
  });

  it("should reject invalid agent roles", () => {
    expect(() => AgentRoleType.parse("admin")).toThrow();
    expect(() => AgentRoleType.parse("")).toThrow();
  });
});

describe("AgentTaskStatus", () => {
  it("should accept valid statuses", () => {
    for (const status of ["pending", "assigned", "running", "completed", "failed", "cancelled"]) {
      expect(AgentTaskStatus.parse(status)).toBe(status);
    }
  });

  it("should reject invalid statuses", () => {
    expect(() => AgentTaskStatus.parse("unknown")).toThrow();
  });
});

describe("AgentTaskSchema", () => {
  const validTask = {
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    taskType: "rankRelevantFiles",
    status: "pending",
    assignedTo: "local-worker",
    input: { userGoal: "test" },
    createdAt: new Date().toISOString(),
  };

  it("should validate a correct agent task", () => {
    const result = AgentTaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
  });

  it("should reject missing required fields", () => {
    const { taskId, ...withoutId } = validTask;
    const result = AgentTaskSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
  });

  it("should reject invalid status", () => {
    const result = AgentTaskSchema.safeParse({ ...validTask, status: "unknown" });
    expect(result.success).toBe(false);
  });

  it("should reject invalid assignedTo role", () => {
    const result = AgentTaskSchema.safeParse({ ...validTask, assignedTo: "admin" });
    expect(result.success).toBe(false);
  });

  it("should allow optional fields", () => {
    const result = AgentTaskSchema.safeParse({
      ...validTask,
      output: { some: "data" },
      error: "something went wrong",
      completedAt: new Date().toISOString(),
      parentId: "660e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });
});

describe("LocalWorkerTaskType", () => {
  it("should accept all defined task types", () => {
    const validTypes = [
      "classifyUserIntent",
      "rankRelevantFiles",
      "summarizeFile",
      "summarizeDiff",
      "summarizeCommandOutput",
      "extractSymbols",
      "extractImports",
      "identifyLikelyTestFiles",
      "generateCommitMessageDraft",
      "validateJsonLikeOutput",
      "suggestSimpleEdit",
      "explainCompilerError",
    ];
    for (const t of validTypes) {
      expect(LocalWorkerTaskType.parse(t)).toBe(t);
    }
  });

  it("should reject non-local-worker task types", () => {
    expect(() => LocalWorkerTaskType.parse("executeShellCommand")).toThrow();
    expect(() => LocalWorkerTaskType.parse("planArchitecture")).toThrow();
  });
});

describe("LocalWorkerTaskSchema", () => {
  it("should validate a correct local worker task", () => {
    const task = {
      taskId: "worker-task-001",
      taskType: "rankRelevantFiles",
      input: { userGoal: "Add Ollama Cloud provider", candidateFiles: ["a.ts"] },
      outputSchemaName: "RankRelevantFilesOutput",
      maximumInputTokens: 3000,
      maximumOutputTokens: 800,
      timeoutMilliseconds: 15000,
    };
    const result = LocalWorkerTaskSchema.safeParse(task);
    expect(result.success).toBe(true);
  });

  it("should reject zero token budgets", () => {
    const task = {
      taskId: "worker-task-001",
      taskType: "rankRelevantFiles",
      input: {},
      outputSchemaName: "Output",
      maximumInputTokens: 0,
      maximumOutputTokens: 800,
      timeoutMilliseconds: 15000,
    };
    const result = LocalWorkerTaskSchema.safeParse(task);
    expect(result.success).toBe(false);
  });

  it("should reject negative timeout", () => {
    const task = {
      taskId: "worker-task-001",
      taskType: "classifyUserIntent",
      input: {},
      outputSchemaName: "Output",
      maximumInputTokens: 3000,
      maximumOutputTokens: 800,
      timeoutMilliseconds: -1,
    };
    const result = LocalWorkerTaskSchema.safeParse(task);
    expect(result.success).toBe(false);
  });
});

describe("AgentResultSchema", () => {
  it("should validate a successful result", () => {
    const result = AgentResultSchema.safeParse({
      taskId: "worker-001",
      success: true,
      output: { rankedFiles: [] },
      durationMs: 1500,
      modelUsed: "deepseek-coder:1.3b",
    });
    expect(result.success).toBe(true);
  });

  it("should validate a failed result", () => {
    const result = AgentResultSchema.safeParse({
      taskId: "worker-002",
      success: false,
      error: "Schema validation failed",
    });
    expect(result.success).toBe(true);
  });

  it("should require taskId and success", () => {
    const result = AgentResultSchema.safeParse({ output: {} });
    expect(result.success).toBe(false);
  });
});

describe("RoutingTarget", () => {
  it("should accept valid routing targets", () => {
    expect(RoutingTarget.parse("local-worker")).toBe("local-worker");
    expect(RoutingTarget.parse("cloud-main")).toBe("cloud-main");
    expect(RoutingTarget.parse("direct-tool")).toBe("direct-tool");
  });

  it("should reject invalid targets", () => {
    expect(() => RoutingTarget.parse("unknown")).toThrow();
  });
});

describe("ModelRoutingDecisionSchema", () => {
  it("should validate a correct routing decision", () => {
    const decision = ModelRoutingDecisionSchema.safeParse({
      target: "local-worker",
      taskType: "rankRelevantFiles",
      modelId: "deepseek-coder:1.3b",
      provider: "ollama",
      reason: "File ranking with small candidate list",
      confidence: 0.85,
      delegatedToLocal: true,
    });
    expect(decision.success).toBe(true);
  });

  it("should allow minimal routing decision", () => {
    const decision = ModelRoutingDecisionSchema.safeParse({
      target: "cloud-main",
      taskType: "architect",
      reason: "Architecture decision requires cloud reasoning",
    });
    expect(decision.success).toBe(true);
  });
});

describe("FORBIDDEN_LOCAL_WORKER_TASKS", () => {
  it("should contain forbidden task types", () => {
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("executeShellCommand")).toBe(true);
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("deleteFiles")).toBe(true);
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("writeFiles")).toBe(true);
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("commitCode")).toBe(true);
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("planArchitecture")).toBe(true);
  });

  it("should not contain allowed task types", () => {
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("classifyUserIntent")).toBe(false);
    expect(FORBIDDEN_LOCAL_WORKER_TASKS.has("rankRelevantFiles")).toBe(false);
  });
});