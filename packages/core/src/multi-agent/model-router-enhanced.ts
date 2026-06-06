import { z } from "zod";
import type { LocalWorkerTaskType } from "@metalmind/schemas";
import {
  LocalWorkerTaskSchema,
  ModelRoutingDecisionSchema,
  RoutingTarget,
  LOCAL_WORKER_TASK_SCHEMAS,
  FORBIDDEN_LOCAL_WORKER_TASKS,
} from "@metalmind/schemas";
import type { ModelRoutingDecision, AgentResult } from "@metalmind/schemas";
import type { ModelCapabilities } from "../agent/agent-runtime.js";

const LOCAL_WORKER_TASK_TYPES = new Set<string>([
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
]);

export interface ModelRouterConfig {
  localWorkerModel: string;
  localWorkerProvider: string;
  cloudMainModel: string;
  cloudMainProvider: string;
  capabilities?: Record<string, ModelCapabilities>;
  budgetUsd?: number;
  maxLocalWorkerInputTokens: number;
  maxLocalWorkerOutputTokens: number;
  localWorkerTimeoutMs: number;
  maxSchemaValidationRetries: number;
}

const DEFAULT_ROUTER_CONFIG: ModelRouterConfig = {
  localWorkerModel: "deepseek-coder:1.3b",
  localWorkerProvider: "ollama",
  cloudMainModel: "claude-sonnet-latest",
  cloudMainProvider: "anthropic",
  maxLocalWorkerInputTokens: 3000,
  maxLocalWorkerOutputTokens: 800,
  localWorkerTimeoutMs: 15_000,
  maxSchemaValidationRetries: 2,
};

export interface RoutingContext {
  inputTokenEstimate?: number;
  containsSecrets?: boolean;
  requiresFinalCodeChanges?: boolean;
  taskType: string;
  input: unknown;
}

export class MultiAgentRouter {
  private config: ModelRouterConfig;

  constructor(config: Partial<ModelRouterConfig> = {}) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  route(context: RoutingContext): ModelRoutingDecision {
    const { taskType, input, inputTokenEstimate, containsSecrets, requiresFinalCodeChanges } = context;

    if (containsSecrets) {
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: "Context contains secrets — routing to cloud only with policy review",
        confidence: 1.0,
        delegatedToLocal: false,
      };
    }

    if (FORBIDDEN_LOCAL_WORKER_TASKS.has(taskType)) {
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: `Task type "${taskType}" is forbidden for local worker`,
        confidence: 1.0,
        delegatedToLocal: false,
      };
    }

    if (requiresFinalCodeChanges) {
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: "Task requires final code changes — cloud main agent must review",
        confidence: 1.0,
        delegatedToLocal: false,
      };
    }

    if (!LOCAL_WORKER_TASK_TYPES.has(taskType)) {
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: `Task type "${taskType}" not suitable for local worker — routing to cloud`,
        confidence: 0.9,
        delegatedToLocal: false,
      };
    }

    if (taskType === "classifyUserIntent") {
      return {
        target: "local-worker",
        taskType,
        modelId: this.config.localWorkerModel,
        provider: this.config.localWorkerProvider,
        reason: "User intent classification is a bounded local task",
        confidence: 0.9,
        delegatedToLocal: true,
      };
    }

    if (taskType === "rankRelevantFiles") {
      const candidateCount = (input as { candidateFiles?: unknown[] })?.candidateFiles?.length ?? Infinity;
      if (candidateCount <= 30) {
        return {
          target: "local-worker",
          taskType,
          modelId: this.config.localWorkerModel,
          provider: this.config.localWorkerProvider,
          reason: `File ranking with ${candidateCount} candidates — suitable for local worker`,
          confidence: 0.85,
          delegatedToLocal: true,
        };
      }
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: `Too many candidates (${candidateCount}) for local worker`,
        confidence: 0.8,
        delegatedToLocal: false,
      };
    }

    if (taskType === "summarizeFile") {
      const tokens = inputTokenEstimate ?? Infinity;
      if (tokens <= this.config.maxLocalWorkerInputTokens) {
        return {
          target: "local-worker",
          taskType,
          modelId: this.config.localWorkerModel,
          provider: this.config.localWorkerProvider,
          reason: `File summary within token budget (${tokens} tokens)`,
          confidence: 0.85,
          delegatedToLocal: true,
        };
      }
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: `File too large (${tokens} tokens) for local worker budget`,
        confidence: 0.8,
        delegatedToLocal: false,
      };
    }

    if (taskType === "generateCommitMessageDraft") {
      return {
        target: "local-worker",
        taskType,
        modelId: this.config.localWorkerModel,
        provider: this.config.localWorkerProvider,
        reason: "Commit message generation is a bounded local task",
        confidence: 0.85,
        delegatedToLocal: true,
      };
    }

    if (taskType === "extractSymbols" || taskType === "extractImports") {
      const tokens = inputTokenEstimate ?? Infinity;
      if (tokens <= this.config.maxLocalWorkerInputTokens) {
        return {
          target: "local-worker",
          taskType,
          modelId: this.config.localWorkerModel,
          provider: this.config.localWorkerProvider,
          reason: `Symbol/import extraction within token budget (${tokens} tokens)`,
          confidence: 0.8,
          delegatedToLocal: true,
        };
      }
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: `Input too large (${tokens} tokens) for local worker`,
        confidence: 0.75,
        delegatedToLocal: false,
      };
    }

    if (LOCAL_WORKER_TASK_TYPES.has(taskType)) {
      const tokens = inputTokenEstimate ?? 0;
      if (tokens <= this.config.maxLocalWorkerInputTokens) {
        return {
          target: "local-worker",
          taskType,
          modelId: this.config.localWorkerModel,
          provider: this.config.localWorkerProvider,
          reason: `Local-eligible task within token budget`,
          confidence: 0.75,
          delegatedToLocal: true,
        };
      }
      return {
        target: "cloud-main",
        taskType,
        modelId: this.config.cloudMainModel,
        provider: this.config.cloudMainProvider,
        reason: `Input too large for local worker — routing to cloud`,
        confidence: 0.75,
        delegatedToLocal: false,
      };
    }

    return {
      target: "cloud-main",
      taskType,
      modelId: this.config.cloudMainModel,
      provider: this.config.cloudMainProvider,
      reason: "Default: routing to cloud main agent",
      confidence: 0.5,
      delegatedToLocal: false,
    };
  }

  shouldRouteDirect(taskName: string): boolean {
    const DIRECT_TOOLS = [
      "listDirectory",
      "findFiles",
      "readFile",
      "gitStatus",
      "gitDiff",
      "gitCurrentBranch",
      "runTests",
      "runBuild",
      "runLint",
    ];
    return DIRECT_TOOLS.includes(taskName);
  }

  getConfig(): Readonly<ModelRouterConfig> {
    return this.config;
  }
}