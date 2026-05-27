import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIProvider } from "./openai-provider.js";
import type { ChatCompletionRequest, ModelStreamEvent } from "@metalmind/core";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has providerName openai", () => {
    const p = new OpenAIProvider("gpt-4", "sk-test");
    expect(p.providerName).toBe("openai");
  });

  it("supports streaming, tool calling, vision, reasoning", () => {
    const p = new OpenAIProvider("gpt-4", "sk-test");
    expect(p.supportedCapabilities.supportsStreaming).toBe(true);
    expect(p.supportedCapabilities.supportsToolCalling).toBe(true);
    expect(p.supportedCapabilities.supportsVision).toBe(true);
    expect(p.supportedCapabilities.supportsReasoning).toBe(true);
    expect(p.supportedCapabilities.supportsJsonMode).toBe(true);
    expect(p.supportedCapabilities.maximumContextTokens).toBe(256_000);
  });

  describe("completeChat", () => {
    it("returns text response", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, {
          choices: [{ message: { role: "assistant", content: "Hello!" } }],
        }),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const req: ChatCompletionRequest = {
        messages: [{ role: "user", content: "Hi" }],
      };
      const result = await p.completeChat(req);
      expect(result.message.content).toBe("Hello!");
      expect(result.message.role).toBe("assistant");
    });

    it("returns tool calls when present", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "readFile",
                      arguments: '{"path":"/test.ts"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const result = await p.completeChat({
        messages: [{ role: "user", content: "read file" }],
        tools: [],
      });

      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0].toolName).toBe("readFile");
      expect(result.message.toolCalls![0].argumentsJson).toBe('{"path":"/test.ts"}');
    });

    it("throws on HTTP error", async () => {
      vi.stubGlobal("fetch", mockFetch(401, { error: "Unauthorized" }));

      const p = new OpenAIProvider("gpt-4", "bad-key");
      await expect(p.completeChat({ messages: [] })).rejects.toThrow(/OpenAI chat failed/);
    });

    it("sends api key in Authorization header", async () => {
      let capturedHeaders: Record<string, string> = {};

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
          capturedHeaders = (opts.headers ?? {}) as Record<string, string>;
          return mockFetch(
            200,
            { choices: [{ message: { role: "assistant", content: "OK" } }] },
          )();
        }),
      );

      const p = new OpenAIProvider("gpt-4", "sk-my-key");
      await p.completeChat({ messages: [{ role: "user", content: "test" }] });
      expect(capturedHeaders["Authorization"]).toBe("Bearer sk-my-key");
    });

    it("handles null content gracefully", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, {
          choices: [{ message: { role: "assistant", content: null } }],
        }),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const result = await p.completeChat({ messages: [] });
      expect(result.message.content).toBe("");
    });
  });

  describe("streamChatCompletion", () => {
    function createSSEStream(...chunks: Array<Record<string, unknown>>) {
      const encoder = new TextEncoder();
      const sse = chunks
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join("") + "data: [DONE]\n\n";
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

    it("streams text tokens from SSE", async () => {
      vi.stubGlobal(
        "fetch",
        createSSEStream(
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: { content: " world" } }] },
        ),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBe(2);
      expect(textEvents[0].text).toBe("Hello");
      expect(textEvents[1].text).toBe(" world");
    });

    it("throws on stream HTTP error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Error",
        json: async () => ({}),
      }));

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const iter = p.streamChatCompletion({ messages: [] });
      await expect(iter.next()).rejects.toThrow(/OpenAI stream failed/);
    });

    it("throws when response has no body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        body: null,
      }));

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const iter = p.streamChatCompletion({ messages: [] });
      await expect(iter.next()).rejects.toThrow(/no body/);
    });

    it("handles empty stream gracefully", async () => {
      const encoder = new TextEncoder();
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        body: readable,
      }));

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect(events.filter((e) => e.type === "text")).toHaveLength(0);
    });

    it("accumulates streamed tool-call deltas into a tool-call event", async () => {
      vi.stubGlobal(
        "fetch",
        createSSEStream(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "readFile" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/a.ts"}' } }] } }] },
        ),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const toolCalls = events.filter((e) => e.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolCall.toolCallId).toBe("call_1");
      expect(toolCalls[0].toolCall.toolName).toBe("readFile");
      expect(toolCalls[0].toolCall.argumentsJson).toBe('{"path":"/a.ts"}');
      // tool-call must be emitted before done
      const tcIdx = events.findIndex((e) => e.type === "tool-call");
      const doneIdx = events.findIndex((e) => e.type === "done");
      expect(tcIdx).toBeLessThan(doneIdx);
    });

    it("emits multiple tool calls keyed by index", async () => {
      vi.stubGlobal(
        "fetch",
        createSSEStream(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "readFile", arguments: "{}" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "gitStatus", arguments: "{}" } }] } }] },
        ),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const toolCalls = events.filter((e) => e.type === "tool-call");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((t) => t.toolCall.toolName)).toEqual(["readFile", "gitStatus"]);
    });
  });
});
