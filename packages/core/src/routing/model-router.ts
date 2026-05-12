import type { ModelCapabilities } from "../agent/agent-runtime.js";
import type { TaskTier, TaskClassification } from "./task-classifier.js";
import { TaskClassifier } from "./task-classifier.js";

export interface RouteDecision {
  tier: TaskTier;
  modelId: string;
  provider: string;
  reason: string;
  escalatedFrom?: TaskTier;
  escalatedReason?: string;
}

export interface RoutingConfig {
  tier1Model: string;
  tier1Provider: string;
  tier2Model: string;
  tier2Provider: string;
  tier3Model: string;
  tier3Provider: string;
  localFirst: boolean;
  escalationThreshold: number; // number of failures before escalation
}

const DEFAULT_CONFIG: RoutingConfig = {
  tier1Model: "deepseek-coder:1.3b",
  tier1Provider: "ollama",
  tier2Model: "deepseek-coder:6.7b",
  tier2Provider: "ollama",
  tier3Model: "claude-sonnet-latest",
  tier3Provider: "anthropic",
  localFirst: true,
  escalationThreshold: 2,
};

export class ModelRouter {
  private config: RoutingConfig;
  private classifier: TaskClassifier;
  private escalationCount = new Map<string, number>();

  constructor(config: Partial<RoutingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.classifier = new TaskClassifier();
  }

  /**
   * Route a user request to the appropriate model.
   */
  route(request: string, previousFailures = 0): RouteDecision {
    const classification = this.classifier.classify(request);

    if (previousFailures >= this.config.escalationThreshold) {
      const escalatedTier = this.escalateTier(classification.tier);
      return {
        tier: escalatedTier,
        modelId: this.modelForTier(escalatedTier),
        provider: this.providerForTier(escalatedTier),
        reason: classification.reasoning,
        escalatedFrom: classification.tier,
        escalatedReason: `Escalated after ${previousFailures} failures`,
      };
    }

    if (this.config.localFirst && classification.tier === "tier2-medium") {
      return {
        tier: "tier1-local",
        modelId: this.config.tier1Model,
        provider: this.config.tier1Provider,
        reason: `${classification.reasoning} (local-first attempt)`,
      };
    }

    return {
      tier: classification.tier,
      modelId: this.modelForTier(classification.tier),
      provider: this.providerForTier(classification.tier),
      reason: classification.reasoning,
    };
  }

  /**
   * Record a failure for a task and decide whether to escalate.
   */
  recordFailure(taskId: string): boolean {
    const count = (this.escalationCount.get(taskId) ?? 0) + 1;
    this.escalationCount.set(taskId, count);
    return count >= this.config.escalationThreshold;
  }

  /**
   * Get the escalated tier for a given tier.
   */
  escalateTier(tier: TaskTier): TaskTier {
    switch (tier) {
      case "tier1-local":
        return "tier2-medium";
      case "tier2-medium":
        return "tier3-cloud";
      default:
        return "tier3-cloud";
    }
  }

  /**
   * Reset escalation tracking for a task.
   */
  resetTask(taskId: string): void {
    this.escalationCount.delete(taskId);
  }

  private modelForTier(tier: TaskTier): string {
    switch (tier) {
      case "tier1-local":
        return this.config.tier1Model;
      case "tier2-medium":
        return this.config.tier2Model;
      case "tier3-cloud":
        return this.config.tier3Model;
    }
  }

  private providerForTier(tier: TaskTier): string {
    switch (tier) {
      case "tier1-local":
        return this.config.tier1Provider;
      case "tier2-medium":
        return this.config.tier2Provider;
      case "tier3-cloud":
        return this.config.tier3Provider;
    }
  }
}
