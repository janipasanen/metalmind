import { z } from "zod";
import type { LocalWorkerTask, AgentResult } from "@metalmind/schemas";
import { LOCAL_WORKER_TASK_SCHEMAS, FORBIDDEN_LOCAL_WORKER_TASKS } from "@metalmind/schemas";
import type { ModelProvider } from "../agent/agent-runtime.js";
import type { ModelRoutingDecision } from "@metalmind/schemas";

export interface WorkerProvider {
  readonly providerName: string;
  sendTask(task: LocalWorkerTask): Promise<string>;
  isAvailable(): Promise<boolean>;
}

export interface LocalWorkerRunnerConfig {
  defaultTimeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSchemaValidationRetries: number;
}

const DEFAULT_RUNNER_CONFIG: LocalWorkerRunnerConfig = {
  defaultTimeoutMs: 15_000,
  maxInputTokens: 3000,
  maxOutputTokens: 800,
  maxSchemaValidationRetries: 2,
};

export class LocalWorkerRunner {
  private config: LocalWorkerRunnerConfig;
  private provider: WorkerProvider | null = null;

  constructor(provider: WorkerProvider | null, config: Partial<LocalWorkerRunnerConfig> = {}) {
    this.provider = provider;
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
  }

  setProvider(provider: WorkerProvider): void {
    this.provider = provider;
  }

  /**
   * Run multiple independent worker tasks concurrently with bounded
   * concurrency (#180). Results preserve input order; an error in one task is
   * isolated to that task's AgentResult and never rejects the whole batch.
   */
  async runMany(tasks: LocalWorkerTask[], concurrency = 4): Promise<AgentResult[]> {
    const results: AgentResult[] = new Array(tasks.length);
    let next = 0;
    const limit = Math.max(1, Math.min(concurrency, tasks.length));

    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        try {
          results[i] = await this.run(tasks[i]);
        } catch (err) {
          results[i] = {
            taskId: tasks[i].taskId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
  }

  async run(task: LocalWorkerTask): Promise<AgentResult> {
    if (FORBIDDEN_LOCAL_WORKER_TASKS.has(task.taskType)) {
      return {
        taskId: task.taskId,
        success: false,
        error: `Local worker is forbidden from performing task type: ${task.taskType}`,
      };
    }

    const taskSchemas = LOCAL_WORKER_TASK_SCHEMAS[task.taskType];
    if (!taskSchemas) {
      return {
        taskId: task.taskId,
        success: false,
        error: `Unknown local worker task type: ${task.taskType}`,
      };
    }

    const inputValidation = taskSchemas.input.safeParse(task.input);
    if (!inputValidation.success) {
      const errors = inputValidation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      return {
        taskId: task.taskId,
        success: false,
        error: `Invalid task input: ${errors}`,
      };
    }

    if (!this.provider) {
      return {
        taskId: task.taskId,
        success: false,
        error: "No local worker provider available",
      };
    }

    const available = await this.provider.isAvailable().catch(() => false);
    if (!available) {
      return {
        taskId: task.taskId,
        success: false,
        error: "Local worker provider is not available",
      };
    }

    const timeout = task.timeoutMilliseconds || this.config.defaultTimeoutMs;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.config.maxSchemaValidationRetries; attempt++) {
      const startTime = Date.now();

      try {
        const rawOutput = await Promise.race([
          this.provider.sendTask(task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Local worker timed out after ${timeout}ms`)), timeout),
          ),
        ]);

        const durationMs = Date.now() - startTime;

        const outputValidation = taskSchemas.output.safeParse(JSON.parse(rawOutput));
        if (outputValidation.success) {
          return {
            taskId: task.taskId,
            success: true,
            output: outputValidation.data,
            durationMs,
            modelUsed: this.provider.providerName,
          };
        }

        lastError = `Schema validation failed: ${outputValidation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`;

        if (attempt >= this.config.maxSchemaValidationRetries) {
          return {
            taskId: task.taskId,
            success: false,
            error: lastError,
            durationMs,
            modelUsed: this.provider.providerName,
          };
        }
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("timed out")) {
          return {
            taskId: task.taskId,
            success: false,
            error: errorMessage,
            durationMs,
            modelUsed: this.provider.providerName,
          };
        }

        lastError = errorMessage;

        if (attempt >= this.config.maxSchemaValidationRetries) {
          return {
            taskId: task.taskId,
            success: false,
            error: `Local worker failed after ${attempt + 1} attempts: ${lastError}`,
            durationMs,
            modelUsed: this.provider.providerName,
          };
        }
      }
    }

    return {
      taskId: task.taskId,
      success: false,
      error: lastError ?? "Local worker failed",
    };
  }
}