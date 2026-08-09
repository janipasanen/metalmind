import { describe, it, expect, vi, afterEach } from "vitest";
import { MlxProvider } from "./mlx-provider.js";

/**
 * Tier 1 tool calling. The sidecar renders tool definitions through the model's
 * chat template, so the model emits <tool_call> markup as ordinary TEXT — the
 * provider must send the tools, hide that markup from the transcript, and emit
 * real tool-call events.
 */
afterEach(() => vi.unstubAllGlobals());

function ndjsonStream(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(JSON.stringify({ message: { content: c } }) + "\n"));
      controller.enqueue(enc.encode(JSON.stringify({ done: true, usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const TOOLS = [{ name: "readFile", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];

describe("MLX tool calling", () => {
  it("advertises the capability", () => {
    expect(new MlxProvider({ baseUrl: "http://127.0.0.1:8742", model: "m" } as never).supportedCapabilities.supportsToolCalling).toBe(true);
  });

  it("sends tools to the sidecar in the OpenAI function shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonStream(["hello"]));
    vi.stubGlobal("fetch", fetchMock);
    const p = new MlxProvider({ baseUrl: "http://127.0.0.1:8742", model: "m" } as never);
    for await (const _ of p.streamChatCompletion({ messages: [{ role: "user", content: "hi" }], tools: TOOLS } as never)) { /* drain */ }
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("readFile");
    expect(body.tools[0].function.parameters.properties.path.type).toBe("string");
  });

  it("emits a tool-call event and never leaks the markup as text", async () => {
    // Split across chunks exactly as a real token stream would arrive.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonStream([
      "Let me check. ", "<tool_", "call>", '{"name":"readFile",', '"arguments":{"path":"a.ts"}}', "</tool_call>",
    ])));
    const p = new MlxProvider({ baseUrl: "http://127.0.0.1:8742", model: "m" } as never);
    const events: Array<{ type: string; text?: string; toolCall?: { toolName: string; argumentsJson: string } }> = [];
    for await (const e of p.streamChatCompletion({ messages: [{ role: "user", content: "read a.ts" }], tools: TOOLS } as never)) {
      events.push(e as never);
    }
    const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    expect(text).toContain("Let me check.");
    expect(text).not.toContain("tool_call");   // markup must never reach the transcript
    expect(text).not.toContain("readFile");

    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolCall!.toolName).toBe("readFile");
    expect(JSON.parse(calls[0].toolCall!.argumentsJson)).toEqual({ path: "a.ts" });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("streams ordinary prose through untouched when no tool is called", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonStream(["The answer ", "is 42."])));
    const p = new MlxProvider({ baseUrl: "http://127.0.0.1:8742", model: "m" } as never);
    const out: string[] = [];
    for await (const e of p.streamChatCompletion({ messages: [{ role: "user", content: "q" }] } as never)) {
      if ((e as { type: string }).type === "text") out.push((e as { text: string }).text);
    }
    expect(out.join("")).toBe("The answer is 42.");
  });

  it("does not send a tools field when the turn has none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonStream(["ok"]));
    vi.stubGlobal("fetch", fetchMock);
    const p = new MlxProvider({ baseUrl: "http://127.0.0.1:8742", model: "m" } as never);
    for await (const _ of p.streamChatCompletion({ messages: [{ role: "user", content: "hi" }] } as never)) { /* drain */ }
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).tools).toBeUndefined();
  });

  it("parses tool calls from the non-streaming path too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        message: { role: "assistant", content: 'Sure.<tool_call>{"name":"listDirectory","arguments":{"path":"."}}</tool_call>' },
        tools_applied: true,
      }), { status: 200 }),
    ));
    const p = new MlxProvider({ baseUrl: "http://127.0.0.1:8742", model: "m" } as never);
    const res = await p.completeChat({ messages: [{ role: "user", content: "ls" }], tools: TOOLS } as never);
    expect(res.message.toolCalls).toHaveLength(1);
    expect(res.message.toolCalls![0].toolName).toBe("listDirectory");
    expect(res.message.content).not.toContain("tool_call");
  });
});
