import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";
import type { ChatCompletionRequest, ModelStreamEvent } from "@metalmind/core";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("AnthropicProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has providerName anthropic", () => {
    const p = new AnthropicProvider("claude-sonnet", "sk-test");
    expect(p.providerName).toBe("anthropic");
  });

  it("supports streaming, tool calling, vision, reasoning", () => {
    const p = new AnthropicProvider("claude-sonnet", "sk-test");
    expect(p.supportedCapabilities.supportsStreaming).toBe(true);
    expect(p.supportedCapabilities.supportsToolCalling).toBe(true);
    expect(p.supportedCapabilities.supportsVision).toBe(true);
    expect(p.supportedCapabilities.supportsReasoning).toBe(true);
    expect(p.supportedCapabilities.supportsJsonMode).toBe(false);
    expect(p.supportedCapabilities.maximumContextTokens).toBe(200_000);
  });

  describe("completeChat", () => {
    it("returns concatenated text content", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, {
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " from Claude!" },
          ],
        }),
      );

      const p = new AnthropicProvider("claude-sonnet", "sk-test");
      const req: ChatCompletionRequest = {
        messages: [{ role: "user", content: "Hi" }],
      };
      const result = await p.completeChat(req);
      expect(result.message.content).toBe("Hello from Claude!");
      expect(result.message.role).toBe("assistant");
    });

    it("sends x-api-key header", async () => {
      let capturedHeaders: Record<string, string> = {};

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
          capturedHeaders = (opts.headers ?? {}) as Record<string, string>;
          return mockFetch(200, {
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
          })();
        }),
      );

      const p = new AnthropicProvider("claude", "sk-claude-key");
      await p.completeChat({
        messages: [{ role: "user", content: "test" }],
      });
      expect(capturedHeaders["x-api-key"]).toBe("sk-claude-key");
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    });

    it("throws on HTTP error", async () => {
      vi.stubGlobal("fetch", mockFetch(403, { error: "Forbidden" }));

      const p = new AnthropicProvider("claude", "bad-key");
      await expect(p.completeChat({ messages: [] })).rejects.toThrow(/Anthropic chat failed/);
    });

    it("filters out non-text content blocks", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, {
          role: "assistant",
          content: [
            { type: "text", text: "Using tool:" },
            { type: "tool_use", id: "tool1", name: "search", input: {} },
          ],
        }),
      );

      const p = new AnthropicProvider("claude", "sk-test");
      const result = await p.completeChat({ messages: [] });
      expect(result.message.content).toBe("Using tool:");
    });
  });

  describe("streamChatCompletion", () => {
    function createAnthropicSSE(...chunks: Array<Record<string, unknown>>) {
      const encoder = new TextEncoder();
      const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
      const data = encoder.encode(sse);

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });

      return vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        body: readable,
      });
    }

    it("streams text from content_block_delta events", async () => {
      vi.stubGlobal(
        "fetch",
        createAnthropicSSE(
          { type: "content_block_start", index: 0 },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: " Claude" } },
          { type: "content_block_stop", index: 0 },
        ),
      );

      const p = new AnthropicProvider("claude", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBe(2);
      expect(textEvents.map((e) => e.text).join("")).toBe("Hello Claude");
    });

    it("throws on stream HTTP error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Error",
        json: async () => ({}),
      }));

      const p = new AnthropicProvider("claude", "sk-test");
      const iter = p.streamChatCompletion({ messages: [] });
      await expect(iter.next()).rejects.toThrow(/Anthropic stream failed/);
    });

    it("throws when response has no body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        body: null,
      }));

      const p = new AnthropicProvider("claude", "sk-test");
      const iter = p.streamChatCompletion({ messages: [] });
      await expect(iter.next()).rejects.toThrow(/no body/);
    });

    it("skips non-delta events", async () => {
      vi.stubGlobal(
        "fetch",
        createAnthropicSSE(
          { type: "message_start" },
          { type: "ping" },
          { type: "content_block_delta", delta: { type: "text_delta", text: "data" } },
          { type: "message_delta" },
        ),
      );

      const p = new AnthropicProvider("claude", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(1);
    });
  });
});
