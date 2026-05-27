import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamEvent } from "../hooks/useChat.js";

// Minimal provider stub
function makeProvider(events: Array<{ type: string; [k: string]: unknown }>) {
  return {
    providerName: "stub",
    supportedCapabilities: {
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: false,
      maximumContextTokens: 4096,
    },
    async *streamChatCompletion() {
      for (const e of events) yield e as never;
    },
    async completeChat() {
      return { message: { role: "assistant" as const, content: "" } };
    },
  };
}

// Collect all events from an async generator
async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const results: ChatStreamEvent[] = [];
  for await (const e of gen) results.push(e);
  return results;
}

// We test the agent loop logic directly by mocking the provider factory
vi.mock("@metalmind/providers", () => ({
  createProvider: vi.fn(),
}));

vi.mock("@metalmind/tools", () => ({
  ToolRegistry: class {
    private tools = new Map();
    register(t: { toolName: string }) { this.tools.set(t.toolName, t); }
    list() { return [...this.tools.values()]; }
    async execute(name: string) {
      if (name === "successTool") return "tool output";
      throw new Error("tool not found");
    }
  },
  allReadOnlyTools: [],
  allGitTools: [],
}));

import { createProvider } from "@metalmind/providers";
import { AgentLoop } from "../agent.js";

const mockCreateProvider = vi.mocked(createProvider);

describe("AgentLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams text and emits done", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "done" },
    ]) as never);

    const loop = new AgentLoop({ provider: "stub", model: "test" });
    const events = await collect(loop.run("hi"));

    expect(events.filter((e) => e.type === "text").map((e) => (e as { type: "text"; text: string }).text)).toEqual([
      "Hello",
      " world",
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("emits error event on provider failure", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        throw new Error("network error");
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test" });
    const events = await collect(loop.run("hi"));

    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.message).toContain("network error");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("maintains conversation history across turns", async () => {
    const calls: unknown[] = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion(req: { messages: unknown[] }) {
        calls.push(req.messages);
        yield { type: "text", text: "reply" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test" });
    await collect(loop.run("first"));
    await collect(loop.run("second"));

    // second call should include first user + assistant messages
    const secondCall = calls[1] as Array<{ role: string }>;
    expect(secondCall.length).toBeGreaterThan(2);
    expect(secondCall[0].role).toBe("user");
  });

  it("clearHistory resets conversation", async () => {
    const calls: unknown[] = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion(req: { messages: unknown[] }) {
        calls.push(req.messages);
        yield { type: "text", text: "reply" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test" });
    await collect(loop.run("first"));
    loop.clearHistory();
    await collect(loop.run("second"));

    const secondCall = calls[1] as Array<{ role: string }>;
    expect(secondCall.length).toBe(1); // only the new user message
    expect(secondCall[0].role).toBe("user");
  });

  it("handles empty text response gracefully", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([
      { type: "done" },
    ]) as never);

    const loop = new AgentLoop({ provider: "stub", model: "test" });
    const events = await collect(loop.run("hi"));
    expect(events.at(-1)?.type).toBe("done");
  });
});
