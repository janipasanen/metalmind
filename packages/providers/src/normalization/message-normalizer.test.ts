import { describe, it, expect } from "vitest";
import { MessageNormalizer } from "./message-normalizer.js";

describe("MessageNormalizer", () => {
  const normalizer = new MessageNormalizer();

  describe("normalizeComplete", () => {
    it("extracts content string from response object", () => {
      const result = normalizer.normalizeComplete({ content: "Hello there" }, "unknown");
      expect(result.role).toBe("assistant");
      expect(result.content).toBe("Hello there");
    });

    it("extracts text field when content is absent", () => {
      const result = normalizer.normalizeComplete({ text: "Hi from model" }, "unknown");
      expect(result.content).toBe("Hi from model");
    });

    it("extracts from message.content nested structure", () => {
      const result = normalizer.normalizeComplete(
        { message: { role: "assistant", content: "Nested" } },
        "ollama",
      );
      expect(result.content).toBe("Nested");
    });

    it("handles string input", () => {
      const result = normalizer.normalizeComplete("plain string", "unknown");
      expect(result.role).toBe("assistant");
      expect(result.content).toBe("plain string");
    });

    it("handles null/empty input", () => {
      const result = normalizer.normalizeComplete(null, "unknown");
      expect(result.content).toBe("null");
    });
  });

  describe("normalizeStream", () => {
    async function collectStream(
      chunks: unknown[],
      provider = "unknown",
    ): Promise<Array<{ type: string; text?: string }>> {
      const stream = (async function* () {
        for (const chunk of chunks) yield chunk;
      })();

      const events: Array<{ type: string; text?: string }> = [];
      for await (const e of normalizer.normalizeStream(stream, provider, {
        supportsStreaming: true,
        supportsToolCalling: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsJsonMode: false,
        maximumContextTokens: 4096,
      })) {
        events.push(e);
      }
      return events;
    }

    it("extracts text from OpenAI-style stream chunks", async () => {
      const events = await collectStream(
        [
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: { content: " world" } }] },
        ],
        "openai",
      );

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(2);
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("extracts text from Anthropic-style stream chunks", async () => {
      const events = await collectStream(
        [
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Bonjour" },
          },
        ],
        "anthropic",
      );

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].text).toBe("Bonjour");
    });

    it("skips non-content blocks in Anthropic stream", async () => {
      const events = await collectStream(
        [
          { type: "message_start" },
          { type: "content_block_delta", delta: { type: "text_delta", text: "data" } },
          { type: "ping" },
        ],
        "anthropic",
      );

      expect(events.filter((e) => e.type === "text")).toHaveLength(1);
    });

    it("handles generic stream chunks with text/content", async () => {
      const events = await collectStream([
        { text: "chunk1" },
        { content: "chunk2" },
      ]);

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(2);
    });

    it("extracts tool calls from OpenAI stream", async () => {
      const events = await collectStream(
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "readFile", arguments: '{"path":"/test"}' },
                    },
                  ],
                },
              },
            ],
          },
        ],
        "openai",
      );

      const tcEvents = events.filter((e) => e.type === "tool-call");
      expect(tcEvents).toHaveLength(1);
    });
  });
});
