import { describe, it, expect } from "vitest";
import { ModelRouter, modelSatisfies } from "./model-router.js";
import type { ModelCapabilities } from "../agent/agent-runtime.js";

describe("ModelRouter", () => {
  const router = new ModelRouter();

  it("routes read tasks to ollama tier1", () => {
    const decision = router.route("read the file src/auth.ts");
    expect(decision.tier).toBe("tier1-local");
    expect(decision.provider).toBe("ollama");
  });

  it("routes architecture tasks to anthropic cloud", () => {
    const decision = router.route("design the authentication architecture");
    expect(decision.tier).toBe("tier3-cloud");
    expect(decision.provider).toBe("anthropic");
  });

  it("uses local-first for medium tasks", () => {
    const decision = router.route("edit the timeout value");
    expect(decision.tier).toBe("tier1-local");
  });

  it("escalates after threshold failures", () => {
    const decision = router.route("read file", 3);
    expect(decision.tier).toBe("tier2-medium");
    expect(decision.escalatedFrom).toBe("tier1-local");
    expect(decision.escalatedReason).toContain("3 failures");
  });

  it("tracks and reports failures", () => {
    const router2 = new ModelRouter({ escalationThreshold: 2 });
    expect(router2.recordFailure("task1")).toBe(false);
    expect(router2.recordFailure("task1")).toBe(true);
  });

  it("resets task tracking", () => {
    const router3 = new ModelRouter({ escalationThreshold: 2 });
    router3.recordFailure("task1");
    router3.recordFailure("task1");
    router3.resetTask("task1");
    expect(router3.recordFailure("task1")).toBe(false);
  });

  it("escalates tier1 to tier2", () => {
    expect(router.escalateTier("tier1-local")).toBe("tier2-medium");
  });

  it("escalates tier2 to tier3", () => {
    expect(router.escalateTier("tier2-medium")).toBe("tier3-cloud");
  });

  it("accepts custom routing config", () => {
    const customRouter = new ModelRouter({
      tier3Model: "deepseek-v4-pro:cloud",
      tier3Provider: "ollama",
    });
    const decision = customRouter.route("design new auth architecture");
    expect(decision.modelId).toBe("deepseek-v4-pro:cloud");
    expect(decision.provider).toBe("ollama");
  });
});

describe("modelSatisfies", () => {
  const noTools: ModelCapabilities = {
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsJsonMode: false,
    maximumContextTokens: 32_768,
  };

  it("returns true when capabilities are unknown", () => {
    expect(modelSatisfies(undefined, { needsTools: true, needsVision: true, estimatedContextTokens: 999_999 })).toBe(true);
  });

  it("rejects a tool task for a non-tool model", () => {
    expect(modelSatisfies(noTools, { needsTools: true, needsVision: false, estimatedContextTokens: 100 })).toBe(false);
  });

  it("rejects a context larger than the window", () => {
    expect(modelSatisfies(noTools, { needsTools: false, needsVision: false, estimatedContextTokens: 40_000 })).toBe(false);
  });

  it("accepts a fitting task", () => {
    expect(modelSatisfies(noTools, { needsTools: false, needsVision: false, estimatedContextTokens: 100 })).toBe(true);
  });
});

describe("ModelRouter capability-aware routing", () => {
  // MLX local tier can't call tools; cloud tier can.
  const capabilities: Record<string, ModelCapabilities> = {
    "mlx/local-small": {
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: false,
      maximumContextTokens: 32_768,
    },
    "anthropic/claude-sonnet-latest": {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsJsonMode: false,
      maximumContextTokens: 200_000,
    },
  };

  function mlxLocalRouter() {
    return new ModelRouter({
      tier1Model: "local-small",
      tier1Provider: "mlx",
      tier2Model: "local-small",
      tier2Provider: "mlx",
      tier3Model: "claude-sonnet-latest",
      tier3Provider: "anthropic",
      localFirst: true,
      capabilities,
    });
  }

  it("bumps a tool-using task off the non-tool MLX local tier to cloud", () => {
    const router = mlxLocalRouter();
    // "read auth.ts" classifies tier1-local and needsTools (file ref) → MLX can't do tools → bump
    const decision = router.route("read auth.ts");
    expect(decision.capabilityAdjusted).toBe(true);
    expect(decision.provider).toBe("anthropic");
    expect(decision.tier).toBe("tier3-cloud");
  });

  it("does not bump a pure conceptual question (no tools needed)", () => {
    const router = mlxLocalRouter();
    const decision = router.route("explain how recursion works conceptually");
    expect(decision.capabilityAdjusted).toBeUndefined();
    expect(decision.provider).toBe("mlx");
    expect(decision.tier).toBe("tier1-local");
  });

  it("leaves routing unchanged when no capabilities registry is configured", () => {
    const router = new ModelRouter({ tier1Provider: "mlx", tier1Model: "local-small" });
    const decision = router.route("read auth.ts");
    expect(decision.capabilityAdjusted).toBeUndefined();
    expect(decision.provider).toBe("mlx");
  });
});

describe("ModelRouter triage pass", () => {
  it("invokes triage for a low-confidence task and uses its label", async () => {
    const router = new ModelRouter(); // defaults: tier3 anthropic
    let called = false;
    const triage = async () => {
      called = true;
      return "COMPLEX" as const;
    };
    // "handle the widget thing" hits no keyword → default tier1, confidence 0.6 < 0.7
    const decision = await router.routeWithTriage("handle the widget thing", 0, undefined, triage);
    expect(called).toBe(true);
    expect(decision.tier).toBe("tier3-cloud");
    expect(decision.reason).toContain("triaged");
  });

  it("does NOT invoke triage for a high-confidence task", async () => {
    const router = new ModelRouter();
    let called = false;
    const triage = async () => {
      called = true;
      return "COMPLEX" as const;
    };
    // "design the architecture" → tier3 keyword, confidence 0.85 ≥ 0.7
    const decision = await router.routeWithTriage("design the architecture", 0, undefined, triage);
    expect(called).toBe(false);
    expect(decision.tier).toBe("tier3-cloud");
  });

  it("falls back to the heuristic when triage returns null", async () => {
    const router = new ModelRouter();
    const decision = await router.routeWithTriage("handle the widget thing", 0, undefined, async () => null);
    expect(decision.tier).toBe("tier1-local"); // heuristic default
  });

  it("falls back to the heuristic when triage throws", async () => {
    const router = new ModelRouter();
    const decision = await router.routeWithTriage("handle the widget thing", 0, undefined, async () => {
      throw new Error("local model down");
    });
    expect(decision.tier).toBe("tier1-local");
  });

  it("maps SIMPLE/MEDIUM/COMPLEX to the right tiers", async () => {
    const router = new ModelRouter();
    const simple = await router.routeWithTriage("handle the widget thing", 0, undefined, async () => "SIMPLE");
    const medium = await router.routeWithTriage("handle the widget thing", 0, undefined, async () => "MEDIUM");
    const complex = await router.routeWithTriage("handle the widget thing", 0, undefined, async () => "COMPLEX");
    expect(simple.tier).toBe("tier1-local");
    expect(medium.tier).toBe("tier2-medium");
    expect(complex.tier).toBe("tier3-cloud");
  });
});

describe("ModelRouter budget-aware routing", () => {
  function usage(costUsd: number): import("./cost-tracker.js").ProviderUsage {
    return {
      provider: "anthropic",
      model: "claude",
      inputTokens: 1000,
      outputTokens: 1000,
      costUsd,
      latencyMs: 100,
      timestamp: new Date().toISOString(),
      success: true,
    };
  }

  it("does not adjust when under budget", () => {
    const router = new ModelRouter({ budgetUsd: 5, tier1Provider: "mlx", tier1Model: "local" });
    router.recordUsage(usage(1));
    const decision = router.route("design the architecture");
    expect(decision.tier).toBe("tier3-cloud");
    expect(decision.budgetAdjusted).toBeUndefined();
  });

  it("downgrades a cloud task to local once the budget is reached", () => {
    const router = new ModelRouter({ budgetUsd: 1, tier1Provider: "mlx", tier1Model: "local" });
    router.recordUsage(usage(2)); // over budget
    const decision = router.route("design the architecture");
    expect(decision.budgetAdjusted).toBe(true);
    expect(decision.tier).toBe("tier1-local");
    expect(decision.provider).toBe("mlx");
  });

  it("reports budget status", () => {
    const router = new ModelRouter({ budgetUsd: 3 });
    router.recordUsage(usage(1.5));
    const status = router.budgetStatus();
    expect(status.spentUsd).toBeCloseTo(1.5);
    expect(status.budgetUsd).toBe(3);
    expect(status.overBudget).toBe(false);
  });

  it("lets a real capability need override the budget downgrade (correctness wins)", () => {
    const capabilities = {
      "mlx/local": {
        supportsStreaming: true,
        supportsToolCalling: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsJsonMode: false,
        maximumContextTokens: 32_768,
      },
      "anthropic/claude": {
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsVision: true,
        supportsReasoning: true,
        supportsJsonMode: false,
        maximumContextTokens: 200_000,
      },
    };
    const router = new ModelRouter({
      budgetUsd: 1,
      tier1Provider: "mlx",
      tier1Model: "local",
      tier2Provider: "mlx",
      tier2Model: "local",
      tier3Provider: "anthropic",
      tier3Model: "claude",
      capabilities,
    });
    router.recordUsage(usage(2)); // over budget

    // refactor across 2 files → tier3 + needsTools; budget tries local, but MLX can't do tools.
    const decision = router.route("refactor auth.ts and config.ts");
    expect(decision.tier).toBe("tier3-cloud");
    expect(decision.provider).toBe("anthropic");
    expect(decision.capabilityAdjusted).toBe(true);
  });
});
