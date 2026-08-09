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
        // Tier 1 gained tool calling: the sidecar renders tool definitions through
    // the model's chat template and the provider parses the calls back out.
    expect(p.supportedCapabilities.supportsToolCalling).toBe(true);
    // Qwen3-family MLX models emit chain-of-thought that the provider splits
    // into reasoning events; vision stays false until the sidecar grows an
    // image path.
    expect(p.supportedCapabilities.supportsReasoning).toBe(true);
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

    it("raises a clean error on a malformed 200 body with no message (#244)", async () => {
      vi.stubGlobal("fetch", mockFetch({ usage: { prompt_tokens: 1 } }));
      const p = new MlxProvider(defaultConfig);
      await expect(p.completeChat({ messages: [] })).rejects.toThrow(/MLX chat returned no message/);
    });

    it("surfaces an {error} body returned with a 200 (#244)", async () => {
      vi.stubGlobal("fetch", mockFetch({ error: "context overflow" }));
      const p = new MlxProvider(defaultConfig);
      await expect(p.completeChat({ messages: [] })).rejects.toThrow(/context overflow/);
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

    // Qwen3-family templates pre-open a <think> block in the prompt, so the
    // model's first tokens are chain-of-thought terminated by a bare closing
    // tag. The sidecar flags this; without honouring the flag the user reads
    // the model's private deliberation and a stray "</think>" as the answer.
    async function streamOf(lines: unknown[]): Promise<ModelStreamEvent[]> {
      const ndjson = lines.map((l) => JSON.stringify(l)).join("\n");
      const data = new TextEncoder().encode(ndjson);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => ndjson,
        json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(data);
            c.close();
          },
        }),
      }));
      const events: ModelStreamEvent[] = [];
      for await (const e of new MlxProvider(defaultConfig).streamChatCompletion({ messages: [] })) {
        events.push(e);
      }
      return events;
    }

    const joined = (events: ModelStreamEvent[], type: string) =>
      events.filter((e) => e.type === type).map((e) => (e as { text: string }).text).join("");

    it("routes pre-opened chain-of-thought to reasoning, not the answer", async () => {
      const events = await streamOf([
        { reasoning_open: true },
        { message: { content: "Let me think" } },
        { message: { content: " about it.\n</think>\n\nThe answer is 42." } },
        { message: { content: "" }, done: true },
      ]);

      // Trailing newline belongs to the reasoning span — only the tag itself
      // and the blank line after it are consumed.
      expect(joined(events, "reasoning")).toBe("Let me think about it.\n");
      expect(joined(events, "text")).toBe("The answer is 42.");
      expect(joined(events, "text")).not.toContain("</think>");
    });

    it("holds back a closing tag split across chunks", async () => {
      const events = await streamOf([
        { reasoning_open: true },
        { message: { content: "hmm</thi" } },
        { message: { content: "nk>\n\nDone." } },
        { message: { content: "" }, done: true },
      ]);

      expect(joined(events, "reasoning")).toBe("hmm");
      expect(joined(events, "text")).toBe("Done.");
    });

    it("treats output as the answer when no block was left open", async () => {
      const events = await streamOf([
        { reasoning_open: false },
        { message: { content: "Straight answer." } },
        { message: { content: "" }, done: true },
      ]);

      expect(joined(events, "reasoning")).toBe("");
      expect(joined(events, "text")).toBe("Straight answer.");
    });

    it("surfaces unterminated reasoning rather than dropping it", async () => {
      // max_tokens can cut the generation before the block ever closes.
      const events = await streamOf([
        { reasoning_open: true },
        { message: { content: "still thinking" } },
        { message: { content: "" }, done: true },
      ]);

      expect(joined(events, "reasoning")).toBe("still thinking");
      expect(joined(events, "text")).toBe("");
    });
  });
});
