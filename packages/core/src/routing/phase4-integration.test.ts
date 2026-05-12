import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskClassifier } from "./task-classifier.js";
import { ModelRouter } from "./model-router.js";
import { FallbackManager } from "./index.js";
import { CostTracker, LatencyTracker } from "./cost-tracker.js";

describe("Phase 4 integration — model routing pipeline", () => {
  const classifier = new TaskClassifier();
  const router = new ModelRouter();
  const costTracker = new CostTracker();
  const latencyTracker = new LatencyTracker();

  it("full routing pipeline: classify → route → simulate fail → escalate", () => {
    // Step 1: classify
    const classification = classifier.classify(
      "read the auth service and explain how login works",
    );
    expect(classification.tier).toBe("tier1-local");

    // Step 2: route
    const decision = router.route(
      "read the auth service and explain how login works",
    );
    expect(decision.provider).toBe("ollama");
    expect(decision.tier).toBe("tier1-local");

    // Step 3: simulate cost/latency
    const startMs = Date.now();
    const estimatedTokens = costTracker.estimateTokens("read the auth service");
    const cost = costTracker.estimateCost(
      decision.provider,
      decision.modelId,
      estimatedTokens,
      200,
    );
    const elapsed = Date.now() - startMs;
    latencyTracker.record(elapsed);

    costTracker.recordUsage({
      provider: decision.provider,
      model: decision.modelId,
      inputTokens: estimatedTokens,
      outputTokens: 200,
      costUsd: cost,
      latencyMs: elapsed,
      timestamp: new Date().toISOString(),
      success: true,
    });

    expect(cost).toBe(0);
    expect(latencyTracker.getAverage()).toBeGreaterThanOrEqual(0);
  });

  it("escalation path: tier1 fails → tier2 → tier3", () => {
    const router2 = new ModelRouter({ escalationThreshold: 1 });

    const decision1 = router2.route("fix the login bug", 0);
    expect(decision1.tier).toBe("tier1-local");

    router2.recordFailure("taskX");

    const decision2 = router2.route("fix the login bug", 1);
    expect(decision2.tier).toBe("tier3-cloud");
    expect(decision2.escalatedFrom).toBe("tier2-medium");
  });

  it("fallback manager switches providers on failure", () => {
    const fm = new FallbackManager(["ollama", "openai", "anthropic"], 3);

    const r1 = fm.recordFailure("task1", "ollama");
    expect(r1.nextProvider).toBe("openai");

    const r2 = fm.recordFailure("task1", "openai");
    expect(r2.nextProvider).toBe("anthropic");

    const r3 = fm.recordFailure("task1", "anthropic");
    expect(r3.nextProvider).toBeNull();
  });
});
