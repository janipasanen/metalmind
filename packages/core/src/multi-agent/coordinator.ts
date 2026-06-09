import { createHash } from "node:crypto";
import type { LocalWorkerTask, AgentResult, LocalWorkerTaskType } from "@metalmind/schemas";
import type { WorkerProvider } from "./local-worker-runner.js";
import type { LocalWorkerRunnerConfig } from "./local-worker-runner.js";
import { LocalWorkerRunner } from "./local-worker-runner.js";
import type { ModelRoutingDecision } from "@metalmind/schemas";
import { MultiAgentRouter, type RoutingContext, type ModelRouterConfig } from "./model-router-enhanced.js";
import type { ModelProvider } from "../agent/agent-runtime.js";
import { EventBus } from "../events/event-bus.js";

export interface CoordinatorEvents {
  "coordinator:plan": { plan: CoordinatorPlan; requestId: string };
  "coordinator:local-task-started": { taskId: string; taskType: string };
  "coordinator:local-task-completed": { taskId: string; success: boolean; durationMs?: number };
  "coordinator:local-task-failed": { taskId: string; error: string };
  "coordinator:cloud-request": { requestId: string; phase: string };
  "coordinator:tool-call": { toolName: string; requiresApproval: boolean };
  "coordinator:routing": { decision: ModelRoutingDecision };
  "coordinator:status": { phase: CoordinatorPhase; message: string };
}

export type CoordinatorPhase =
  | "idle"
  | "planning"
  | "local-delegation"
  | "cloud-processing"
  | "tool-execution"
  | "review"
  | "completed"
  | "error";

export interface CoordinatorPlan {
  steps: PlanStep[];
  userRequest: string;
  createdAt: string;
}

export interface PlanStep {
  id: string;
  description: string;
  type: "local-worker" | "cloud-main" | "direct-tool";
  taskType?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: AgentResult;
}

export interface LocalWorkerResultCacheEntry {
  key: string;
  taskType: string;
  modelId: string;
  inputHash: string;
  output: unknown;
  createdAt: number;
  ttlMs: number;
}

export class LocalWorkerResultCache {
  private cache = new Map<string, LocalWorkerResultCacheEntry>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 300_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  static makeKey(taskType: string, modelId: string, input: unknown): string {
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
    return `${taskType}:${modelId}:${inputHash}`;
  }

  get(taskType: string, modelId: string, input: unknown): unknown | undefined {
    const key = LocalWorkerResultCache.makeKey(taskType, modelId, input);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.output;
  }

  set(taskType: string, modelId: string, input: unknown, output: unknown, ttlMs?: number): void {
    const key = LocalWorkerResultCache.makeKey(taskType, modelId, input);
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
    this.cache.set(key, {
      key,
      taskType,
      modelId,
      inputHash,
      output,
      createdAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  evictExpired(): number {
    let evicted = 0;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}

export interface CoordinatorConfig {
  router: Partial<ModelRouterConfig>;
  runner: Partial<LocalWorkerRunnerConfig>;
  cacheEnabled: boolean;
  cacheTtlMs: number;
}

const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  router: {},
  runner: {},
  cacheEnabled: true,
  cacheTtlMs: 300_000,
};

export class Coordinator {
  private router: MultiAgentRouter;
  private runner: LocalWorkerRunner;
  private cache: LocalWorkerResultCache;
  private eventBus: EventBus;
  private config: CoordinatorConfig;
  private phase: CoordinatorPhase = "idle";
  private plan: CoordinatorPlan | null = null;

  constructor(
    private cloudProvider: ModelProvider | null,
    localWorkerProvider: WorkerProvider | null,
    config: Partial<CoordinatorConfig> = {},
  ) {
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
    this.router = new MultiAgentRouter(this.config.router);
    this.runner = new LocalWorkerRunner(localWorkerProvider, this.config.runner);
    this.cache = new LocalWorkerResultCache(this.config.cacheTtlMs);
    this.eventBus = new EventBus();
  }

  getPhase(): CoordinatorPhase {
    return this.phase;
  }

  getPlan(): CoordinatorPlan | null {
    return this.plan;
  }

  getRouter(): MultiAgentRouter {
    return this.router;
  }

  getRunner(): LocalWorkerRunner {
    return this.runner;
  }

  getCache(): LocalWorkerResultCache {
    return this.cache;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.eventBus.on(event, handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.eventBus.off(event, handler);
  }

  async processRequest(
    userRequest: string,
    context?: Partial<RoutingContext>,
  ): Promise<{ decision: ModelRoutingDecision; localResult?: AgentResult }> {
    this.setPhase("planning");

    const routingContext: RoutingContext = {
      taskType: context?.taskType ?? "classifyUserIntent",
      input: context?.input ?? { userMessage: userRequest },
      inputTokenEstimate: context?.inputTokenEstimate,
      containsSecrets: context?.containsSecrets ?? false,
      requiresFinalCodeChanges: context?.requiresFinalCodeChanges ?? false,
    };

    const decision = this.router.route(routingContext);
    this.eventBus.emit("coordinator:routing", { decision });
    this.eventBus.emit("coordinator:status", { phase: this.phase, message: decision.reason });

    let localResult: AgentResult | undefined;

    if (decision.target === "local-worker" && this.config.cacheEnabled) {
      const cached = this.cache.get(
        decision.taskType ?? routingContext.taskType,
        decision.modelId ?? "",
        routingContext.input,
      );
      if (cached !== undefined) {
        localResult = {
          taskId: `cache-${Date.now()}`,
          success: true,
          output: cached,
          durationMs: 0,
          modelUsed: "cache",
        };
      }
    }

    if (!localResult && decision.target === "local-worker") {
      this.setPhase("local-delegation");
      const task: LocalWorkerTask = {
        taskId: `worker-${Date.now()}`,
        taskType: routingContext.taskType as LocalWorkerTaskType,
        input: routingContext.input,
        outputSchemaName: `${routingContext.taskType}Output`,
        maximumInputTokens: this.config.runner.maxInputTokens ?? 3000,
        maximumOutputTokens: this.config.runner.maxOutputTokens ?? 800,
        timeoutMilliseconds: this.config.runner.defaultTimeoutMs ?? 15_000,
      };

      this.eventBus.emit("coordinator:local-task-started", {
        taskId: task.taskId,
        taskType: task.taskType,
      });

      localResult = await this.runner.run(task);

      this.eventBus.emit(
        localResult.success ? "coordinator:local-task-completed" : "coordinator:local-task-failed",
        {
          taskId: task.taskId,
          success: localResult.success,
          durationMs: localResult.durationMs,
          ...(localResult.success ? {} : { error: localResult.error }),
        },
      );

      if (localResult.success && this.config.cacheEnabled) {
        this.cache.set(
          routingContext.taskType,
          decision.modelId ?? "",
          routingContext.input,
          localResult.output,
        );
      }
    }

    if (decision.target === "cloud-main") {
      this.setPhase("cloud-processing");
    }

    if (localResult?.success || decision.target === "cloud-main") {
      if (decision.target !== "cloud-main") {
        this.setPhase("completed");
      }
    } else if (localResult && !localResult.success) {
      this.eventBus.emit("coordinator:status", {
        phase: "cloud-processing",
        message: `Local worker failed: ${localResult.error}. Will fall back to cloud.`,
      });
    }

    return { decision, localResult };
  }

  /**
   * Run several independent local-worker tasks concurrently (#180), emitting
   * lifecycle events per task. Results preserve input order; errors are
   * isolated per task.
   */
  async runParallelTasks(tasks: LocalWorkerTask[], concurrency = 4): Promise<AgentResult[]> {
    if (tasks.length === 0) return [];
    this.setPhase("local-delegation");
    for (const t of tasks) {
      this.eventBus.emit("coordinator:local-task-started", { taskId: t.taskId, taskType: t.taskType });
    }

    const results = await this.runner.runMany(tasks, concurrency);

    results.forEach((r, i) => {
      this.eventBus.emit(
        r.success ? "coordinator:local-task-completed" : "coordinator:local-task-failed",
        {
          taskId: tasks[i].taskId,
          success: r.success,
          durationMs: r.durationMs,
          ...(r.success ? {} : { error: r.error }),
        },
      );
      if (r.success && this.config.cacheEnabled) {
        this.cache.set(tasks[i].taskType, r.modelUsed ?? "", tasks[i].input, r.output);
      }
    });

    this.setPhase("completed");
    return results;
  }

  /**
   * Decompose a multi-step request into an ordered plan via the planner model,
   * set it, and emit coordinator:plan so the Plan UI populates (#166).
   */
  async buildPlan(userRequest: string, planner: ModelProvider | null = this.cloudProvider): Promise<CoordinatorPlan | null> {
    if (!planner) return null;
    this.setPhase("planning");
    try {
      const res = await planner.completeChat({
        messages: [
          {
            role: "system",
            content:
              'Decompose the user\'s coding request into 2-6 ordered, concrete steps. Respond ONLY with a JSON array of objects: [{"description": string, "type": "local-worker"|"cloud-main"|"direct-tool"}]. Use "cloud-main" for reasoning/code-writing, "local-worker" for summarize/extract/rank, "direct-tool" for a single file/command op. No prose.',
          },
          { role: "user", content: userRequest },
        ],
      });
      const steps = this.parseStepsJson(res.message.content);
      if (steps.length === 0) return null;
      this.plan = { steps, userRequest, createdAt: new Date().toISOString() };
      this.eventBus.emit("coordinator:plan", { plan: this.plan, requestId: `plan-${Date.now()}` });
      return this.plan;
    } catch {
      return null;
    }
  }

  private parseStepsJson(raw: string): PlanStep[] {
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(match ? match[0] : raw) as Array<{ description?: string; type?: string }>;
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, 6).map((s, i) => ({
        id: `step-${i + 1}`,
        description: String(s.description ?? `Step ${i + 1}`),
        type: s.type === "local-worker" || s.type === "direct-tool" ? s.type : "cloud-main",
        status: "pending" as const,
      }));
    } catch {
      return [];
    }
  }

  /** Update one plan step's status and re-emit the plan (#166). */
  updateStepStatus(id: string, status: PlanStep["status"]): void {
    if (!this.plan) return;
    const step = this.plan.steps.find((s) => s.id === id);
    if (!step) return;
    step.status = status;
    this.eventBus.emit("coordinator:plan", { plan: this.plan, requestId: "plan-update" });
  }

  /** Set every plan step to a status (e.g. all running / all completed) (#166). */
  markAllSteps(status: PlanStep["status"]): void {
    if (!this.plan) return;
    for (const s of this.plan.steps) s.status = status;
    this.eventBus.emit("coordinator:plan", { plan: this.plan, requestId: "plan-update" });
  }

  /** Clear the current plan (e.g. for a new turn). */
  clearPlan(): void {
    this.plan = null;
  }

  private setPhase(phase: CoordinatorPhase): void {
    this.phase = phase;
    this.eventBus.emit("coordinator:status", { phase, message: `Phase: ${phase}` });
  }
}