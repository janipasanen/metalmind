import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "./ollama-provider.js";
import type { ChatCompletionRequest, ModelStreamEvent } from "@metalmind/core";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null as ReadableStream | null,
  });
}

describe("OllamaProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("sets providerName to ollama", () => {
      const p = new OllamaProvider("deepseek-coder:1.3b");
      expect(p.providerName).toBe("ollama");
    });

    it("uses default baseUrl", () => {
      const p = new OllamaProvider("test-model");
      expect(p.supportedCapabilities.supportsStreaming).toBe(true);
      expect(p.supportedCapabilities.maximumContextTokens).toBe(128_000);
    });

    it("accepts custom baseUrl", () => {
      const p = new OllamaProvider("test", "http://localhost:9999");
      expect(p.supportedCapabilities.supportsToolCalling).toBe(true);
      expect(p.supportedCapabilities.supportsVision).toBe(false);
    });
  });

  describe("capabilities", () => {
    it("supports streaming and tool calling", () => {
      const p = new OllamaProvider("test");
      expect(p.supportedCapabilities.supportsStreaming).toBe(true);
      expect(p.supportedCapabilities.supportsToolCalling).toBe(true);
    });

    it("does not support vision or reasoning", () => {
      const p = new OllamaProvider("test");
      expect(p.supportedCapabilities.supportsVision).toBe(false);
      expect(p.supportedCapabilities.supportsReasoning).toBe(false);
    });

    it("supports JSON mode", () => {
      const p = new OllamaProvider("test");
      expect(p.supportedCapabilities.supportsJsonMode).toBe(true);
    });
  });

  describe("listModels", () => {
    it("returns model names from API", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, { models: [{ name: "llama2" }, { name: "deepseek-coder:1.3b" }] }),
      );

      const p = new OllamaProvider("test");
      const models = await p.listModels();
      expect(models).toEqual(["llama2", "deepseek-coder:1.3b"]);
    });
  });

  describe("model management (#203)", () => {
    it("listModelsDetailed returns name + size", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, { models: [{ name: "ministral-3:3b", size: 3_000_000_000, modified_at: "2026-06-11" }] }),
      );
      const p = new OllamaProvider("test");
      const models = await p.listModelsDetailed();
      expect(models).toEqual([{ name: "ministral-3:3b", size: 3_000_000_000, modified: "2026-06-11" }]);
    });

    it("pullModel yields streamed NDJSON progress events", async () => {
      const ndjson =
        JSON.stringify({ status: "pulling", completed: 50, total: 100 }) +
        "\n" +
        JSON.stringify({ status: "success" }) +
        "\n";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjson));
          controller.close();
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }));

      const p = new OllamaProvider("test");
      const events: Array<{ status: string }> = [];
      for await (const ev of p.pullModel("ministral-3:3b")) events.push(ev);
      expect(events[0]).toEqual({ status: "pulling", completed: 50, total: 100 });
      expect(events.at(-1)).toEqual({ status: "success" });
    });

    it("deleteModel issues a DELETE and resolves on 200", async () => {
      const fetchMock = mockFetch(200, {});
      vi.stubGlobal("fetch", fetchMock);
      const p = new OllamaProvider("test");
      await expect(p.deleteModel("old-model")).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/delete"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("completeChat", () => {
    it("returns assistant message from Ollama API", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, { message: { role: "assistant", content: "Hello from Ollama!" } }),
      );

      const p = new OllamaProvider("test");
      const request: ChatCompletionRequest = {
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = await p.completeChat(request);
      expect(result.message.role).toBe("assistant");
      expect(result.message.content).toBe("Hello from Ollama!");
    });

    it("sends keep_alive so the model stays resident between turns (#213)", async () => {
      const fetchMock = mockFetch(200, { message: { role: "assistant", content: "ok" } });
      vi.stubGlobal("fetch", fetchMock);
      const p = new OllamaProvider("test");
      await p.completeChat({ messages: [{ role: "user", content: "hi" }] });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
      expect(body.keep_alive).toBe("10m");
    });

    it("throwss on HTTP error", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(500, { error: "Internal server error" }),
      );

      const p = new OllamaProvider("test");
      const request: ChatCompletionRequest = {
        messages: [{ role: "user", content: "Hello" }],
      };

      await expect(p.completeChat(request)).rejects.toThrow(/Ollama chat failed/);
    });

    it("raises a clean error on a malformed 200 body with no message (#244)", async () => {
      vi.stubGlobal("fetch", mockFetch(200, { not_a_message: true }));
      const p = new OllamaProvider("test");
      await expect(p.completeChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
        /Ollama chat returned no message/,
      );
    });

    it("surfaces an {error} body returned with a 200 (#244)", async () => {
      vi.stubGlobal("fetch", mockFetch(200, { error: "model not found" }));
      const p = new OllamaProvider("test");
      await expect(p.completeChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
        /model not found/,
      );
    });

    it("skips malformed tool_calls missing a function name (#244)", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(200, {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { arguments: {} } }, // malformed: no name
              { function: { name: "writeFile", arguments: { path: "x" } } },
            ],
          },
        }),
      );
      const p = new OllamaProvider("test");
      const result = await p.completeChat({ messages: [{ role: "user", content: "hi" }] });
      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls?.[0].toolName).toBe("writeFile");
    });

    it("converts AgentMessage roles to Ollama format", async () => {
      let requestBody: unknown = null;

      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (reqUrl, opts) => {
        requestBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ message: { role: "assistant", content: "OK" } }),
          json: async () => ({ message: { role: "assistant", content: "OK" } }),
        };
      }));

      const p = new OllamaProvider("test-model");
      const request: ChatCompletionRequest = {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Question?" },
        ],
      };

      await p.completeChat(request);
      
      const body = requestBody as { messages: Array<{ role: string; content: string }> };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].role).toBe("user");
    });
  });

  describe("countTokens", () => {
    it("returns zero token count", async () => {
      const p = new OllamaProvider("test");
      const result = await p.countTokens!({ messages: [] });
      expect(result.tokenCount).toBe(0);
    });
  });

  describe("authentication (Ollama Cloud)", () => {
    it("sends no Authorization header when no apiKey is set", async () => {
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ message: { role: "assistant", content: "OK" } }),
        };
      }));

      const p = new OllamaProvider("test");
      await p.completeChat({ messages: [{ role: "user", content: "Hi" }] });
      expect(capturedHeaders.Authorization).toBeUndefined();
    });

    it("sends Bearer Authorization header when apiKey is set", async () => {
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ message: { role: "assistant", content: "OK" } }),
        };
      }));

      const p = new OllamaProvider("gemma3", "https://ollama.com", "sk-ollama-test");
      await p.completeChat({ messages: [{ role: "user", content: "Hi" }] });
      expect(capturedHeaders.Authorization).toBe("Bearer sk-ollama-test");
    });

    it("sends Authorization header on streaming requests too", async () => {
      let capturedHeaders: Record<string, string> = {};
      const encoder = new TextEncoder();
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({}),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
              controller.close();
            },
          }),
        };
      }));

      const p = new OllamaProvider("gemma3", "https://ollama.com", "sk-ollama-test");
      for await (const _e of p.streamChatCompletion({ messages: [] })) {
        // drain
      }
      expect(capturedHeaders.Authorization).toBe("Bearer sk-ollama-test");
    });
  });
});

describe("OllamaProvider streaming", () => {
  function createMockStream(...chunks: Array<Record<string, unknown>>) {
    const encoder = new TextEncoder();
    const jsonLines = chunks.map((c) => JSON.stringify(c)).join("\n");
    const data = encoder.encode(jsonLines);

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const response = {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
      body: readable,
    };

    return vi.fn().mockResolvedValue(response);
  }

  it("streams text tokens from Ollama", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "Hello" } },
        { message: { content: " from" } },
        { message: { content: " Ollama" } },
        { done: true },
      ),
    );

    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
  });

  it("surfaces reasoning-model thinking as reasoning events, separate from text", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "", thinking: "Let me" } },
        { message: { content: "", thinking: " think." } },
        { message: { content: "The answer." } },
        { done: true },
      ),
    );

    const p = new OllamaProvider("gpt-oss:120b");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) events.push(e);

    const reasoning = events.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text).join("");
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(reasoning).toBe("Let me think.");
    expect(text).toBe("The answer.");
  });

  it("throws on HTTP error during streaming", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
      json: async () => ({}),
    }));

    const p = new OllamaProvider("test");
    const iterator = p.streamChatCompletion({ messages: [] });
    await expect(iterator.next()).rejects.toThrow(/Ollama stream failed/);
  });

  it("throws when response has no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
      body: null,
    }));

    const p = new OllamaProvider("test");
    const iterator = p.streamChatCompletion({ messages: [] });
    await expect(iterator.next()).rejects.toThrow(/no body/);
  });

  it("handles empty stream gracefully", async () => {
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(""));
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

    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }
    expect(events.filter((e) => e.type === "done").length).toBe(1);
  });

  it("emits a tool-call event from message.tool_calls", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "", tool_calls: [{ function: { name: "readFile", arguments: { path: "/a.ts" } } }] } },
        { done: true },
      ),
    );

    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCall.toolName).toBe("readFile");
    expect(JSON.parse(toolCalls[0].toolCall.argumentsJson)).toEqual({ path: "/a.ts" });
    const tcIdx = events.findIndex((e) => e.type === "tool-call");
    const doneIdx = events.findIndex((e) => e.type === "done");
    expect(tcIdx).toBeLessThan(doneIdx);
  });

  it("emits a usage event from prompt_eval_count/eval_count on done (#157)", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "hi" } },
        { done: true, prompt_eval_count: 42, eval_count: 17 },
      ),
    );
    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) events.push(e);
    const usage = events.find((e) => e.type === "usage") as { type: "usage"; usage: { inputTokens?: number; outputTokens?: number } } | undefined;
    expect(usage?.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
  });

  it("surfaces a mid-stream {\"error\":...} line as an error event", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "partial" } },
        { error: "Function call is missing a thought_signature" },
      ),
    );

    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }

    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    expect((errEvent as { message: string }).message).toContain("thought_signature");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("uses the server-provided tool_call id as the toolCallId", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "", tool_calls: [{ id: "srv-abc123", function: { name: "readFile", arguments: { path: "/a.ts" } } }] } },
        { done: true },
      ),
    );

    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }

    const toolCalls = events.filter((e) => e.type === "tool-call");
    // The server id must be preserved so Gemini can recover the call's
    // thought_signature on the follow-up turn (not replaced by a synthetic one).
    expect(toolCalls[0].toolCall.toolCallId).toBe("srv-abc123");
  });

  it("falls back to a synthetic toolCallId when the server omits one", async () => {
    vi.stubGlobal(
      "fetch",
      createMockStream(
        { message: { content: "", tool_calls: [{ function: { name: "readFile", arguments: {} } }] } },
        { done: true },
      ),
    );

    const p = new OllamaProvider("test");
    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls[0].toolCall.toolCallId).toMatch(/^ollama-tc-\d+$/);
  });
});

describe("OllamaProvider message conversion", () => {
  it("carries assistant toolCalls and tool results into the request body", async () => {
    let requestBody: { messages: Array<Record<string, unknown>> } | null = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ message: { role: "assistant", content: "OK" } }),
      };
    }));

    const p = new OllamaProvider("test");
    await p.completeChat({
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "tc1", toolName: "readFile", argumentsJson: '{"path":"/a.ts"}' }],
        },
        { role: "tool", content: "file contents" },
      ],
    });

    const msgs = requestBody!.messages;
    expect(msgs).toHaveLength(3);
    const assistant = msgs[1] as { tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls![0].function.name).toBe("readFile");
    expect(assistant.tool_calls![0].function.arguments).toEqual({ path: "/a.ts" });
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].content).toBe("file contents");
  });

  it("echoes tool-call correlation ids for the Gemini thought_signature round-trip", async () => {
    let requestBody: { messages: Array<Record<string, unknown>> } | null = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ message: { role: "assistant", content: "OK" } }),
      };
    }));

    const p = new OllamaProvider("gemini-3-flash-preview:cloud");
    await p.completeChat({
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "srv-xyz", toolName: "readFile", argumentsJson: '{"path":"/a.ts"}' }],
        },
        { role: "tool", content: "file contents", metadata: { toolCallId: "srv-xyz" } },
      ],
    });

    const msgs = requestBody!.messages;
    const assistant = msgs[1] as { tool_calls?: Array<{ id?: string }> };
    // Assistant tool_call must carry the server id...
    expect(assistant.tool_calls![0].id).toBe("srv-xyz");
    // ...and the tool result must echo it back so Gemini can match the pair.
    expect(msgs[2].tool_call_id).toBe("srv-xyz");
  });

  it("repairs malformed tool-call argument JSON instead of coercing to {} (#175)", async () => {
    let requestBody: { messages: Array<Record<string, unknown>> } | null = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, opts) => {
      requestBody = JSON.parse(opts.body as string);
      return { ok: true, status: 200, text: async () => "", json: async () => ({ message: { role: "assistant", content: "ok" } }) };
    }));
    const p = new OllamaProvider("test");
    await p.completeChat({
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          // Trailing comma + single quotes — malformed JSON a small model might emit.
          toolCalls: [{ toolCallId: "t1", toolName: "readFile", argumentsJson: "{'path': '/a.ts',}" }],
        },
      ],
    });
    const assistant = requestBody!.messages[1] as { tool_calls?: Array<{ function: { arguments: Record<string, unknown> } }> };
    expect(assistant.tool_calls![0].function.arguments).toEqual({ path: "/a.ts" });
  });
});

describe("OllamaProvider completeChat tool calls (#222)", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("forwards tools and surfaces tool calls from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ message: { role: "assistant", content: "", tool_calls: [
        { id: "tc-1", function: { name: "readFile", arguments: { path: "a.ts" } } },
      ] } }),
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = new OllamaProvider("test");
    const res = await p.completeChat({
      messages: [{ role: "user", content: "read it" }],
      tools: [{ name: "readFile", description: "read a file", inputSchema: { type: "object" } }],
    } as never);
    // tools forwarded
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.tools?.[0]?.function?.name).toBe("readFile");
    // tool calls surfaced
    expect(res.message.toolCalls?.[0]).toEqual({
      toolCallId: "tc-1", toolName: "readFile", argumentsJson: JSON.stringify({ path: "a.ts" }),
    });
  });
});
