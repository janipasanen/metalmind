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
import { ModelRouter } from "@metalmind/core";
import type { RouteDecision } from "@metalmind/core";
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

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
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

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
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

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
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

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
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

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("hi"));
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("AgentLoop routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRouter() {
    return new ModelRouter({
      tier1Model: "local-small",
      tier1Provider: "mlx",
      tier2Model: "local-small",
      tier2Provider: "mlx",
      tier3Model: "claude",
      tier3Provider: "anthropic",
      localFirst: true,
    });
  }

  it("routes a complex turn to the cloud tier and reports the decision", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    await collect(loop.run("design the authentication architecture"));

    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("anthropic");
    expect(routes[0].tier).toBe("tier3-cloud");
    expect(createdWith.some(([p, m]) => p === "anthropic" && m === "claude")).toBe(true);
  });

  it("routes a simple turn to the local tier", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "explanation" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    await collect(loop.run("explain how recursion works conceptually"));

    expect(routes[0].provider).toBe("mlx");
    expect(routes[0].tier).toBe("tier1-local");
  });

  it("uses the fixed config provider when no router is given (manual override)", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "done" }]) as never;
    });

    const loop = new AgentLoop({ provider: "ollama", model: "gemma3", explicit: true });
    await collect(loop.run("design the authentication architecture"));

    // No routing — went straight to the pinned provider despite a "complex" prompt.
    expect(createdWith).toEqual([["ollama", "gemma3"]]);
  });

  it("caches providers across turns (one construction per provider/model)", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter() },
    );

    await collect(loop.run("explain recursion conceptually"));
    await collect(loop.run("explain closures conceptually"));

    // Both simple turns route to mlx/local-small — provider built once.
    const mlxBuilds = createdWith.filter(([p, m]) => p === "mlx" && m === "local-small");
    expect(mlxBuilds).toHaveLength(1);
  });
});

describe("AgentLoop quality gate + escalation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRouter() {
    return new ModelRouter({
      tier1Model: "local-small",
      tier1Provider: "mlx",
      tier2Model: "local-small",
      tier2Provider: "mlx",
      tier3Model: "claude",
      tier3Provider: "anthropic",
      localFirst: true,
    });
  }

  function text(events: { type: string; text?: string }[]): string {
    return events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  }

  it("escalates to cloud when the local model returns an empty response", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (model === "local-small") return makeProvider([{ type: "done" }]) as never; // empty
      return makeProvider([{ type: "text", text: "cloud answer" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    const events = await collect(loop.run("explain recursion conceptually"));

    expect(text(events)).toContain("cloud answer");
    expect(text(events)).toContain("escalating");
    expect(routes.at(-1)?.provider).toBe("anthropic");
    expect(routes.at(-1)?.tier).toBe("tier3-cloud");
  });

  it("escalates when the local model refuses", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (model === "local-small")
        return makeProvider([{ type: "text", text: "I cannot do that." }, { type: "done" }]) as never;
      return makeProvider([{ type: "text", text: "cloud handled it" }, { type: "done" }]) as never;
    });

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter() },
    );

    const events = await collect(loop.run("explain recursion conceptually"));
    expect(text(events)).toContain("cloud handled it");
  });

  it("does not escalate when the local model produces a good response", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "a clear local answer" }, { type: "done" }]) as never;
    });

    const events = await collect(
      new AgentLoop(
        { provider: "mlx", model: "local-small", explicit: false },
        { router: makeRouter() },
      ).run("explain recursion conceptually"),
    );

    expect(text(events)).toBe("a clear local answer");
    expect(text(events)).not.toContain("escalating");
    expect(createdWith.some(([p]) => p === "anthropic")).toBe(false);
  });

  it("stops escalating at the cloud tier even if it also fails the gate", async () => {
    // Every model returns empty — must not loop forever; ends after reaching tier3.
    mockCreateProvider.mockImplementation(() => makeProvider([{ type: "done" }]) as never);

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter() },
    );

    const events = await collect(loop.run("explain recursion conceptually"));
    expect(events.at(-1)?.type).toBe("done");
  });
});
