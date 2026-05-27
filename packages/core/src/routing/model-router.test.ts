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
