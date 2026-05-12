import { describe, it, expect } from "vitest";
import { CostTracker, LatencyTracker } from "./cost-tracker.js";

describe("CostTracker", () => {
  it("estimates token count from text", () => {
    const ct = new CostTracker();
    const tokens = ct.estimateTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(3);
  });

  it("calculates costs for known providers", () => {
    const ct = new CostTracker();
    const cost = ct.estimateCost("openai", "gpt-4", 500, 500);
    expect(cost).toBe(0.03);
  });

  it("returns zero cost for ollama", () => {
    const ct = new CostTracker();
    const cost = ct.estimateCost("ollama", "deepseek", 1000, 500);
    expect(cost).toBe(0);
  });

  it("records usage and generates summary", () => {
    const ct = new CostTracker();
    ct.recordUsage({
      provider: "openai",
      model: "gpt-4",
      inputTokens: 500,
      outputTokens: 300,
      costUsd: 0.024,
      latencyMs: 1200,
      timestamp: new Date().toISOString(),
      success: true,
    });

    ct.recordUsage({
      provider: "ollama",
      model: "deepseek-coder",
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0,
      latencyMs: 450,
      timestamp: new Date().toISOString(),
      success: true,
    });

    const summary = ct.getSummary();
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalTokens).toBe(1100);
    expect(summary.totalCostUsd).toBe(0.024);
    expect(summary.byProvider.get("openai")?.calls).toBe(1);
    expect(summary.byProvider.get("ollama")?.calls).toBe(1);
  });

  it("returns recent usage entries", () => {
    const ct = new CostTracker();
    for (let i = 0; i < 25; i++) {
      ct.recordUsage({
        provider: "test",
        model: "m",
        inputTokens: i,
        outputTokens: i,
        costUsd: 0,
        latencyMs: 100,
        timestamp: new Date().toISOString(),
        success: true,
      });
    }
    expect(ct.getRecentUsage(5)).toHaveLength(5);
  });
});

describe("LatencyTracker", () => {
  it("computes average latency", () => {
    const lt = new LatencyTracker();
    lt.record(100);
    lt.record(200);
    lt.record(300);
    expect(lt.getAverage()).toBe(200);
  });

  it("computes P95 latency", () => {
    const lt = new LatencyTracker();
    for (let i = 1; i <= 100; i++) lt.record(i);
    expect(lt.getP95()).toBeGreaterThanOrEqual(95);
  });

  it("returns zero for empty tracker", () => {
    const lt = new LatencyTracker();
    expect(lt.getAverage()).toBe(0);
    expect(lt.getP95()).toBe(0);
    expect(lt.getMin()).toBe(0);
    expect(lt.getMax()).toBe(0);
  });
});
