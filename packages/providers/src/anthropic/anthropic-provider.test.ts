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

    it("emits a tool-call event from a tool_use content block", async () => {
      vi.stubGlobal(
        "fetch",
        createAnthropicSSE(
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "readFile" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"/a.ts"}' } },
          { type: "content_block_stop", index: 0 },
        ),
      );

      const p = new AnthropicProvider("claude", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const toolCalls = events.filter((e) => e.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolCall.toolCallId).toBe("toolu_1");
      expect(toolCalls[0].toolCall.toolName).toBe("readFile");
      expect(toolCalls[0].toolCall.argumentsJson).toBe('{"path":"/a.ts"}');
    });

    it("interleaves text and tool_use blocks", async () => {
      vi.stubGlobal(
        "fetch",
        createAnthropicSSE(
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me read it." } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "readFile" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"/b.ts"}' } },
          { type: "content_block_stop", index: 1 },
        ),
      );

      const p = new AnthropicProvider("claude", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Let me read it.");
      const toolCalls = events.filter((e) => e.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolCall.toolName).toBe("readFile");
    });

    it("surfaces a mid-stream overloaded_error as an error event", async () => {
      vi.stubGlobal(
        "fetch",
        createAnthropicSSE(
          { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        ),
      );

      const p = new AnthropicProvider("claude", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const errEvent = events.find((e) => e.type === "error");
      expect(errEvent).toBeDefined();
      expect((errEvent as { message: string }).message).toContain("Overloaded");
      expect(events.some((e) => e.type === "done")).toBe(false);
    });
  });

  describe("request-side tool calling (#132)", () => {
    function captureBody() {
      const ref: { body: Record<string, unknown> | null } = { body: null };
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
        ref.body = JSON.parse(opts.body as string);
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }] }),
        };
      }));
      return ref;
    }

    it("sends tools and hoists the system message", async () => {
      const ref = captureBody();
      const p = new AnthropicProvider("claude", "sk-test");
      await p.completeChat({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
        tools: [{ name: "readFile", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      });

      expect(ref.body!.system).toBe("be terse");
      const tools = ref.body!.tools as Array<{ name: string; input_schema: unknown }>;
      expect(tools[0].name).toBe("readFile");
      expect(tools[0].input_schema).toEqual({ type: "object", properties: { path: { type: "string" } } });
      // system message must not remain in the messages array
      const msgs = ref.body!.messages as Array<{ role: string }>;
      expect(msgs.every((m) => m.role !== "system")).toBe(true);
    });

    it("serializes assistant tool calls as tool_use and tool results as tool_result", async () => {
      const ref = captureBody();
      const p = new AnthropicProvider("claude", "sk-test");
      await p.completeChat({
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ toolCallId: "tu_1", toolName: "readFile", argumentsJson: '{"path":"/a.ts"}' }],
          },
          { role: "tool", content: "file body", metadata: { toolCallId: "tu_1" } },
        ],
      });

      const msgs = ref.body!.messages as Array<{ role: string; content: unknown }>;
      const assistant = msgs.find((m) => m.role === "assistant")!;
      const aBlocks = assistant.content as Array<Record<string, unknown>>;
      const toolUse = aBlocks.find((b) => b.type === "tool_use")!;
      expect(toolUse).toMatchObject({ id: "tu_1", name: "readFile", input: { path: "/a.ts" } });

      const userWithResult = msgs.find(
        (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => (b as Record<string, unknown>).type === "tool_result"),
      )!;
      const uBlocks = userWithResult.content as Array<Record<string, unknown>>;
      const toolResult = uBlocks.find((b) => b.type === "tool_result")!;
      expect(toolResult).toMatchObject({ tool_use_id: "tu_1", content: "file body" });
    });

    it("decodes tool_use blocks from a completeChat response", async () => {
      vi.stubGlobal("fetch", mockFetch(200, {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "tu_9", name: "gitStatus", input: {} },
        ],
      }));
      const p = new AnthropicProvider("claude", "sk-test");
      const res = await p.completeChat({ messages: [{ role: "user", content: "status" }] });
      expect(res.message.toolCalls?.[0]).toMatchObject({ toolCallId: "tu_9", toolName: "gitStatus" });
    });
  });
});
