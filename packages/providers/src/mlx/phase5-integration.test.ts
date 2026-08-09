import { describe, it, expect, vi, beforeEach } from "vitest";
import { MlxProvider } from "./mlx-provider.js";
import { TaskClassifier, ModelRouter } from "@metalmind/core";

describe("Phase 5 integration — MLX provider pipeline", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mlxConfig = {
    baseUrl: "http://127.0.0.1:8742",
    model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
  };

  function mockFetch(json: unknown, ok = true, status = 200) {
    return vi.fn().mockResolvedValue({
      ok,
      status,
      text: async () => JSON.stringify(json),
      json: async () => json,
    });
  }

  it("MLX provider integrates with the routing system", () => {
    const router = new ModelRouter({
      tier1Model: mlxConfig.model,
      tier1Provider: "mlx",
      tier2Model: mlxConfig.model,
      tier2Provider: "mlx",
      tier3Model: "claude-sonnet-latest",
      tier3Provider: "anthropic",
    });

    const decision = router.route("read the file src/auth.ts");
    expect(decision.provider).toBe("mlx");
    expect(decision.tier).toBe("tier1-local");
  });

  it("MLX provider capabilities reflect local model constraints", () => {
    const provider = new MlxProvider(mlxConfig);
        // MLX is tool-capable now (sidecar chat-template tool rendering).
    expect(provider.supportedCapabilities.supportsToolCalling).toBe(true);
    expect(provider.supportedCapabilities.supportsReasoning).toBe(true);
    expect(provider.supportedCapabilities.supportsStreaming).toBe(true);
  });

  it("healthCheck returns model status", async () => {
    vi.stubGlobal("fetch", mockFetch({
      status: "ok",
      model_loaded: true,
      model: mlxConfig.model,
      platform: "darwin",
    }));

    const provider = new MlxProvider(mlxConfig);
    const health = await provider.healthCheck();
    expect(health.modelLoaded).toBe(true);
    expect(health.model).toBe(mlxConfig.model);
  });

  it("escalates from MLX to cloud on complex tasks", () => {
    const router = new ModelRouter({
      tier1Model: mlxConfig.model,
      tier1Provider: "mlx",
      tier3Model: "claude-sonnet-latest",
      tier3Provider: "anthropic",
    });

    const decision = router.route("design the authentication architecture");
    expect(decision.provider).toBe("anthropic");
    expect(decision.tier).toBe("tier3-cloud");
  });
});
