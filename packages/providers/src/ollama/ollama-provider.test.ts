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
});
