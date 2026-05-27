import type { ModelCapabilities } from "../agent/agent-runtime.js";
import type { TaskTier, TaskClassification, ClassificationContext } from "./task-classifier.js";
import { TaskClassifier } from "./task-classifier.js";

export interface RouteDecision {
  tier: TaskTier;
  modelId: string;
  provider: string;
  reason: string;
  escalatedFrom?: TaskTier;
  escalatedReason?: string;
  /** Set when the tier was bumped because the preferred model lacked a required capability. */
  capabilityAdjusted?: boolean;
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
  /** Capabilities per `${provider}/${model}` — when present, routing filters by them. */
  capabilities?: Record<string, ModelCapabilities>;
}

const TIER_ORDER: TaskTier[] = ["tier1-local", "tier2-medium", "tier3-cloud"];

/** Whether a model with the given capabilities can satisfy a classified task. */
export function modelSatisfies(
  capabilities: ModelCapabilities | undefined,
  classification: Pick<
    TaskClassification,
    "needsTools" | "needsVision" | "estimatedContextTokens"
  >,
): boolean {
  if (!capabilities) return true; // unknown capabilities → assume eligible
  if (classification.needsTools && !capabilities.supportsToolCalling) return false;
  if (classification.needsVision && !capabilities.supportsVision) return false;
  if (classification.estimatedContextTokens > capabilities.maximumContextTokens) return false;
  return true;
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
  route(
    request: string,
    previousFailures = 0,
    context?: ClassificationContext,
  ): RouteDecision {
    const classification = this.classifier.classify(request, context);

    let decision: RouteDecision;

    if (previousFailures >= this.config.escalationThreshold) {
      const escalatedTier = this.escalateTier(classification.tier);
      decision = {
        tier: escalatedTier,
        modelId: this.modelForTier(escalatedTier),
        provider: this.providerForTier(escalatedTier),
        reason: classification.reasoning,
        escalatedFrom: classification.tier,
        escalatedReason: `Escalated after ${previousFailures} failures`,
      };
    } else if (this.config.localFirst && classification.tier === "tier2-medium") {
      decision = {
        tier: "tier1-local",
        modelId: this.config.tier1Model,
        provider: this.config.tier1Provider,
        reason: `${classification.reasoning} (local-first attempt)`,
      };
    } else {
      decision = {
        tier: classification.tier,
        modelId: this.modelForTier(classification.tier),
        provider: this.providerForTier(classification.tier),
        reason: classification.reasoning,
      };
    }

    return this.applyCapabilityFilter(decision, classification);
  }

  /**
   * If the chosen tier's model can't satisfy the task's capability requirements
   * (tools, vision, context size), bump up to the lowest eligible tier.
   */
  private applyCapabilityFilter(
    decision: RouteDecision,
    classification: TaskClassification,
  ): RouteDecision {
    if (!this.config.capabilities) return decision;

    const startIdx = TIER_ORDER.indexOf(decision.tier);
    for (let i = startIdx; i < TIER_ORDER.length; i++) {
      const tier = TIER_ORDER[i];
      const provider = this.providerForTier(tier);
      const model = this.modelForTier(tier);
      const caps = this.config.capabilities[`${provider}/${model}`];
      if (modelSatisfies(caps, classification)) {
        if (i === startIdx) return decision;
        return {
          ...decision,
          tier,
          modelId: model,
          provider,
          capabilityAdjusted: true,
          reason: `${decision.reason} (bumped from ${decision.tier}: model lacked a required capability)`,
        };
      }
    }

    return decision; // nothing eligible — keep original rather than fail hard
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
   * Build a route decision targeting a specific tier (used for quality-gate escalation).
   */
  decisionForTier(tier: TaskTier, reason: string): RouteDecision {
    return {
      tier,
      modelId: this.modelForTier(tier),
      provider: this.providerForTier(tier),
      reason,
    };
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
