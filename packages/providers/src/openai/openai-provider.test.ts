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

    it("surfaces a mid-stream error chunk as an error event (not a silent done)", async () => {
      vi.stubGlobal(
        "fetch",
        createSSEStream(
          { choices: [{ delta: { content: "partial" } }] },
          { error: { message: "model overloaded" } },
        ),
      );

      const p = new OpenAIProvider("gpt-4", "sk-test");
      const events: ModelStreamEvent[] = [];
      for await (const e of p.streamChatCompletion({ messages: [] })) {
        events.push(e);
      }

      const errEvent = events.find((e) => e.type === "error");
      expect(errEvent).toBeDefined();
      expect((errEvent as { message: string }).message).toContain("model overloaded");
      // The stream must stop at the error, not emit a success `done`.
      expect(events.some((e) => e.type === "done")).toBe(false);
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

  describe("message conversion", () => {
    it("emits id on assistant tool_calls and tool_call_id on tool results", async () => {
      let requestBody: { messages: Array<Record<string, unknown>> } | null = null;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
        requestBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        };
      }));

      const p = new OpenAIProvider("gpt-4", "sk-test");
      await p.completeChat({
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ toolCallId: "call_abc", toolName: "readFile", argumentsJson: '{"path":"/a.ts"}' }],
          },
          { role: "tool", content: "file contents", metadata: { toolCallId: "call_abc" } },
        ],
      });

      const msgs = requestBody!.messages;
      const assistant = msgs[1] as { tool_calls?: Array<{ id?: string }> };
      // Without these two ids OpenAI 400s on the second turn of a tool conversation.
      expect(assistant.tool_calls![0].id).toBe("call_abc");
      expect(msgs[2].tool_call_id).toBe("call_abc");
    });
  });
});

describe("OpenAIProvider.listModels (#214)", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("returns chat models, filtered + sorted", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { data: [
      { id: "gpt-4o" }, { id: "gpt-3.5-turbo" }, { id: "text-embedding-3-large" }, { id: "dall-e-3" }, { id: "o1-mini" },
    ] }));
    const p = new OpenAIProvider("gpt-4o", "sk-test");
    const models = await p.listModels();
    expect(models).toEqual(["gpt-3.5-turbo", "gpt-4o", "o1-mini"]);
  });
  it("returns [] without an API key", async () => {
    const p = new OpenAIProvider("gpt-4o", "");
    expect(await p.listModels()).toEqual([]);
  });
});

describe("OpenAIProvider vision serialization (#177)", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("serializes a user message's images into multimodal content parts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "a cat" } }] }),
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAIProvider("gpt-4o", "sk-test");
    await p.completeChat({ messages: [{ role: "user", content: "what is this?", images: ["data:image/png;base64,AAAA"] }] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toContainEqual({ type: "text", text: "what is this?" });
    expect(userMsg.content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });
});
