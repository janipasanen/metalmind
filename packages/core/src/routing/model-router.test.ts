import { describe, it, expect } from "vitest";
import { ModelRouter } from "./model-router.js";

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
