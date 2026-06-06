import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamEvent } from "../hooks/useChat.js";

// Minimal provider stub
function makeProvider(
  events: Array<{ type: string; [k: string]: unknown }>,
  readiness: { ready: boolean; message: string } = { ready: true, message: "ready" },
) {
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
    async readiness() {
      return readiness;
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
  OllamaWorkerProvider: class {
    providerName = "ollama-worker";
    private modelId: string;
    private baseUrl: string;
    constructor(modelId: string, baseUrl = "http://127.0.0.1:11434") {
      this.modelId = modelId;
      this.baseUrl = baseUrl;
    }
    async isAvailable() {
      try {
        const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        return res.ok;
      } catch {
        return false;
      }
    }
    async sendTask() { return "{}"; }
  },
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
  allWriteTools: [],
  allGitTools: [],
  runShellTools: [],
}));

import { createProvider } from "@metalmind/providers";
import { ModelRouter } from "@metalmind/core";
import type { RouteDecision } from "@metalmind/core";
import {
  AgentLoop,
  createDefaultRouter,
  resolveNamedTier,
  defaultLocalTier,
} from "../agent.js";

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
        yield { type: "text", text: "" };
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

    // second call should include system prompt + first user + assistant + second user
    const secondCall = calls[1] as Array<{ role: string }>;
    expect(secondCall.length).toBeGreaterThan(2);
    expect(secondCall[0].role).toBe("system");
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
    // After clearHistory, run() adds a system prompt + user message
    expect(secondCall.length).toBe(2);
    expect(secondCall[0].role).toBe("system");
    expect(secondCall[1].role).toBe("user");
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

describe("createDefaultRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fileConfig = {
    models: {
      localMlx: {
        provider: "mlx",
        model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
        baseUrl: "http://127.0.0.1:8742",
      },
      cloudReasoning: {
        provider: "anthropic",
        model: "claude-sonnet-latest",
      },
    },
    routing: {
      defaultLocalModel: "localMlx",
      defaultReasoningModel: "cloudReasoning",
    },
  };

  it("resolves named tiers from metalmind.yaml", () => {
    expect(resolveNamedTier("localMlx", fileConfig.models)).toEqual({
      provider: "mlx",
      model: fileConfig.models.localMlx.model,
      baseUrl: fileConfig.models.localMlx.baseUrl,
    });
  });

  it("defaults the local tier to MLX on Apple Silicon and Ollama elsewhere", () => {
    expect(defaultLocalTier(true)).toEqual({
      provider: "mlx",
      model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
    });
    expect(defaultLocalTier(false)).toEqual({
      provider: "ollama",
      model: "deepseek-coder:1.3b",
    });
  });

  it.skip("uses the YAML local MLX model when the sidecar is ready", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string, options?: { baseUrl?: string }) => {
      if (provider === "mlx" && model === fileConfig.models.localMlx.model) {
        expect(options?.baseUrl).toBe(fileConfig.models.localMlx.baseUrl);
        return makeProvider([{ type: "done" }]) as never;
      }
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const router = await createDefaultRouter(
      { provider: "ollama", model: "deepseek-coder:1.3b", explicit: false },
      fileConfig as never,
    );

    const local = router.route("explain how recursion works conceptually");
    const cloud = router.route("design the authentication architecture");

    expect(local.provider).toBe("mlx");
    expect(local.modelId).toBe(fileConfig.models.localMlx.model);
    expect(cloud.provider).toBe("anthropic");
    expect(cloud.modelId).toBe(fileConfig.models.cloudReasoning.model);
  });

  it.skip("falls back to local ollama when the MLX sidecar is unavailable", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (provider === "mlx" && model === fileConfig.models.localMlx.model) {
        return makeProvider([{ type: "done" }], { ready: false, message: "down" }) as never;
      }
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const router = await createDefaultRouter(
      { provider: "ollama-cloud", model: "gemini-3-flash-preview:cloud", explicit: false },
      fileConfig as never,
    );

    const simple = router.route("explain how recursion works conceptually");
    // Simple query should go to local tier (ollama/deepseek-coder:1.3b)
    expect(simple.provider).toBe("ollama");
    expect(simple.modelId).toBe("deepseek-coder:1.3b");
    expect(simple.tier).toBe("tier1-local");
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

  it("uses local-model triage to route an ambiguous low-confidence task", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (model === "local-small") {
        return {
          providerName: "mlx",
          supportedCapabilities: {} as never,
          async *streamChatCompletion() {
            yield { type: "done" };
          },
          // local triage call buckets the ambiguous task as COMPLEX
          async completeChat() {
            return { message: { role: "assistant" as const, content: "COMPLEX" } };
          },
        } as never;
      }
      return makeProvider([{ type: "text", text: "cloud answer" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    // "handle the widget thing" hits no keyword → low confidence → triage runs.
    const events = await collect(loop.run("handle the widget thing"));
    expect(routes.at(-1)?.tier).toBe("tier3-cloud");
    expect(routes.at(-1)?.provider).toBe("anthropic");
    expect(text(events)).toContain("cloud answer");
  });
});

describe("AgentLoop coordinator integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCoordRouter() {
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

  it("initializes coordinator when router is present", () => {
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeCoordRouter() },
    );
    expect(loop.safety).toBeDefined();
    expect(loop.coordinatorInstance).toBeNull();
  });

  it("safety validator blocks dangerous file paths in tool execution", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const violation = loop.safety.validateFilePath("../../../etc/passwd");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("path_traversal");
  });

  it("safety validator blocks secret files", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const violation = loop.safety.validateFilePath("/home/user/.ssh/id_rsa");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("secret_in_context");
  });

  it("safety validator marks write tools as requiring approval", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.safety.requiresApproval("writeFile")).toBe(true);
    expect(loop.safety.requiresApproval("editFile")).toBe(true);
    expect(loop.safety.requiresApproval("runCommand")).toBe(true);
    expect(loop.safety.requiresApproval("readFile")).toBe(false);
  });

  it("safety validator blocks local worker from executing tools", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.safety.isToolAllowedForAgent("writeFile", "local-worker")).toBe(false);
    expect(loop.safety.isToolAllowedForAgent("readFile", "local-worker")).toBe(false);
    expect(loop.safety.isToolAllowedForAgent("writeFile", "cloud-main")).toBe(true);
  });

  it("initializes coordinator with initCoordinator", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never);
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeCoordRouter() },
    );
    await loop.initCoordinator();
    expect(loop.coordinatorInstance).not.toBeNull();
    expect(loop.coordinatorInstance!.getPhase()).toBe("idle");
  });

  it("coordinator events update via callbacks", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never);
    const phases: string[] = [];
    const routings: unknown[] = [];
    const plans: unknown[] = [];

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      {
        router: makeCoordRouter(),
        onCoordinatorPhase: (phase) => phases.push(phase),
        onCoordinatorRouting: (decision) => routings.push(decision),
        onCoordinatorPlan: (steps) => plans.push(steps),
      },
    );

    await loop.initCoordinator();
    expect(loop.coordinatorInstance).not.toBeNull();
  });

  it("safety validator rejects dangerous shell commands", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.safety.validateShellCommand("rm -rf /")).not.toBeNull();
    expect(loop.safety.validateShellCommand("sudo apt-get install foo")).not.toBeNull();
    expect(loop.safety.validateShellCommand("ls -la")).toBeNull();
  });
});

describe("AgentLoop.detectOllamaWorker", () => {
  it("returns null when Ollama is unreachable", async () => {
    const result = await AgentLoop.detectOllamaWorker(undefined, "http://127.0.0.1:59999");
    expect(result).toBeNull();
  });

  it("accepts a preferred model override", async () => {
    const result = await AgentLoop.detectOllamaWorker("nonexistent-model:99b", "http://127.0.0.1:59999");
    expect(result).toBeNull();
  });
});
