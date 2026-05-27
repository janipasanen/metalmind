import { describe, it, expect, vi, beforeEach } from "vitest";
import { MlxProvider } from "./mlx-provider.js";
import type { ChatCompletionRequest, ModelStreamEvent } from "@metalmind/core";

function mockFetch(json: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(json),
    json: async () => json,
  });
}

describe("MlxProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const defaultConfig = {
    baseUrl: "http://127.0.0.1:8742",
    model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
  };

  it("has providerName mlx", () => {
    const p = new MlxProvider(defaultConfig);
    expect(p.providerName).toBe("mlx");
  });

  it("has Apple Silicon-focused capabilities", () => {
    const p = new MlxProvider(defaultConfig);
    expect(p.supportedCapabilities.supportsStreaming).toBe(true);
    expect(p.supportedCapabilities.supportsToolCalling).toBe(false);
    expect(p.supportedCapabilities.supportsReasoning).toBe(false);
    expect(p.supportedCapabilities.supportsVision).toBe(false);
    expect(p.supportedCapabilities.maximumContextTokens).toBe(32_768);
  });

  describe("healthCheck", () => {
    it("maps the sidecar snake_case response (model_loaded, platform)", async () => {
      // Matches scripts/mlx-sidecar.py /health: { status, model_loaded, model, platform }
      vi.stubGlobal(
        "fetch",
        mockFetch({ status: "ok", model_loaded: true, model: "test", platform: "darwin" }),
      );
      const p = new MlxProvider(defaultConfig);
      const health = await p.healthCheck();
      expect(health.status).toBe("ok");
      expect(health.modelLoaded).toBe(true);
      expect(health.model).toBe("test");
      expect(health.platform).toBe("darwin");
    });

    it("reports modelLoaded false when no model is loaded", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ status: "ok", model_loaded: false, model: null, platform: "darwin" }),
      );
      const p = new MlxProvider(defaultConfig);
      const health = await p.healthCheck();
      expect(health.modelLoaded).toBe(false);
      expect(health.model).toBeNull();
    });
  });

  describe("readiness", () => {
    it("reports ready when a model is loaded on the GPU", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ status: "ok", model_loaded: true, model: "deepseek", platform: "darwin" }),
      );
      const p = new MlxProvider(defaultConfig);
      const r = await p.readiness();
      expect(r.ready).toBe(true);
      expect(r.message).toContain("GPU ready");
      expect(r.message).toContain("deepseek");
    });

    it("reports not ready (no model) when sidecar is up but empty", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ status: "ok", model_loaded: false, model: null, platform: "darwin" }),
      );
      const p = new MlxProvider(defaultConfig);
      const r = await p.readiness();
      expect(r.ready).toBe(false);
      expect(r.message).toContain("no model loaded");
    });

    it("reports not ready with a start hint when the sidecar is down", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const p = new MlxProvider(defaultConfig);
      const r = await p.readiness();
      expect(r.ready).toBe(false);
      expect(r.message).toContain("mlx-sidecar.py");
    });
  });

  describe("completeChat", () => {
    it("sends chat request and returns response", async () => {
      vi.stubGlobal("fetch", mockFetch({
        message: { role: "assistant", content: "Hello from MLX!" },
        usage: { prompt_tokens: 10, completion_tokens: 5, duration_ms: 500 },
      }));

      const p = new MlxProvider(defaultConfig);
      const request: ChatCompletionRequest = {
        messages: [{ role: "user", content: "Hi" }],
      };
      const result = await p.completeChat(request);
      expect(result.message.content).toBe("Hello from MLX!");
      expect(result.message.role).toBe("assistant");
    });

    it("throws on HTTP error", async () => {
      vi.stubGlobal("fetch", mockFetch({ detail: "Model not loaded" }, false, 503));
      const p = new MlxProvider(defaultConfig);
      await expect(p.completeChat({ messages: [] })).rejects.toThrow(/MLX chat failed/);
    });
  });

  describe("streamChatCompletion", () => {
    it("streams NDJSON tokens from sidecar", async () => {
      const encoder = new TextEncoder();
      const ndjson = [
        JSON.stringify({ message: { content: "Hello" } }),
        JSON.stringify({ message: { content: " MLX" } }),
        JSON.stringify({ message: { content: "" }, done: true }),
      ].join("\n");
      const data = encoder.encode(ndjson);

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => ndjson,
        json: async () => ({}),
        body: readable,
      }));

      const p = new MlxProvider(defaultConfig);
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].text).toBe("Hello");
    });
  });
});
